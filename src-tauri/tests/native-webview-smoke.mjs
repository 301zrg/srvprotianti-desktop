// Connect only to a separately launched debug fixture with an isolated game root and WebView profile.
// Usage: node src-tauri/tests/native-webview-smoke.mjs <loopback-cdp-port> <expected-page-version> [recover|disable-js]
import assert from 'node:assert/strict';

const [port, expectedVersion, action] = process.argv.slice(2);
assert.match(port || '', /^\d{4,5}$/);
assert.ok(expectedVersion);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://tauri.localhost/'));
assert.ok(target, 'the native WebView must use the existing local Tauri origin');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error',reject,{once:true}); });
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const promise = pending.get(message.id);
  if (promise) { pending.delete(message.id); message.error ? promise.reject(new Error(JSON.stringify(message.error))) : promise.resolve(message.result); }
});
function call(method, params={}) {
  return new Promise((resolve,reject) => { const id=++sequence; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); });
}
const result = await call('Runtime.evaluate', {awaitPromise:true,returnByValue:true,expression:`(async()=>{
  const invoke=window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('Tauri IPC bootstrap is unavailable');
  const settings=await invoke('get_settings');
  const before=await invoke('page_update_status');
  const script=await fetch('/assets/desktop-bridge.js');
  const page=await fetch('/rooms.html');
  const blocked=await fetch('/config.json');
  let remoteBlocked=false;try{await fetch('https://example.invalid/');}catch{remoteBlocked=true;}
  await invoke('page_ready');
  const after=await invoke('page_update_status');
  const recovery=${action === 'recover'}?await invoke('recover_builtin_pages'):null;
  return {url:location.href,origin:location.origin,shell:!!document.querySelector('[data-site-shell] nav'),bridge:!!window.SrvproDesktop,
    language:settings.ui.language,api:settings.server.apiBaseUrl,before,after,recovery,
    pageStatus:page.status,csp:page.headers.get('content-security-policy'),scriptStatus:script.status,scriptType:script.headers.get('content-type'),blockedStatus:blocked.status,remoteBlocked,
    visibleProof:document.getElementById('local-page-update-proof')?.textContent??null,
    firstContentfulPaint:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null};
})()`});
if(action==='disable-js')await call('Emulation.setScriptExecutionDisabled',{value:true});
socket.close();
assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));
const value=result.result.value;
assert.equal(value.origin,'http://tauri.localhost');
assert.equal(value.before.currentVersion,expectedVersion);
assert.equal(value.after.currentVersion,expectedVersion);
assert.equal(value.shell,true);
assert.equal(value.bridge,true);
assert.equal(value.api,'http://127.0.0.1:9','smoke must use the isolated offline business API');
assert.equal(value.pageStatus,200);
assert.equal(value.scriptStatus,200);
assert.match(value.scriptType,/javascript/);
assert.equal(value.blockedStatus,404);
assert.equal(value.remoteBlocked,true,'the existing CSP must block arbitrary remote fetches');
if(action==='recover')assert.equal(value.recovery.status,'recovered');
if(action==='visible')assert.match(value.visibleProof,/0\.0\.3/);
console.log(JSON.stringify(value,null,2));
