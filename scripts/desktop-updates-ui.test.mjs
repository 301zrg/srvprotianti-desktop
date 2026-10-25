import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const url='https://github.com/301zrg/srvprotianti-desktop/releases/download/v0.2.1/srvprotianti-desktop-windows-x64.zip';
const current={currentVersion:'0.2.0',latestVersion:'0.2.1',updateAvailable:true,downloadUrl:url,status:'fresh',checkedAt:1792954000};
function fixture(language='zh',check=async()=>current){
  const nodes=new Map(),events=new Map(),downloads=[];
  for(const id of ['desktop-update','desktopUpdateTitle','desktopUpdateHelp','desktopUpdateVersion','desktopUpdateTime','checkDesktopUpdate','downloadDesktopUpdate','desktopUpdateStatus','desktopUpdateManual'])nodes.set(id,{textContent:'',disabled:false,hidden:false,addEventListener(type,cb){this[type]=cb;}});
  const document={readyState:'loading',getElementById:id=>nodes.get(id),addEventListener:(type,cb)=>events.set(type,cb)};
  const window={SrvproWeb:{getLanguage:()=>language},SrvproDesktop:{checkDesktopUpdate:check,openUpdateDownload:async value=>downloads.push(value)}};
  runInNewContext(readFileSync(new URL('../src/desktop-updates.js',import.meta.url),'utf8'),{window,document,Date});
  window.SrvproDesktopUpdates.mount();
  return {nodes,events,window,downloads};
}
test('fresh results show versions and download the checked version',async()=>{
  const f=fixture();await f.nodes.get('checkDesktopUpdate').click();
  assert.match(f.nodes.get('desktopUpdateVersion').textContent,/0\.2\.0.*0\.2\.1/);
  assert.match(f.nodes.get('desktopUpdateTime').textContent,/检查/);
  assert.equal(f.nodes.get('downloadDesktopUpdate').hidden,false);
  await f.nodes.get('downloadDesktopUpdate').click();assert.deepEqual(f.downloads,[url]);
});
test('stale results retain a timestamp and never claim already latest',async()=>{
  const f=fixture('zh',async()=>({...current,updateAvailable:false,status:'stale',error:'network',retryAt:1792955000}));
  await f.nodes.get('checkDesktopUpdate').click();
  assert.match(f.nodes.get('desktopUpdateStatus').textContent,/上次/);
  assert.ok(!f.nodes.get('desktopUpdateStatus').textContent.includes('不低于'));
  assert.match(f.nodes.get('desktopUpdateTime').textContent,/重试/);
});
test('failed checks preserve last good versions and always expose manual download without raw exceptions',async()=>{
  let failed=false;const f=fixture('zh',async()=>{if(failed)throw Error('private-account$secret');return current;});
  await f.nodes.get('checkDesktopUpdate').click();failed=true;await f.nodes.get('checkDesktopUpdate').click();
  assert.match(f.nodes.get('desktopUpdateVersion').textContent,/0\.2\.1/);
  assert.match(f.nodes.get('desktopUpdateStatus').textContent,/上次/);
  assert.ok(!f.nodes.get('desktopUpdateStatus').textContent.includes('secret'));
  assert.equal(f.nodes.get('desktopUpdateManual').href,'https://github.com/301zrg/srvprotianti-desktop/releases/latest');
  assert.equal(f.nodes.get('desktopUpdateManual').hidden,false);
});
test('all four languages show readable unavailable messages rather than a false latest result',async()=>{
  const messages=new Set();
  for(const language of ['zh','ja','en','ko']){
    const f=fixture(language,async()=>({currentVersion:'0.2.0',latestVersion:null,updateAvailable:false,downloadUrl:null,status:'unavailable',error:'invalid_manifest'}));
    await f.nodes.get('checkDesktopUpdate').click();messages.add(f.nodes.get('desktopUpdateStatus').textContent);
    assert.equal(f.nodes.get('checkDesktopUpdate').disabled,false);
    assert.equal(f.nodes.get('downloadDesktopUpdate').hidden,true);
    assert.ok(f.nodes.get('desktopUpdateManual').textContent.length>0);
  }
  assert.equal(messages.size,4);
});
test('legacy native responses and exceptions remain compatible',async()=>{
  const f=fixture('zh',async()=>({currentVersion:'0.2.0',latestVersion:'0.2.0',updateAvailable:false,downloadUrl:null}));
  await f.nodes.get('checkDesktopUpdate').click();assert.match(f.nodes.get('desktopUpdateStatus').textContent,/不低于/);
  const old=fixture('zh',async()=>{throw 'GitHub temporarily limited update checks';});
  await old.nodes.get('checkDesktopUpdate').click();assert.match(old.nodes.get('desktopUpdateStatus').textContent,/限制/);
});
test('a pending check cannot create concurrent requests',async()=>{
  let resolve,calls=0;const f=fixture('zh',()=>{calls++;return new Promise(done=>resolve=done);});
  const pending=f.nodes.get('checkDesktopUpdate').click();await f.nodes.get('checkDesktopUpdate').click();
  assert.equal(calls,1);resolve(current);await pending;assert.equal(f.nodes.get('checkDesktopUpdate').disabled,false);
});
