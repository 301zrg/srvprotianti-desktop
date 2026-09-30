import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const web = { location: { search: '' } };
runInNewContext(readFileSync('web-source/site-shell.js', 'utf8'), {
  window: web,
  document: { addEventListener() {} },
  URLSearchParams
});
const css = readFileSync('dist/assets/common.css', 'utf8');

test('desktop rate classes retain the website gradient and readable values', () => {
  for (const rate of [0, 25, 50, 75, 100]) {
    const className = web.SrvproWeb.rateClass(rate);
    const expected = web.SrvproWeb.rateColor(rate);
    assert.equal(className, 'desktop-rate-' + rate);
    assert.ok(css.includes('.' + className + ' { color: ' + expected + '; }'));
  }
  assert.equal(web.SrvproWeb.rateClass(-100), 'desktop-rate-0');
  assert.equal(web.SrvproWeb.rateClass(200), 'desktop-rate-100');
  assert.equal(web.SrvproWeb.semanticClass(1), 'desktop-positive');
  assert.equal(web.SrvproWeb.semanticClass(-1), 'desktop-negative');
  assert.equal(web.SrvproWeb.semanticClass(0), 'desktop-rate-50');
});

test('all four statistics pages use stylesheet classes for variable colors', () => {
  for (const page of ['deck-stats', 'deck-detail', 'ladder', 'player-stats']) {
    const script = readFileSync('dist/assets/pages/' + page + '-1.js', 'utf8');
    assert.ok(script.includes('SrvproWeb.rateClass('), page + ' omits rate classes');
    assert.ok(!script.includes('style="color:'), page + ' still uses inline text colors');
  }
});

test('every extracted page script parses after the desktop rewrite', () => {
  for (const name of readdirSync('dist/assets/pages')) {
    if (!name.endsWith('.js')) continue;
    new Script(readFileSync('dist/assets/pages/' + name, 'utf8'), { filename: name });
  }
});
