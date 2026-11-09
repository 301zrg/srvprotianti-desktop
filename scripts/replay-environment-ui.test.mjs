// "Save and play" for site replays (plan 02 §4.2): the rule environment check runs
// before the game starts and every outcome is reported. Native commands are faked;
// run `npm run build:web` first (npm run check does). Usage: npm run test:replay-environment
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const require=createRequire(resolve(process.env.SRVPRO_CLIENT_ROOT||resolve(root,'../srvprotiantiweb'),'package.json'));
const {chromium,expect}=require('@playwright/test');
const publicRoot=resolve(root,'public');
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'), file=resolve(publicRoot,'.'+url.pathname);
  if(!file.startsWith(publicRoot)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const A='a'.repeat(40),B='b'.repeat(40);
const table={master:'c'.repeat(40),environments:[
  {id:'706-20260907',effectiveFromUnix:null,specials:{commit:A,tree706:A}},
  {id:'706-20261110',effectiveFromUnix:1794276001,specials:{commit:B,tree706:B}}]};
const NEW=1794276500, OLD=1791408384;

// fixture: {prompt, table: 'ok'|'none'|'error', start, installed, tree, update: 'ok'|'conflict'|'error'}
async function run(browser,fixture,interact){
  const context=await browser.newContext();
  await context.addInitScript(f=>{
    window.__calls=[];
    window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args={})=>{
      window.__calls.push({command,args});
      if(command==='get_settings')return {player:{launchName:'P'},server:{gameHost:'h',gamePort:7911,apiBaseUrl:'http://api.fixture'},game:{executable:'ygopro.exe'},ui:{language:'en',replayEnvironmentPrompt:f.prompt}};
      if(command==='plugin:event|listen')return 1;
      if(command==='save_and_open')return {filename:args.filename,savedPath:'fixture/'+args.filename,launchError:null,replayStart:f.start,launched:args.launch!==false};
      if(command==='script_environments'){if(f.table==='error')throw 'SCRIPT_NETWORK: offline';return f.table==='none'?null:f.envs;}
      if(command==='script_state')return {commit:'x',canRestore:false,updatedAt:null,tree:f.tree,environmentChoice:null,installedEnvironment:f.installed};
      if(command==='update_scripts'){if(f.update==='error')throw 'Close this game executable before applying or restoring scripts';return {status:f.update==='conflict'?'conflict':'updated',files:f.update==='conflict'?['c1.lua']:[]};}
      if(command==='save_settings')return args.settings;
      if(command==='open_saved')return null;
      if(command==='api_request'){
        const value={replays:[{name:'fixture.yrp',size:10,players:[{id:'Fixture',deckbuffer:'AQAAAAAAAAABAAAA'}],duelCount:1}],total:1};
        return {status:200,contentType:'application/json',bodyBase64:btoa(JSON.stringify(value))};
      }
      return null;
    }};
  },{envs:table,...fixture});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/replays.html?L=en');
  await page.locator('a[download]').first().click();
  await expect.poll(()=>page.evaluate(()=>window.__calls.some(c=>c.command==='save_and_open'))).toBe(true);
  if(interact)await interact(page);
  // Let the flow settle, then read what happened.
  await page.waitForTimeout(800);
  const calls=await page.evaluate(()=>window.__calls);
  const toast=await page.locator('#desktop-toast').textContent().catch(()=>'');
  await context.close();
  assert.deepEqual(errors,[]);
  const save=calls.find(c=>c.command==='save_and_open');
  assert.equal(save.args.launch,false,'replays are saved without launching');
  return {calls,toast:toast||'',launched:calls.some(c=>c.command==='open_saved'),update:calls.find(c=>c.command==='update_scripts')};
}
const click=action=>async page=>{
  await expect(page.locator('#desktop-environment-prompt')).toBeVisible();
  await page.locator(`#desktop-environment-prompt button[data-action="${action}"]`).click();
};

let browser;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const base={prompt:true,table:'ok',start:NEW,installed:'706-20260907',tree:A,update:'ok'};
  // Prompt off, table missing, table unreadable, no start time, same version: play at once.
  for(const [name,f,expectToast] of [
    ['prompt off',{prompt:false},''],
    ['no table yet',{table:'none'},''],
    ['table unreadable',{table:'error'},'Could not read the rule version list'],
    ['no start time',{start:null},'no start time'],
    ['same version',{start:OLD},''],
  ]){
    const r=await run(browser,{...base,...f});
    assert.ok(r.launched,`${name}: launched`);
    assert.ok(!r.update,`${name}: nothing switched`);
    if(expectToast)assert.match(r.toast,new RegExp(expectToast),`${name}: told why`);
  }
  // Different version: switch then play.
  let r=await run(browser,base,click('switch'));
  assert.equal(r.update?.args.environmentId,'706-20261110');
  assert.ok(r.launched);
  assert.ok(r.calls.findIndex(c=>c.command==='update_scripts')<r.calls.findIndex(c=>c.command==='open_saved'),'switch before launch');
  // Play anyway: no switch.
  r=await run(browser,base,click('play'));
  assert.ok(r.launched&&!r.update);
  // Cancel: saved only, not started.
  r=await run(browser,base,click('cancel'));
  assert.ok(!r.launched&&!r.update);
  assert.match(r.toast,/Replay saved; the game was not started/);
  // "Don't ask again" stores the setting and still does what was chosen.
  r=await run(browser,base,async page=>{await expect(page.locator('#desktop-environment-prompt')).toBeVisible();await page.locator('#desktop-environment-prompt input[type=checkbox]').check();await page.locator('#desktop-environment-prompt button[data-action="play"]').click();});
  assert.equal(r.calls.find(c=>c.command==='save_settings')?.args.settings.ui.replayEnvironmentPrompt,false);
  assert.ok(r.launched);
  // A switch that fails or meets local edits never launches, and says so.
  r=await run(browser,{...base,update:'conflict'},click('switch'));
  assert.ok(!r.launched);assert.match(r.toast,/Local scripts were changed/);
  r=await run(browser,{...base,update:'error'},click('switch'));
  assert.ok(!r.launched);assert.match(r.toast,/Could not switch the rule version/);assert.match(r.toast,/Close this game/);
  // Installed by an older assistant (no recorded id): a unique 706 subtree match counts.
  r=await run(browser,{...base,installed:null,tree:B});
  assert.ok(r.launched&&!r.update,'unique tree match is treated as installed');
  r=await run(browser,{...base,installed:null,tree:'d'.repeat(40)},click('cancel'));
  assert.ok(!r.launched,'unknown installed version still asks');
  console.log('Save and play: prompt off/no table/unreadable/no time/same version play; switch/play/cancel/don\'t-ask; conflict and failed switch never launch; legacy tree match');
}finally{
  await browser?.close();server.close();
}
