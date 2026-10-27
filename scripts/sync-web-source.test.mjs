import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

async function gitFixture(run) {
  const temporary=await mkdtemp(path.join(tmpdir(),'srvpro-source-provenance-'));
  const repository=path.join(temporary,'repo'),website=path.join(repository,'plugins/ladder-web/web');
  await mkdir(path.join(website,'assets'),{recursive:true});
  const names=['intro','rooms','replays','ladder','deck-stats','player-stats','usage-stats','deck-detail'];
  for(const name of names)await writeFile(path.join(website,name+'.html'),'<p>'+name+' fixture</p>\n');
  for(const name of ['common.css','stats-export.js','stats-workbook.js','exceljs-4.4.0.min.js','player-duel-stats.js','deck-card-usage.js','rating-rules.js','card-images.js'])await writeFile(path.join(website,'assets',name),'/* fixture */\n');
  await writeFile(path.join(website,'assets/site-shell.js'),"(function(global){\n  'use strict';\n  function rateColor() {}\n  function openSettings() {}\n  function renderShell() {\n    var settings = document.createElement('button');\n    settings.type = 'button'; settings.className = 'site-settings-button'; settings.textContent = entryText('settings'); settings.setAttribute('data-site-settings', '');\n    settings.addEventListener('click', openSettings); root.appendChild(settings);\n  }\n  global.SrvproWeb = Object.freeze({\n    rateColor: rateColor,\n  });\n})(window);\n");
  const git=(...args)=>execFileSync('git',['-c','core.autocrlf=false','-c','core.safecrlf=false','-c','commit.gpgsign=false','-c','user.name=Source Fixture','-c','user.email=source@example.invalid','-C',repository,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init','--template=');git('add','.');git('commit','-m','fixture');
    await run({temporary,repository,website,commit:git('rev-parse','HEAD'),git});
  }finally {
    assert.equal(path.dirname(path.resolve(temporary)),path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith('srvpro-source-provenance-'));
    await rm(temporary,{recursive:true,force:true});
  }
}

test('source sync is explicit, deterministic and records source file hashes', async () => {
  const api = await import('./sync-web-source.mjs');
  assert.equal(typeof api.syncWebsite, 'function');
  assert.throws(() => api.adaptPage('ladder', '<button onclick="secret()">bad</button>'), /inline/);
  const source=`<script>
function colored(value, color) { return '<span style="color:' + color + '">' + value + '</span>'; }
var value=colored('75%',SrvproWeb.rateColor(75));
</script>`;
  const generated=api.adaptPage('ladder',source);
  assert.ok(generated.includes('SrvproWeb.rateClass('));
  assert.ok(!generated.match(/<script>([\s\S]*?)<\/script>/)[1].includes('style="color:'));
  assert.equal(api.adaptPage('ladder',source),generated);
  new Script(generated.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('native source strips web-only import actions while preserving original file downloads',async()=>{
  const api=await import('./sync-web-source.mjs');
  const snippets={
    intro:"var openButton = document.createElement('button');openButton.textContent=SrvproDeckWeb.label('open');actions.appendChild(openButton);",
    replays:"const playButton = document.createElement('button');playButton.textContent=SrvproReplayWeb.label('open');replayActions.appendChild(playButton);",
    'player-stats':`function dlButton(){return '<a download>deck</a><button type="button" class="deck-web-open">'+SrvproDeckWeb.label('open')+'</button>';}function openPlayerDeck(button){SrvproDeckWeb.openAuthorized(button);}async function downloadDeck(){return 'native';}`,
    'deck-detail':`var markup='<span><a download>template</a><button type="button" class="deck-web-open" data-open-template="file">'+SrvproDeckWeb.label('openDeck')+'</button></span>';`
  };
  for(const page of Object.keys(snippets)){
    const source='<script src="/assets/web-client-config.js"></script><a download>file</a><script>'+snippets[page]+'</script>';
    const generated=api.adaptPage(page,source);
    assert.ok(!generated.includes('SrvproDeckWeb'),page);
    assert.ok(!generated.includes('SrvproReplayWeb'),page);
    assert.ok(!generated.includes('/assets/web-client-config.js'),page);
    assert.ok(generated.includes('download'),page+' keeps downloads');
    new Script(generated.match(/<script>([\s\S]*?)<\/script>/)[1]);
  }
});

test('desktop shell removes the duplicate settings button for the native navigation entry',async()=>{
  const {syncWebsite}=await import('./sync-web-source.mjs');
  await gitFixture(async({temporary,website,commit})=>{
    const outputRoot=path.join(temporary,'snapshot');
    await syncWebsite({websiteRoot:website,websiteCommit:commit,outputRoot});
    const shell=await readFile(path.join(outputRoot,'site-shell.js'),'utf8');
    assert.ok(!shell.includes('site-settings-button'));
    assert.ok(!shell.includes('data-site-settings'));
    assert.ok(shell.includes('global.SRVPRO_WEB_CLIENT_URL'));
  });
});

test('build rejects manual drift in the synchronized snapshot',async()=>{
  const {verifySynchronizedSource}=await import('./sync-web-source.mjs');
  const root=new URL('../web-source/',import.meta.url);
  const manifest=JSON.parse(readFileSync(new URL('source-manifest.json',root),'utf8'));
  await verifySynchronizedSource(fileURLToPath(root),manifest);
  const changed=structuredClone(manifest);changed.generatedFiles[0].sha256='0'.repeat(64);
  await assert.rejects(verifySynchronizedSource(fileURLToPath(root),changed),/Generated web-source changed/);
});

test('a claimed website commit rejects unknown commits and dirty feature differences before writing',async()=>{
  const {syncWebsite}=await import('./sync-web-source.mjs');
  await gitFixture(async({temporary,website,commit})=>{
    const outputRoot=path.join(temporary,'snapshot');
    await assert.rejects(syncWebsite({websiteRoot:website,websiteCommit:'f'.repeat(40),outputRoot}),/commit|Git/i);
    await writeFile(path.join(website,'intro.html'),'<p>Uncommitted feature</p>\n');
    await assert.rejects(syncWebsite({websiteRoot:website,websiteCommit:commit,outputRoot}),/differ|match|dirty/i);
    await assert.rejects(readFile(path.join(outputRoot,'source-manifest.json')),/ENOENT/);
  });
});

test('release sync canonicalizes CRLF working files to the declared Git blobs',async()=>{
  const {syncWebsite}=await import('./sync-web-source.mjs');
  await gitFixture(async({temporary,website,commit})=>{
    const outputRoot=path.join(temporary,'snapshot');
    const original=await readFile(path.join(website,'intro.html'));
    await writeFile(path.join(website,'intro.html'),original.toString().replaceAll('\n','\r\n'));
    const manifest=await syncWebsite({websiteRoot:website,websiteCommit:commit,outputRoot});
    const entry=manifest.sourceFiles.find(file=>file.path==='intro.html');
    assert.equal(entry.sha256,createHash('sha256').update(original).digest('hex'));
    assert.equal(entry.size,original.length);
    assert.equal(manifest.websiteBaseCommit,commit);
    assert.equal((await readFile(path.join(outputRoot,'intro.html'),'utf8')).includes('\r'),false);
  });
});

test('a different existing commit cannot stand in for the selected feature source',async()=>{
  const {syncWebsite}=await import('./sync-web-source.mjs');
  await gitFixture(async({temporary,website,commit,git})=>{
    await writeFile(path.join(website,'intro.html'),'<p>Committed feature B</p>\n');git('add','.');git('commit','-m','second fixture');
    const second=git('rev-parse','HEAD');
    await assert.rejects(syncWebsite({websiteRoot:website,websiteCommit:commit,outputRoot:path.join(temporary,'old-label')}),/differs from declared commit/);
    const result=await syncWebsite({websiteRoot:website,websiteCommit:second,outputRoot:path.join(temporary,'correct-label')});
    assert.equal(result.websiteCommit,second);
    git('rm','--cached','plugins/ladder-web/web/assets/rating-rules.js');git('commit','-m','missing source blob');
    await assert.rejects(syncWebsite({websiteRoot:website,websiteCommit:git('rev-parse','HEAD'),outputRoot:path.join(temporary,'missing-blob')}),/regular source blob/);
  });
});

test('draft sync permits exported files but release provenance requires their actual Git commit',async()=>{
  const {syncWebsite}=await import('./sync-web-source.mjs');
  await gitFixture(async({temporary,website,commit})=>{
    const exported=path.join(temporary,'export');await mkdir(path.join(exported,'assets'),{recursive:true});
    const draft=await syncWebsite({websiteRoot:website,outputRoot:path.join(temporary,'draft')});
    for(const file of draft.sourceFiles)await writeFile(path.join(exported,file.path),await readFile(path.join(website,file.path)));
    await syncWebsite({websiteRoot:exported,outputRoot:path.join(temporary,'export-draft')});
    await assert.rejects(syncWebsite({websiteRoot:exported,websiteCommit:commit,outputRoot:path.join(temporary,'export-release')}),/Git|repository/i);
  });
});

test('manifest validation rejects erased, malformed and duplicate source provenance',async()=>{
  const {verifySynchronizedSource}=await import('./sync-web-source.mjs');
  const directory=fileURLToPath(new URL('../web-source/',import.meta.url));
  const manifest=JSON.parse(readFileSync(path.join(directory,'source-manifest.json'),'utf8'));
  for(const change of [m=>{m.sourceFiles=[];},m=>{m.sourceFiles[0].size=-1;},m=>{m.sourceFiles[0].sha256='x';},m=>{m.sourceFiles[0]=m.sourceFiles[1];},m=>{m.websiteCommit={};},m=>{m.websiteBaseCommit=12;},m=>{m.unknown=true;}]) {
    const invalid=structuredClone(manifest);change(invalid);
    await assert.rejects(verifySynchronizedSource(directory,invalid),/manifest|source|provenance|commit/i);
  }
});

test('read-only provenance regeneration rejects forged source lists and rehashed generated files',async()=>{
  const api=await import('./sync-web-source.mjs');
  assert.equal(typeof api.verifyWebsiteProvenance,'function');
  await gitFixture(async({temporary,website,commit})=>{
    const sourceDirectory=path.join(temporary,'snapshot');
    const manifest=await api.syncWebsite({websiteRoot:website,websiteCommit:commit,outputRoot:sourceDirectory});
    const manifestPath=path.join(sourceDirectory,'source-manifest.json'),before=await readFile(manifestPath);
    await api.verifyWebsiteProvenance({websiteRoot:website,sourceDirectory,websiteCommit:commit});
    assert.deepEqual(await readFile(manifestPath),before);
    const output=execFileSync(process.execPath,[fileURLToPath(new URL('./sync-web-source.mjs',import.meta.url)),'--verify-only','--website-root',website,'--website-commit',commit,'--source-directory',sourceDirectory],{encoding:'utf8'});
    assert.match(output,/Verified website provenance for 17/);
    assert.deepEqual(await readFile(manifestPath),before);
    const forged=structuredClone(manifest);forged.sourceFiles[0].sha256='0'.repeat(64);
    await writeFile(manifestPath,JSON.stringify(forged));
    await assert.rejects(api.verifyWebsiteProvenance({websiteRoot:website,sourceDirectory,websiteCommit:commit}),/source|provenance/i);
    const bytes=Buffer.from('<p>Forged generated file</p>\n');
    await writeFile(path.join(sourceDirectory,'intro.html'),bytes);
    const entry=manifest.generatedFiles.find(file=>file.path==='intro.html');entry.sha256=createHash('sha256').update(bytes).digest('hex');entry.size=bytes.length;
    await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(api.verifyWebsiteProvenance({websiteRoot:website,sourceDirectory,websiteCommit:commit}),/generated|provenance/i);
  });
});
