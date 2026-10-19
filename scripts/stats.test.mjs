import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function exporter(fetch) {
  const window={SrvproWeb:{getLanguage:()=> 'zh'}};
  runInNewContext(readFileSync('web-source/stats-export.js','utf8'),{window,fetch,URLSearchParams});
  return window.SrvproStatsExport;
}

test('CSV preserves Unicode, quotes and newlines while neutralizing text formulas',()=>{
  const csv=exporter().csv([['名称','数值'],['=1+1','逗号,引号"\n换行'],['普通名称',-2]]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"逗号,引号""\n换行"'));
  assert.ok(csv.includes('"-2"'));
});

test('matrix export keeps the full opponent denominator and leaves zero-sample rates blank',()=>{
  const api=exporter();
  const rows=api.matrixRows({monthKey:'202609',decks:[{id:'a',name:{zh:'A'}}],stats:{'a::a':{matches:2,matchWins:1},'a::all':{matches:7,matchWins:4}}},'zh');
  assert.equal(rows.length,25);
  assert.equal(rows[13][5],4);
  assert.equal(rows[13][6],7);
  assert.equal(rows[2][7],'');
  assert.ok(rows.every(row=>!row.includes('NaN')));
});

test('usage export completes every category page with at most one request in flight',async()=>{
  let active=0,peak=0,calls=0;
  const api=exporter(async input=>{
    active++;peak=Math.max(peak,active);calls++;
    const query=new URL(input,'https://fixture.invalid').searchParams;
    await new Promise(done=>setImmediate(done));active--;
    const metric=query.get('metric'),page=Number(query.get('page'));
    const common={period:'month',month:'202609',coverage:{allDecks:8,validCardDecks:7}};
    return {ok:true,json:async()=>metric==='deck'?{...common,decks:[{rank:1,names:{zh:'A'},count:8,usageRate:1}]}:
      {...common,total:2,pageSize:1,cards:[{rank:page,cardId:page,name:metric,deckCount:4,usageRate:4/7,copies1:1,copies2:1,copies3:2}]}};
  });
  const rows=await api.usageRows({period:'month',month:'202609'},'zh');
  assert.equal(calls,11);assert.equal(peak,1);assert.equal(rows.length,12);
  assert.equal(new Set(rows.slice(1).map(row=>row[2])).size,6);
});

test('usage export refuses responses from a different selected month',async()=>{
  const api=exporter(async()=>({ok:true,json:async()=>({period:'month',month:'202608',cards:[],total:0})}));
  await assert.rejects(api.usageRows({period:'month',month:'202609'},'zh'));
});
