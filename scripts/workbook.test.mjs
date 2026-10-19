import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ExcelJS from 'exceljs';

function workbookApi(){
  assert.ok(existsSync('web-source/stats-workbook.js'),'XLSX workbook builder must exist');
  const window={ExcelJS,SrvproWeb:{getLanguage:()=> 'zh'}};
  const context={window,URLSearchParams};
  runInNewContext(readFileSync('web-source/stats-export.js','utf8'),context);
  runInNewContext(readFileSync('web-source/stats-workbook.js','utf8'),context);
  return window.SrvproWorkbook;
}
const stats={matches:7,matchWins:4,firstMatches:2,firstWins:1,secondMatches:5,secondWins:3};

test('XLSX matrix keeps all 12 sheets, authoritative denominators, numbers and literal names',async()=>{
  const api=workbookApi();
  for(const lang of ['zh','ja','en','ko']){
    const wb=await new ExcelJS.Workbook().xlsx.load(Buffer.from(await api.bytes('matrix',{
      monthKey:'202610',decks:[{id:'a',name:{zh:'=1+1 & 测试'}}],stats:{'a::a':{matches:2,matchWins:1},'a::all':stats}
    },lang)));
    assert.equal(wb.worksheets.length,12);
    const sheet=wb.worksheets[0];
    assert.equal(sheet.getCell('A5').value,'=1+1 & 测试');
    assert.equal(sheet.getCell('A5').type,ExcelJS.ValueType.String);
    assert.equal(sheet.getCell('E5').value,4/7);
    assert.equal(sheet.getCell('F5').value,4);assert.equal(sheet.getCell('G5').value,7);
    assert.equal(sheet.getCell('E5').numFmt,'0.00%');
    assert.equal(wb.worksheets[3].getCell('B5').value,null);
    assert.equal(sheet.views[0].state,'frozen');
    assert.equal(new Set(wb.worksheets.map(s=>s.name)).size,12);
    assert.ok(wb.worksheets.every(s=>s.name.length<=31));
  }
});

test('detail XLSX has four groups and excludes top players while keeping usage and zero samples',async()=>{
  const data={period:'month',month:'202610',selected:{names:{zh:'测试卡组'}},usage:{count:21,usageRate:.25},overall:stats,
    opponents:[{names:{zh:'对手'},values:{matches:4,matchWins:1}}],topPlayers:[{name:'SECRET_PLAYER'}]};
  const wb=await new ExcelJS.Workbook().xlsx.load(Buffer.from(await workbookApi().bytes('detail',data,'zh')));
  assert.equal(wb.worksheets.length,4);
  assert.equal(wb.worksheets[0].getCell('B6').value,.25);
  assert.equal(wb.worksheets[0].getCell('B6').font.color.argb,'FFEF837F');
  assert.equal(wb.worksheets[0].getCell('F2').value,21);
  assert.equal(wb.worksheets[0].getCell('H2').value,.25);
  assert.ok(!JSON.stringify(wb.model).includes('SECRET_PLAYER'));
});

test('player XLSX includes overall and every own deck in four sheets without inventing samples',async()=>{
  const data={scope:'all',month:null,overall:stats,opponents:[],decks:[{names:{zh:'卡组A'},overall:stats,opponents:[{names:{zh:'卡组B'},values:{matches:1,matchWins:1}}]}]};
  const wb=await new ExcelJS.Workbook().xlsx.load(Buffer.from(await workbookApi().bytes('player',data,'zh')));
  assert.equal(wb.worksheets.length,4);
  assert.equal(wb.worksheets[0].getCell('A6').value,'卡组A');
  assert.equal(wb.worksheets[0].getCell('B7').value,'卡组B');
  assert.equal(wb.worksheets[0].getCell('C7').value,1);
  assert.equal(wb.worksheets[1].getCell('C5').value,null);
});

test('usage XLSX splits six categories and writes rates and card IDs as numbers',async()=>{
  const rows=[Array(12).fill('header'),...['monster','spell','trap','extra','side','deck'].map((metric,i)=>['month','202610',metric,1,i===5?'':12345678,'名字',3,12,'25.0000%',1,1,1])];
  const wb=await new ExcelJS.Workbook().xlsx.load(Buffer.from(await workbookApi().bytes('usage',{rows},'zh')));
  assert.equal(wb.worksheets.length,6);
  assert.equal(wb.worksheets[0].getCell('B5').value,12345678);
  assert.equal(wb.worksheets[0].getCell('F5').value,.25);
  assert.equal(wb.worksheets[0].getCell('F5').numFmt,'0.00%');
  assert.equal(wb.worksheets[5].getCell('C5').value,3);
});
