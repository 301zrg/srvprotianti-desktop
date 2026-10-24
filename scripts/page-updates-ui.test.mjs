import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function fixture(language='zh',overrides={}) {
  const nodes=new Map(),events=new Map();
  for(const id of ['page-update','pageUpdateTitle','pageUpdateVersion','checkPageUpdate','recoverBuiltinPages','pageUpdateStatus']) {
    nodes.set(id,{textContent:'',disabled:false,addEventListener(type,callback){this[type]=callback;}});
  }
  let checks=0,restores=0;
  const bridge={
    pageUpdateStatus:async()=>({status:'current',currentVersion:'builtin',pendingVersion:null}),
    checkPageUpdate:async()=>{checks++;return {status:'staged',currentVersion:'builtin',pendingVersion:'1.0.0'};},
    recoverBuiltinPages:async()=>{restores++;return {status:'recovered',currentVersion:'1.0.0'};},...overrides
  };
  const document={readyState:'loading',getElementById:id=>nodes.get(id),addEventListener:(type,callback)=>events.set(type,callback)};
  const window={SrvproWeb:{getLanguage:()=>language},SrvproDesktop:bridge};
  runInNewContext(readFileSync(new URL('../web-source/page-updates.js',import.meta.url),'utf8'),{window,document});
  return {nodes,events,window,mount:()=>window.SrvproPageUpdates.mount(),counts:()=>({checks,restores})};
}

test('settings shows page version and stages changes for next launch without reloading',async()=>{
  const f=fixture();await f.mount();
  assert.match(f.nodes.get('pageUpdateVersion').textContent,/当前页面版本.*内置/);
  await f.nodes.get('checkPageUpdate').click();
  assert.equal(f.counts().checks,1);
  assert.equal(f.nodes.get('pageUpdateStatus').textContent,'新版页面已下载，将在下次启动时应用。');
  assert.equal(f.nodes.get('checkPageUpdate').disabled,false);
  await f.nodes.get('recoverBuiltinPages').click();
  assert.equal(f.counts().restores,1);
  assert.equal(f.nodes.get('pageUpdateStatus').textContent,'下次启动使用内置页面');
});

test('network/native failures never expose exception bodies and leave controls usable',async()=>{
  const f=fixture('zh',{checkPageUpdate:async()=>{throw Error('private-account$secret');}});
  await f.mount();await f.nodes.get('checkPageUpdate').click();
  assert.equal(f.nodes.get('pageUpdateStatus').textContent,'页面更新暂不可用，继续使用当前版本。');
  assert.equal(f.nodes.get('checkPageUpdate').disabled,false);
  assert.ok(!f.nodes.get('pageUpdateStatus').textContent.includes('secret'));
});

test('all supported languages have readable update controls and native progress updates',async()=>{
  for(const language of ['zh','ja','en','ko']) {
    const f=fixture(language);await f.mount();
    assert.ok(f.nodes.get('pageUpdateTitle').textContent.length>0);
    assert.ok(f.nodes.get('checkPageUpdate').textContent.length>0);
    f.events.get('srvpro-page-update')({detail:{status:'rejected',currentVersion:'1.0.0',error:'secret'}});
    assert.ok(f.nodes.get('pageUpdateStatus').textContent.length>0);
    assert.ok(!f.nodes.get('pageUpdateStatus').textContent.includes('secret'));
  }
});
