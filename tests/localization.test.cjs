'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const app=path.resolve(__dirname,'../app');
const packs=fs.readdirSync(path.join(app,'languages')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(app,'languages',f),'utf8')));
const english=packs.find(p=>p.code==='en');
test('language packs cover all English keys and preserve formatting arguments',()=>{
  assert.ok(english);
  for(const pack of packs){
    assert.ok(pack.nativeName);assert.ok(pack.culture);
    assert.deepEqual(Object.keys(pack.strings).sort(),Object.keys(english.strings).sort(),pack.code);
    for(const [key,value] of Object.entries(pack.strings)){
      assert.equal(typeof value,'string');assert.ok(value.length,pack.code+':'+key);
      assert.equal(value.includes('\ufffd'),false);
      assert.deepEqual(value.match(/\{\d+\}/g)||[],english.strings[key].match(/\{\d+\}/g)||[],pack.code+':'+key);
    }
  }
});
test('all static and runtime translation references resolve',()=>{
  const source=fs.readFileSync(path.join(app,'TrackerApp.cs'),'utf8');
  for(const match of source.matchAll(/T\("([^"]+)"/g))assert.ok(english.strings[match[1]],match[1]);
  for(const file of ['MainWindow.xaml','HudWindow.xaml']){
    const markup=fs.readFileSync(path.join(app,file),'utf8');
    for(const match of markup.matchAll(/Tag="([^"]+)"/g))for(const binding of match[1].split(';'))assert.ok(english.strings[binding.split(':')[1]],binding);
    assert.equal(/[\u2190-\u21ff\u2600-\u27bf\u{1f000}-\u{1faff}]/u.test(markup),false,'Use geometry, not Unicode icons');
  }
});
test('German and Danish use CS2 mode names and native Unicode characters',()=>{
  const german=packs.find(p=>p.code==='de'),danish=packs.find(p=>p.code==='da');
  assert.equal(german.strings.gameName,'Wettrüsten');
  // Verified against SFUI_GameModeGungameProgressive in installed CS2 resources.
  assert.equal(danish.strings.gameName,'Arms Race');
  for(const character of ['æ','ø','å','Å'])assert.ok(JSON.stringify(danish.strings).includes(character),character);
});
