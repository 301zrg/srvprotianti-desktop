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
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext(),errors=[];
  await context.addInitScript(()=>{
    window.__nativeCalls=[];window.__popups=0;window.__roomGone=false;
    window.open=()=>{window.__popups++;return null;};
    const rooms=[
      {roomid:1,roomname:'TT,RANDOM#1',roomtype:'ladder_match',roommode:1,istart:'wait',needpass:'false',users:[]},
      {roomid:2,roomname:'M#TT,RANDOM#2',roomtype:'match_room',roommode:1,istart:'wait',needpass:'false',users:[]},
      {roomid:3,roomname:'Playing',roomtype:'match_room',roommode:1,istart:'Duel:1 Turn:2',needpass:'false',users:[]},
      {roomid:4,roomname:'Locked',roomtype:'match_room',roommode:1,istart:'Duel:1 Siding',needpass:'true',users:[]}
    ];
    const summary={rank:1,points:1000,wins:1,losses:0,diff:1,winRate:1,decks:[]};
    window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args={})=>{
      window.__nativeCalls.push({command,args});
      if(command==='get_settings')return {player:{launchName:'Native$secret'},server:{gameHost:'fixture-host',gamePort:7911,apiBaseUrl:'http://api.fixture'},game:{executable:'ygopro.exe'},ui:{language:localStorage.getItem('fixture.nativeLanguage')||'zh'}};
      if(command==='plugin:event|listen')return 1;
      if(command==='save_and_open')return {filename:args.filename,savedPath:'fixture/'+args.filename,launchError:null};
      if(command==='api_request'){
        const url=new URL(args.route,'http://api.fixture');let value={groups:[],decks:[],cards:[],replays:[],total:0,coverage:{},rating:{}};
        if(url.pathname==='/api/public/rooms')value={rooms:window.__roomGone?[]:rooms};
        if(url.pathname==='/api/ladder')value={ladder:[],total:0,rankingBasis:'points'};
        if(url.pathname==='/api/ladder/player') {const q=JSON.parse(args.body);value={found:true,authenticated:q.password==='secret',player:q.player,month:q.month,summary:{month:summary,total:summary},chart:[],matches:[{matchId:12,opponent:'Opponent',playerDeckAvailable:true,opponentDeckAvailable:false,won:true,score:'2-1',settledAt:'2026-10-23T00:00:00Z'}],total:1,pageSize:10};}
        if(url.pathname==='/api/ladder/player/deck')return {status:200,contentType:'text/plain',bodyBase64:btoa('#main\n1\n#extra\n!side\n')};
        if(url.pathname==='/api/example-decks')value={groups:[{name:{zh:'Fixture'},decks:[{file:'fixture.ydk',name:{zh:'Fixture deck'}}]}]};
        if(url.pathname==='/api/public/replays')value={replays:[{name:'fixture.yrp',size:10,players:[{id:'Fixture',deckbuffer:'AQAAAAAAAAABAAAA'}],duelCount:1}],total:1};
        return {status:200,contentType:'application/json',bodyBase64:btoa(unescape(encodeURIComponent(JSON.stringify(value))))};
      }
      return null;
    }};
    localStorage.setItem('srvpro.website.account.v1',JSON.stringify({username:'WrongWebsite',password:'wrong',rememberPassword:true}));
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  for(const lang of ['zh','ja','en','ko'])for(const name of ['intro','rooms','replays','ladder','deck-stats','player-stats','usage-stats','deck-detail']){
    await page.goto(base+'/'+name+'.html?L='+lang);
    await expect(page.locator('.site-client-actions a')).toHaveCount(4);
    await expect(page.locator('[data-site-shell] nav a')).toHaveCount(8);
    assert.equal(await page.locator('.deck-web-open,.replay-web-open').count(),0);
    for(const [intent,kind] of [['ladder','ladder'],['home','regular'],['deck-editor','deck-editor'],['replay-list','replay-list']]){
      await page.locator('.site-client-actions [data-client-intent="'+intent+'"]').click();
      await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='launch_game').at(-1)?.args.kind)).toBe(kind);
    }
    assert.equal(await page.evaluate(()=>window.__popups),0);
    assert.equal(await page.evaluate(()=>window.__nativeCalls.some(c=>c.command==='open_external')),false);
  }
  await page.goto(base+'/rooms.html?L=en');
  await page.locator('tr[data-room-name="TT,RANDOM#1"] [data-client-intent="ladder"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='launch_game').at(-1)?.args.kind)).toBe('ladder');
  await page.locator('tr[data-room-name="M#TT,RANDOM#2"] [data-native-room-action="join"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='launch_game').at(-1)?.args)).toEqual({kind:'join',roomName:'M#TT,RANDOM#2'});
  await page.locator('tr[data-room-name="Playing"] [data-client-intent="spectate"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='launch_game').at(-1)?.args)).toEqual({kind:'watch',roomName:'Playing'});
  await page.locator('tr[data-room-name="Locked"] [data-client-intent="spectate"]').click();
  await page.locator('dialog input[type=password]').fill('roomFixture');await page.getByRole('button',{name:'Watch game',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='launch_game').at(-1)?.args)).toEqual({kind:'watch',roomName:'Locked$roomFixture'});
  assert.equal(page.url().includes('roomFixture'),false);
  await page.evaluate(()=>{window.__roomGone=true;window.__nativeCalls.length=0;});await page.locator('tr[data-room-name="Playing"] [data-client-intent="spectate"]').click();
  await expect(page.locator('#desktop-toast')).toContainText('closed or changed');assert.equal(await page.evaluate(()=>window.__nativeCalls.some(c=>c.command==='launch_game')),false);
  await page.goto(base+'/player-stats.html?L=en&month=202609');await page.locator('[data-query-self]').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='api_request'&&c.args.route==='/api/ladder/player').map(c=>JSON.parse(c.args.body)).at(-1))).toMatchObject({player:'Native',password:'secret',month:'202609'});
  await page.locator('[data-download]').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='save_and_open').at(-1)?.args.bytesBase64)).toBe(Buffer.from('#main\n1\n#extra\n!side\n').toString('base64'));
  assert.equal(page.url().includes('secret'),false);await page.reload();
  await page.goto(base+'/player-stats.html?L=en&self=1&month=202609');
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='api_request'&&c.args.route==='/api/ladder/player').map(c=>JSON.parse(c.args.body)).at(-1)?.password)).toBe('secret');assert.equal(new URL(page.url()).searchParams.has('self'),false);
  await page.goto(base+'/ladder.html?L=en&month=202609&type=total');await page.locator('[data-query-self]').click();await expect(page.locator('#searchInput')).toHaveValue('Native');
  await page.locator('.lbtn-main').click();await page.getByRole('button',{name:'日本語',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='set_language').at(-1)?.args.language)).toBe('ja');
  await page.locator('[data-site-settings]').click();await expect(page).toHaveURL(/\/settings.html\?L=ja/);assert.equal(await page.locator('.site-settings-dialog').count(),0);
  await page.goto(base+'/intro.html?L=en');await page.locator('a[download]').first().click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.some(c=>c.command==='save_and_open'&&c.args.kind==='deck'))).toBe(true);
  await page.evaluate(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['#main\n1']));a.download='fixture.ydk';a.click();});
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.some(c=>c.command==='save_and_open'&&c.args.bytesBase64))).toBe(true);
  await page.goto(base+'/replays.html?L=en');await page.locator('a[download]').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.some(c=>c.command==='save_and_open'&&c.args.kind==='replay'))).toBe(true);
  await page.locator('.deck-action-cell button').click();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.some(c=>c.command==='save_and_open'&&c.args.kind==='deck'&&c.args.bytesBase64))).toBe(true);
  await page.evaluate(()=>{localStorage.setItem('fixture.nativeLanguage','ja');localStorage.removeItem('srvprotianti.language');});
  await page.goto(base+'/player-stats.html?self=1&month=202609');
  await expect(page).toHaveURL(/L=ja/);
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='api_request'&&c.args.route==='/api/ladder/player').map(c=>JSON.parse(c.args.body)).at(-1)?.password)).toBe('secret');
  for(const lang of ['zh','ja','en','ko'])for(const width of [320,390,844]) {
    await page.setViewportSize({width,height:width===844?390:844});await page.goto(base+'/rooms.html?L='+lang);
    const boxes=await page.locator('.site-client-actions a').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right};}));
    if(width<=640){assert.equal(boxes[0].y,boxes[1].y);assert.equal(boxes[2].y,boxes[3].y);assert.ok(boxes[2].y>boxes[0].y);}
    assert.ok(boxes.every(box=>box.x>=0&&box.right<=width));
  }
  assert.deepEqual(errors,[]);console.log('PASS: native bridge fixture, four languages x eight pages, room safety, native self identity, downloads and language/settings');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
