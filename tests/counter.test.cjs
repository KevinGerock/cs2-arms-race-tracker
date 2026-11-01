'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Counter, createServer, isArmsRace } = require('../counter.cjs');
const { ConnectionLog, connectionFromLine } = require('../connection-log.cjs');
const steamid = '76561198000000000';
let timestamp = 1700000000;
const fresh = options => new Counter({steamid,directory:fs.mkdtempSync(path.join(os.tmpdir(),'armsrace-test-')),...options});
function packet(phase='live',mvps=0,changes={}){
  return {provider:{appid:730,steamid,timestamp:++timestamp},map:{name:'ar_baggage',mode:'gungameprogressive',phase},player:{steamid,activity:'playing',match_stats:{kills:33,deaths:24,mvps}},...changes};
}
test('counts own win once, including repeated gameover packets and receiver restart',()=>{
  const c=fresh(); c.process(packet()); assert.equal(c.process(packet('gameover',1)).total,1);
  assert.equal(c.process(packet('gameover',1)).total,1);
  const restarted=new Counter({steamid,directory:c.directory}); assert.equal(restarted.process(packet('gameover',1)).total,1);
  restarted.process(packet()); assert.equal(restarted.process(packet('gameover',1)).total,2);
});
test('does not count a loss, team win, old MVPs or startup at gameover',()=>{
  const c=fresh(); assert.equal(c.process(packet('gameover',1)).total,0);
  c.process(packet()); assert.equal(c.process(packet('gameover',0,{round:{win_team:'CT'}})).total,0);
  c.process(packet('live',1)); assert.equal(c.process(packet('gameover',1)).total,0);
});
test('rejects another account, spectated player, other modes and stale packets',()=>{
  const c=fresh(); const live=packet(); c.process(live);
  assert.equal(c.process(packet('gameover',1,{player:{steamid:'other',activity:'playing',match_stats:{mvps:1}}})).ignored,'not_playing_as_local_player');
  assert.equal(c.process({...packet('gameover',1),provider:{...live.provider,timestamp:live.provider.timestamp-1}}).ignored,'out_of_order');
  assert.equal(c.process(packet('gameover',1,{map:{name:'de_dust2',mode:'competitive',phase:'gameover'}})).ignored,'not_armsrace');
  assert.equal(isArmsRace({name:'de_dust2',mode:'skirmish'}),false);
  assert.equal(isArmsRace({name:'ar_pool_day',mode:'skirmish'}),true);
});
test('handles personal MVP arriving on either side of gameover',()=>{
  const c=fresh(); c.process(packet()); c.process(packet('live',1)); assert.equal(c.process(packet('gameover',1)).total,1);
  c.process(packet()); c.process(packet('gameover',0)); assert.equal(c.process(packet('gameover',1)).total,2);
});
test('excludes practice wins; unknown connection does not increase total',()=>{
  const c=fresh({requireOnline:true}); const local={type:'local_practice',sequence:1};
  c.process(packet(),local); assert.equal(c.process(packet('gameover',1),local).total,0);
  assert.equal(c.summary().stats.practiceExcluded,1);
  const unknown={type:'unknown',sequence:2}; c.process(packet(),unknown); assert.equal(c.process(packet('gameover',1),unknown).total,0);
  assert.equal(c.status().pendingWin,true);
});
test('local exclusion remains attached to the match if its log becomes unavailable',()=>{
  const c=fresh({requireOnline:true}); c.process(packet(),{type:'local_practice',sequence:1});
  assert.equal(c.process(packet('gameover',1),{type:'online',sequence:1}).total,0);
});
test('actual CS2-shaped connection lines distinguish loopback and remote',()=>{
  assert.equal(connectionFromLine("11/01 20:34:21 [Client] CL:  Connected to 'loopback:1'").type,'local_practice');
  assert.equal(connectionFromLine('11/01 20:34:20 [HostStateManager] HostStateRequest::Start(HSR_GAME): loop(levelload) id(2) desc(Loading (ar_pool_day))').type,'unknown');
  assert.equal(connectionFromLine('11/01 20:40:00 [HostStateManager] HostStateRequest::Start(HSR_GAME): loop(remoteconnect) id(3)').type,'online');
  assert.equal(connectionFromLine('11/01 20:40:00 [Client] Player: [HostStateManager] HostStateRequest::Start(HSR_GAME): loop(remoteconnect)'),null);
  const log=new ConnectionLog(null); log.feed('[HostStateManager] HostStateRequest::Start(HSR_GAME): loop(remote'); assert.equal(log.context.type,'unknown'); log.feed('connect)\n'); assert.equal(log.context.type,'online');
});
test('online server map rotations preserve online status and continue counting wins',()=>{
  const c=fresh({requireOnline:true}),log=new ConnectionLog(null);
  log.feed("11/01 21:10:15 [HostStateManager] HostStateRequest::Start(HSR_GAME):  loop(remoteconnect) id(4) addons() desc(Remote Connect (server))\n11/01 21:10:15 [Client] CL:  Connected to '=[A:1:2624537605:52227]'\n");
  c.process(packet(),log.context); c.process(packet('gameover',0),log.context);
  for(let match=0;match<3;match++){
    log.feed("11/01 21:13:42 [HostStateManager] HostStateRequest::Start(HSR_GAME):  loop(levelload) id(5) addons() desc(Server Changelevel)\n11/01 21:13:42 [Client] Disconnecting from server: changelevel\n11/01 21:13:42 [Client] CL:  CCreateGameClientJob creating client connection to 'HSR_GAME_REMOTE_CHANGELEVEL_RECONNECT'\n");
    assert.equal(log.context.type,'online');
    c.process(packet(),log.context); assert.equal(c.process(packet('gameover',1),log.context).total,match+1);
  }
  assert.equal(c.summary().stats.practiceExcluded,0);
});
test('map rotation never upgrades an unknown or local connection without remote evidence',()=>{
  const change="[HostStateManager] HostStateRequest::Start(HSR_GAME): loop(levelload) id(6) desc(Server Changelevel)\n";
  const log=new ConnectionLog(null);log.feed(change);assert.equal(log.context.type,'unknown');
  log.feed("[Client] CL: Connected to 'loopback:1'\n");log.feed(change);assert.equal(log.context.type,'local_practice');
  log.feed("[Client] CL: CCreateGameClientJob creating client connection to 'HSR_GAME_REMOTE_CHANGELEVEL_RECONNECT'\n");assert.equal(log.context.type,'online');
  log.feed('[Client] Disconnecting from server: NETWORK_DISCONNECT_DISCONNECT_BY_USER\n');assert.equal(log.context.type,'unknown');
  log.feed('[HostStateManager] HostStateRequest::Start(HSR_IDLE): loop(levelload) desc(Idle (levelload))\n');assert.equal(log.context.type,'unknown');
  assert.equal(connectionFromLine("[Client] Player: [Client] CL: CCreateGameClientJob creating client connection to 'HSR_GAME_REMOTE_CHANGELEVEL_RECONNECT'"),null);
});
test('online to local practice to online again excludes only the actual practice win',()=>{
  const c=fresh({requireOnline:true}), log=new ConnectionLog(null);
  log.feed('[HostStateManager] HostStateRequest::Start(HSR_GAME): loop(remoteconnect)\n');
  c.process(packet(),log.context);c.process(packet('gameover',1),log.context);
  log.feed("[HostStateManager] HostStateRequest::Start(HSR_GAME): loop(levelload) desc(Loading (ar_baggage))\n[Client] CL: Connected to 'loopback:1'\n");
  c.process(packet(),log.context);assert.equal(c.process(packet('gameover',1),log.context).total,1);
  log.feed("[HostStateManager] HostStateRequest::Start(HSR_GAME): loop(remoteconnect)\n[Client] Disconnecting from server: NETWORK_DISCONNECT_LOOPDEACTIVATE\n[Client] CL: Connected to '=[A:1:123:456]'\n");
  c.process(packet(),log.context);assert.equal(c.process(packet('gameover',1),log.context).total,2);
  assert.equal(c.summary().stats.practiceExcluded,1);
});
test('diagnostics do not persist the GSI authentication token',()=>{
  const c=fresh(); c.process(packet()); c.process(packet('gameover',1,{auth:{token:'test-private-token'}}));
  for(const file of fs.readdirSync(c.directory)) assert.equal(fs.readFileSync(path.join(c.directory,file),'utf8').includes('test-private-token'),false);
});
test('GUI summary preserves saved wins and practice history across restart',()=>{
  const c=fresh({requireOnline:true}); const online={type:'online',sequence:1}; c.process(packet(),online); c.process(packet('gameover',1),online);
  const local={type:'local_practice',sequence:2}; c.process(packet(),local); c.process(packet('gameover',1),local);
  const restored=new Counter({steamid,directory:c.directory}); const summary=restored.summary();
  assert.equal(summary.stats.wins,1); assert.equal(summary.stats.completedMatches,2); assert.equal(summary.stats.practiceExcluded,1); assert.equal(summary.history.length,2);
});
test('HTTP receiver validates auth and provides read-only summary without leaking token',async()=>{
  const c=fresh(); const {server}=createServer({steamid,token:'receiver-test-token',excludePractice:false},c.directory);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base='http://127.0.0.1:'+server.address().port;
  try{
    const post=body=>fetch(base+'/gsi',{method:'POST',body});
    assert.equal((await post('{')).status,400); assert.equal((await post(JSON.stringify(packet()))).status,403);
    for(const p of [packet(),packet('gameover',1)])assert.equal((await post(JSON.stringify({...p,auth:{token:'receiver-test-token'}}))).status,200);
    const summary=await(await fetch(base+'/summary')).json(); assert.equal(summary.stats.wins,1); assert.equal(summary.history[0].outcome,'win'); assert.equal(JSON.stringify(summary).includes('receiver-test-token'),false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
