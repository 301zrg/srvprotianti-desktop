import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const commit='a'.repeat(40), name='srvprotianti-desktop-windows-x64.zip';
async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'desktop-release-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const archive=path.join(dir,name),manifestPath=path.join(dir,'desktop-update.json');
  await writeFile(archive,'fixture zip bytes');
  return {dir,archive,manifestPath};
}

test('CLI generates a version manifest bound to the exact ZIP bytes',async t=>{
  const f=await fixture(t);
  const result=spawnSync(process.execPath,['scripts/desktop-release.mjs','manifest','--archive',f.archive,'--out',f.manifestPath,'--version','0.2.1','--commit',commit],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath,'utf8')),{schemaVersion:1,version:'0.2.1',tag:'v0.2.1',sourceCommit:commit,asset:{name,size:17,sha256:'2a0b19afdfe6ba2d01a822bf194bf3a6e59fb0cf1dd907141a6f081a735bfd88'}});
});

test('verification rejects a changed ZIP, mismatched tag and nonstable versions',async t=>{
  const f=await fixture(t),m=await import('./desktop-release.mjs');
  const manifest=await m.makeManifest({version:'0.2.1',commit,archive:f.archive});
  await assert.rejects(()=>m.verifyManifest({...manifest,tag:'v0.2.2'},{archive:f.archive,tag:'v0.2.1',commit}));
  for(const version of ['v0.2.1','0.2.1-beta.1','0.2.1+build','01.2.1'])await assert.rejects(()=>m.makeManifest({version,commit,archive:f.archive}));
  await writeFile(f.archive,'modified');
  await assert.rejects(()=>m.verifyManifest(manifest,{archive:f.archive,tag:'v0.2.1',commit}));
});

async function publisherFixture(t,{badDigest=false,publicAlready=false,wrongLatest=false,wrongCommit=false,failPublish=false}={}) {
  const f=await fixture(t),m=await import('./desktop-release.mjs');
  const manifest=await m.makeManifest({version:'0.2.1',commit,archive:f.archive});
  await writeFile(f.manifestPath,JSON.stringify(manifest)+'\n');
  const assets=await Promise.all([f.archive,f.manifestPath].map(async file=>{const bytes=await readFile(file);return {name:path.basename(file),size:bytes.length,state:'uploaded',digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};}));
  if(badDigest)assets[0].digest='sha256:'+'0'.repeat(64);
  const calls=[];let published=publicAlready;
  const run=args=>{
    calls.push(args);
    if(args[0]==='api'&&args[1].includes('/git/ref/'))return JSON.stringify({object:{type:'commit',sha:wrongCommit?'c'.repeat(40):commit}});
    if(args[0]==='release'&&args[1]==='create')return '';
    if(args[0]==='release'&&args[1]==='edit'){if(failPublish)throw Error('uncertain publish');published=true;return '';}
    if(args[0]==='api')return JSON.stringify({tag_name:wrongLatest&&args[1].endsWith('/latest')?'v0.2.0':'v0.2.1',draft:!published,prerelease:false,assets});
    throw Error('unexpected gh operation');
  };
  return {...f,m,calls,run,publish:()=>m.publishRelease({...f,tag:'v0.2.1',commit,run})};
}

test('publishes only after draft assets have matching sizes and digests',async t=>{
  const f=await publisherFixture(t);await f.publish();
  const create=f.calls.find(a=>a[0]==='release'&&a[1]==='create');
  assert.ok(create.includes('--draft'));assert.ok(create.includes(f.archive));assert.ok(create.includes(f.manifestPath));
  const edit=f.calls.findIndex(a=>a[0]==='release'&&a[1]==='edit');
  assert.ok(f.calls.slice(0,edit).some(a=>a[0]==='api'&&a[1].endsWith('/releases/tags/v0.2.1')));
  assert.ok(f.calls.at(-1)[1].endsWith('/releases/latest'));
});

test('digest mismatch, wrong tag commit and public release stop before publication',async t=>{
  for(const option of [{badDigest:true},{wrongCommit:true},{publicAlready:true}]){
    const f=await publisherFixture(t,option);await assert.rejects(f.publish);
    assert.ok(!f.calls.some(a=>a[0]==='release'&&a[1]==='edit'));
  }
});

test('unknown publication and wrong latest are reported as failures without retry or deletion',async t=>{
  for(const option of [{failPublish:true},{wrongLatest:true}]){
    const f=await publisherFixture(t,option);await assert.rejects(f.publish);
    assert.equal(f.calls.filter(a=>a[0]==='release'&&a[1]==='edit').length,1);
    assert.ok(!f.calls.some(a=>a.includes('delete')||a.includes('--clobber')));
  }
});
