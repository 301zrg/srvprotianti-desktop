import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

// Built-in pages and signed page packages are served with the same policy as the Tauri window.
test('the page runtime CSP matches tauri.conf.json', () => {
  const configured = JSON.parse(read('src-tauri/tauri.conf.json')).app.security.csp;
  const match = /const CSP\s*:\s*&str\s*=\s*"([^"]+)";/.exec(read('src-tauri/src/pages_runtime.rs'));
  assert.ok(match, 'pages_runtime.rs must declare const CSP');
  assert.equal(match[1], configured);
});
