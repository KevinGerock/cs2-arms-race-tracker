'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { ConnectionLog } = require('./connection-log.cjs');

function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flush: true });
  fs.renameSync(temporary, filename);
}

function isArmsRace(map) {
  if (!map || typeof map.name !== 'string') return false;
  const mode = String(map.mode || '').toLowerCase();
  if (['gungameprogressive', 'armsrace', 'arms_race'].includes(mode)) return true;
  // Official matchmaking can use the skirmish game type. Never treat
  // every skirmish (e.g. other War Games) as Arms Race.
  const name = map.name.toLowerCase().split('/').pop();
  return mode === 'skirmish' && ['ar_baggage', 'ar_shoots', 'ar_shoots_night', 'ar_pool_day'].includes(name);
}

class Counter {
  constructor({ steamid, directory, requireOnline = false }) {
    this.steamid = steamid;
    this.directory = directory;
    this.requireOnline = requireOnline;
    this.connectionContext = { type: 'unknown', signal: 'not_checked', sequence: 0 };
    this.filename = path.join(directory, 'state.json');
    this.lastReceived = null;
    this.lastTimestamp = null;
    this.lastSummary = null;
    this.lastSnapshot = 0;
    this.recent = [];
    this.lastTraceSnapshot = 0;
    this.endTraces = new Map();
    this.history = new Map();
    this.state = fs.existsSync(this.filename)
      ? JSON.parse(fs.readFileSync(this.filename, 'utf8').replace(/^\uFEFF/, ''))
      : { version: 1, steamid, session: null, wins: [], detectorValidation: 'awaiting_live_match' };
    if (this.state.steamid !== steamid || !Array.isArray(this.state.wins)) {
      throw new Error('Gespeicherte Daten gehoeren zu einem anderen Account oder sind ungueltig.');
    }
    if (fs.existsSync(directory)) {
      for (const filename of fs.readdirSync(directory).filter(name => /^result-[\w-]+\.json$/.test(name))) {
        try {
          const result = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
          this.rememberResult(filename.slice(7, -5), result);
        } catch (error) { console.error('Matchdatei konnte nicht gelesen werden:', filename, error.message); }
      }
    }
  }

  save() { atomicWrite(this.filename, this.state); }

  rememberResult(id, result) {
    const win = this.state.wins.find(item => item.id === id);
    const outcome = win ? 'win' : result.excludedReason === 'local_practice' ? 'practice' :
      result.candidateWin ? 'unverified' : !result.observedLive ? 'partial' : 'no_win';
    this.history.set(id, {
      id, map: result.payload?.map?.name || 'unknown',
      endedAt: win?.endedAt || new Date((result.payload?.provider?.timestamp || 0) * 1000).toISOString(),
      outcome, kills: result.payload?.player?.match_stats?.kills ?? null,
      deaths: result.payload?.player?.match_stats?.deaths ?? null,
      connectionType: result.connectionType || 'not_recorded',
      excludedReason: result.excludedReason || null
    });
  }

  summary() {
    const history = [...this.history.values()].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    const wins = [...this.state.wins].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    return {
      status: this.status(),
      stats: {
        wins: wins.length, completedMatches: history.length,
        practiceExcluded: history.filter(item => item.outcome === 'practice').length,
        noWin: history.filter(item => item.outcome === 'no_win').length,
        unverified: history.filter(item => item.outcome === 'unverified' || item.outcome === 'partial').length
      },
      lastWin: wins[0] || null,
      history: history.slice(0, 40)
    };
  }

  status() {
    return {
      service: 'armsrace-counter',
      steamid: this.steamid,
      winsSinceInstallation: this.state.wins.length,
      detectorValidation: this.state.detectorValidation,
      lastReceived: this.lastReceived,
      lastGameState: this.lastSummary,
      session: this.state.session,
      practiceFilterEnabled: this.requireOnline,
      practiceFilterVersion: 'remote-changelevel-v2',
      connection: this.connectionContext,
      pendingWin: !!(this.state.session?.candidateWin && !this.state.session?.counted && this.state.session?.connectionType === 'unknown'),
      note: this.state.detectorValidation === 'live_win_and_loss_confirmed'
        ? 'MVP-Erkennung an echtem Sieg und gemeldeter Niederlage bestaetigt. Nur erkannte Online-Verbindungen zaehlen; lokale Uebungsspiele sind ausgeschlossen.'
        : 'MVP-Erkennung fuer Arms Race; Live-Bestaetigung steht noch aus. Alte Siege sind nicht enthalten.'
    };
  }

  process(payload, connection = { type: 'unknown', sequence: 0 }) {
    if (payload?.provider?.appid !== 730 || payload.provider.steamid !== this.steamid) {
      return { ignored: 'wrong_provider' };
    }
    const timestamp = payload.provider.timestamp;
    if (!Number.isFinite(timestamp)) return { ignored: 'missing_timestamp' };
    if (this.lastTimestamp !== null && timestamp < this.lastTimestamp) return { ignored: 'out_of_order' };
    this.lastTimestamp = timestamp;
    this.connectionContext = connection;
    this.lastReceived = new Date().toISOString();
    const map = payload.map;
    const player = payload.player;
    this.lastSummary = {
      map: map?.name || null, mode: map?.mode || null, phase: map?.phase || null,
      playerSteamid: player?.steamid || null, activity: player?.activity || null,
      mvps: player?.match_stats?.mvps ?? null, roundPhase: payload.round?.phase || null
      , kills: player?.match_stats?.kills ?? null, deaths: player?.match_stats?.deaths ?? null
    };
    // Keep diagnostic snapshots local; never save the authentication token.
    const snapshot = { ...payload };
    delete snapshot.auth;
    if (Date.now() - this.lastTraceSnapshot >= 250 || map?.phase === 'gameover') {
      this.recent.push(snapshot);
      this.recent = this.recent.filter(item => timestamp - item.provider.timestamp <= 20).slice(-85);
      this.lastTraceSnapshot = Date.now();
    }
    if (Date.now() - this.lastSnapshot > 3000 || map?.phase === 'gameover') {
      atomicWrite(path.join(this.directory, 'last-payload.json'), snapshot);
      this.lastSnapshot = Date.now();
    }
    if (!isArmsRace(map)) {
      if (this.state.session) { this.state.session = null; this.save(); }
      return { ignored: 'not_armsrace' };
    }
    if (player?.steamid !== this.steamid || (player.activity && player.activity !== 'playing')) {
      return { ignored: 'not_playing_as_local_player' };
    }
    const mvps = player.match_stats?.mvps;
    if (!Number.isInteger(mvps) || mvps < 0) return { ignored: 'no_mvp_field' };
    const phase = String(map.phase || '').toLowerCase();
    if (!['live', 'warmup', 'gameover', 'intermission'].includes(phase)) return { ignored: 'unknown_phase' };
    const signature = `${map.mode}:${map.name}:${map.matchid || ''}`;
    let session = this.state.session;
    let changed = false;
    const needsNewSession = !session || session.signature !== signature ||
      (session.ended && ['live', 'warmup'].includes(phase)) ||
      (phase === 'live' && session.connectionSequence && connection.sequence && session.connectionSequence !== connection.sequence);
    if (needsNewSession) {
      // A positive MVP count seen only after startup at gameover is not a new win.
      session = this.state.session = {
        id: crypto.randomUUID(), signature, map: map.name,
        observedLive: phase === 'live', baselineMvps: mvps, maxMvps: mvps,
        counted: false, ended: phase === 'gameover', lastPhase: phase,
        startedAt: new Date(timestamp * 1000).toISOString()
      };
      changed = true;
    } else if (phase === 'live' && mvps < session.maxMvps) {
      // A server reset can start another match on the same map without a menu.
      session = this.state.session = {
        id: crypto.randomUUID(), signature, map: map.name,
        observedLive: true, baselineMvps: mvps, maxMvps: mvps,
        counted: false, ended: false, lastPhase: phase,
        startedAt: new Date(timestamp * 1000).toISOString()
      };
      changed = true;
    }
    if (phase === 'live' && !session.observedLive) {
      session.observedLive = true;
      session.baselineMvps = mvps;
      session.maxMvps = mvps;
      changed = true;
    }
    if (mvps > session.maxMvps) { session.maxMvps = mvps; changed = true; }
    if (session.connectionType !== connection.type || session.connectionSequence !== connection.sequence) {
      session.connectionType = connection.type;
      session.connectionSequence = connection.sequence;
      changed = true;
    }
    // A local-practice observation excludes the whole session, even if the
    // diagnostic log later becomes unavailable.
    if (connection.type === 'local_practice' && !session.excludedPractice) {
      session.excludedPractice = true;
      changed = true;
    }
    if (session.lastPhase !== phase) { session.lastPhase = phase; changed = true; }
    if (phase === 'gameover' && !session.ended) { session.ended = true; changed = true; }

    let win = null;
    const candidateWin = phase === 'gameover' && session.observedLive && session.maxMvps > session.baselineMvps;
    if (candidateWin && !session.candidateWin) { session.candidateWin = true; changed = true; }
    const eligible = !this.requireOnline || (connection.type === 'online' && !session.excludedPractice);
    if (candidateWin && !session.counted && eligible) {
      session.counted = true;
      win = {
        id: session.id, steamid: this.steamid, map: map.name,
        endedAt: new Date(timestamp * 1000).toISOString(),
        signal: 'armsrace_gameover_with_personal_mvp_increase',
        baselineMvps: session.baselineMvps, finalMvps: session.maxMvps,
        validation: this.state.detectorValidation,
        connectionType: connection.type
      };
      this.state.wins.push(win);
      atomicWrite(path.join(this.directory, `evidence-${session.id}.json`), snapshot);
      changed = true;
    }
    if (phase === 'gameover') {
      if (!this.endTraces.has(session.id)) {
        this.endTraces.clear();
        this.endTraces.set(session.id, [...this.recent]);
      }
      const result = {
        observedAt: this.lastReceived, counted: session.counted,
        baselineMvps: session.baselineMvps, finalMvps: session.maxMvps,
        observedLive: session.observedLive, payload: snapshot,
        candidateWin: !!session.candidateWin,
        connectionType: connection.type,
        excludedReason: session.excludedPractice ? 'local_practice' : (this.requireOnline && connection.type !== 'online' ? 'connection_not_verified' : null),
        recentAtGameover: this.endTraces.get(session.id)
      };
      atomicWrite(path.join(this.directory, 'last-result.json'), result);
      atomicWrite(path.join(this.directory, `result-${session.id}.json`), result);
      this.rememberResult(session.id, result);
    }
    if (changed) this.save();
    return { win, total: this.state.wins.length, changed };
  }
}

function createServer(settings, directory, onUpdate = () => {}) {
  const counter = new Counter({ steamid: settings.steamid, directory, requireOnline: settings.excludePractice !== false });
  const connectionLog = new ConnectionLog(settings.consoleLog);
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify(counter.status(), null, 2));
      return;
    }
    if (request.method === 'GET' && request.url === '/summary') {
      response.end(JSON.stringify(counter.summary())); return;
    }
    if (request.method !== 'POST' || request.url !== '/gsi') {
      response.writeHead(404).end('{"error":"not_found"}'); return;
    }
    let body = '';
    let oversized = false;
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        oversized = true;
        response.writeHead(413).end('{"error":"too_large"}');
        request.destroy();
      }
    });
    request.on('end', () => {
      if (oversized) return;
      let payload;
      try { payload = JSON.parse(body); }
      catch { response.writeHead(400).end('{"error":"invalid_json"}'); return; }
      if (payload?.auth?.token !== settings.token) {
        response.writeHead(403).end('{"error":"invalid_token"}'); return;
      }
      try {
        const result = counter.process(payload, connectionLog.read());
        response.end('{"ok":true}');
        onUpdate(result, counter.status());
      } catch (error) {
        console.error(new Date().toISOString(), error.message);
        response.writeHead(500).end('{"error":"cannot_save_state"}');
      }
    });
    request.on('error', error => console.error('Empfangsfehler:', error.message));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, counter };
}

if (require.main === module) {
  const settingsPath = path.join(__dirname, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    console.error('Bitte zuerst Setup.cmd starten.'); process.exitCode = 1;
  } else {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    const { server, counter } = createServer(settings, path.join(__dirname, 'data'), (result, status) => {
      if (result.win) console.log(`${new Date().toISOString()} AUTO-SIGNAL: Arms-Race-Sieg | Gesamt: ${result.total}`);
      else if (result.changed) console.log(`${new Date().toISOString()} ${JSON.stringify(status.lastGameState)}`);
    });
    server.on('error', error => {
      console.error('Zaehler konnte nicht starten:', error.message); process.exitCode = 1;
    });
    server.listen(settings.port, '127.0.0.1', () => {
      console.log(`Arms-Race-Autozaehler fuer ${settings.steamid}`);
      console.log(`Stand seit Installation: ${counter.state.wins.length}`);
      console.log(`Status: http://127.0.0.1:${settings.port}/status`);
      console.log('Warte auf CS2. Nach der Einrichtung muss CS2 neu gestartet werden.');
      console.log('Nur verifizierte Online-Verbindungen zaehlen. Lokale Uebungsspiele und unklare Verbindungen zaehlen nicht.');
    });
  }
}

module.exports = { Counter, createServer, isArmsRace };
