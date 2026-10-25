import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createPublisher,localCredential,publishPagePackage} from './publish-page-package.mjs';
import {buildPagePackage,signManifestPayload} from './page-package.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import childProcess,{execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {syncWebsite} from './sync-web-source.mjs';

const commit='a'.repeat(40),tag='pages-v1.0.0';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');

test('credential lookup selects the repository owner when multiple GitHub accounts exist',t=>{
  const saved=Object.fromEntries(['GITHUB_TOKEN','GH_TOKEN'].map(name=>[name,process.env[name]]));
  delete process.env.GITHUB_TOKEN;delete process.env.GH_TOKEN;
  let calls=0;
  const stub=t.mock.method(childProcess,'spawnSync',(command,args,options)=>{
    calls++;assert.equal(command,'git');assert.deepEqual(args,['credential','fill']);
    assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');assert.equal(options.env.GCM_INTERACTIVE,'never');
    return options.input==='protocol=https\nhost=github.com\nusername=301zrg\n\n'
      ?{status:0,stdout:'username=301zrg\npassword=fixture-token\n'}:{status:1,stdout:''};
  });
  syncBuiltinESMExports();
  t.after(()=>{stub.mock.restore();syncBuiltinESMExports();for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
  assert.equal(localCredential(),'fixture-token');assert.equal(calls,1);
});

async function provenanceFixture(t,{withGit=true}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'page-publisher-provenance-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('page-publisher-provenance-'));await rm(root,{recursive:true,force:true});});
  const repository=path.join(root,'website'),websiteRoot=path.join(repository,'plugins/ladder-web/web'),sourceDirectory=path.join(root,'web-source');
  await mkdir(path.join(websiteRoot,'assets'),{recursive:true});
  for(const name of ['intro','rooms','replays','ladder','deck-stats','player-stats','usage-stats','deck-detail'])await writeFile(path.join(websiteRoot,name+'.html'),'<p>'+name+' fixture</p>\n');
  for(const name of ['common.css','stats-export.js','stats-workbook.js','exceljs-4.4.0.min.js','player-duel-stats.js','deck-card-usage.js','rating-rules.js'])await writeFile(path.join(websiteRoot,'assets',name),'/* fixture */\n');
  await writeFile(path.join(websiteRoot,'assets/site-shell.js'),"(function(global){\n  'use strict';\n  global.SrvproWeb = Object.freeze({\n    rateColor: rateColor,\n  });\n})(window);\n");
  const git=(...args)=>execFileSync('git',['-c','core.autocrlf=false','-c','core.safecrlf=false','-c','commit.gpgsign=false','-c','user.name=Publisher Fixture','-c','user.email=publisher@example.invalid','-C',repository,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  let websiteCommit='b'.repeat(40);
  if(withGit){git('init','--template=');git('add','.');git('commit','-m','publisher fixture');websiteCommit=git('rev-parse','HEAD');}
  const sourceManifest=await syncWebsite({websiteRoot,outputRoot:sourceDirectory,websiteCommit:withGit?websiteCommit:null});
  sourceManifest.websiteCommit=websiteCommit;sourceManifest.websiteBaseCommit=websiteCommit;
  await writeFile(path.join(sourceDirectory,'source-manifest.json'),JSON.stringify(sourceManifest,null,2)+'\n');
  await writeFile(path.join(sourceDirectory,'index.html'),'<p>Native fixture entry</p>\n');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId='fixture',publicKeyPath=path.join(root,'public.json');
  await writeFile(publicKeyPath,JSON.stringify({keyId,publicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}));
  const now=new Date();
  const bundle=await buildPagePackage({distDir:sourceDirectory,outputDir:path.join(root,'out'),privateKey,keyId,version:'1.0.0',sequence:1,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+86400000).toISOString(),sourceCommits:{desktop:commit,website:websiteCommit},requireSourceManifest:true});
  return {websiteRoot,sourceDirectory,sourceManifest,git,options:{manifestPath:bundle.manifestPath,archivePath:bundle.archivePath,publicKeyPath,commit,websiteRoot,sourceDirectory}};
}

function noNetwork() {
  let tokens=0,requests=0;
  return {adapters:{tokenProvider:()=>{tokens++;return 'fixture-token';},fetchImpl:async()=>{requests++;throw Error('Unexpected fixture request');}},counts:()=>({tokens,requests})};
}

test('a formal publisher refuses a signed fixture without website provenance before any network write',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'page-publish-test-'));
  t.after(async()=>{assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith('page-publish-test-'));await rm(root,{recursive:true,force:true});});
  const dist=path.join(root,'dist');await mkdir(dist);await writeFile(path.join(dist,'index.html'),'local fixture');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const keyPath=path.join(root,'public.json');const keyId='fixture';
  await writeFile(keyPath,JSON.stringify({keyId,publicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}));
  const now=new Date();const bundle=await buildPagePackage({distDir:dist,outputDir:path.join(root,'out'),privateKey,keyId,
    version:'1.0.0',sequence:1,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+86400000).toISOString(),sourceCommits:{desktop:commit,website:'b'.repeat(40)}});
  let requests=0;
  await assert.rejects(publishPagePackage({manifestPath:bundle.manifestPath,archivePath:bundle.archivePath,publicKeyPath:keyPath,commit,
    tokenProvider:()=> 'fixture-token',fetchImpl:async()=>{requests++;throw Error('No fixture should reach the network');}}),/provenance.*required/i);
  assert.equal(requests,0);
});

test('formal publisher rejects a valid-looking manifest without actual Git provenance before credentials',async t=>{
  const fixture=await provenanceFixture(t,{withGit:false}),network=noNetwork();
  await assert.rejects(publishPagePackage({...fixture.options,...network.adapters}));
  assert.deepEqual(network.counts(),{tokens:0,requests:0});
});

test('formal publisher rejects an older real commit label over changed website source before credentials',async t=>{
  const fixture=await provenanceFixture(t),network=noNetwork();
  await writeFile(path.join(fixture.websiteRoot,'intro.html'),'<p>New committed feature</p>\n');fixture.git('add','.');fixture.git('commit','-m','new feature');
  await assert.rejects(publishPagePackage({...fixture.options,...network.adapters}));
  assert.deepEqual(network.counts(),{tokens:0,requests:0});
});

test('formal publisher binds the exact local source-manifest bytes to the signed ZIP entry',async t=>{
  const fixture=await provenanceFixture(t),network=noNetwork();
  await writeFile(path.join(fixture.sourceDirectory,'source-manifest.json'),JSON.stringify(fixture.sourceManifest));
  await assert.rejects(publishPagePackage({...fixture.options,...network.adapters}));
  assert.deepEqual(network.counts(),{tokens:0,requests:0});
});

test('formal publisher requires websiteRoot and accepts actual matching Git blobs at the fake fetch boundary',async t=>{
  const fixture=await provenanceFixture(t),network=noNetwork();
  await assert.rejects(publishPagePackage({...fixture.options,websiteRoot:undefined,...network.adapters}),/WEBSITE_ROOT_REQUIRED/);
  assert.deepEqual(network.counts(),{tokens:0,requests:0});
  let tokens=0,requests=0;
  await assert.rejects(publishPagePackage({...fixture.options,tokenProvider:()=>{tokens++;return 'fixture-token';},fetchImpl:async()=>{requests++;return response({object:{type:'commit',sha:'f'.repeat(40)}});}}),/TAG_CONFLICT/);
  assert.equal(tokens,1);assert.equal(requests,1);
});

test('page release uploads verified assets and explicitly preserves application latest',async()=>{
  const calls=[];let published=false;
  const publisher=createPublisher({tokenProvider:()=> 'fixture-token',fetchImpl:async(url,init)=>{
    const route=new URL(url).pathname,body=init.body&&!Buffer.isBuffer(init.body)?JSON.parse(init.body):null;calls.push({route,method:init.method,body});
    if(route.endsWith('/git/ref/tags/'+tag))return response({object:{type:'commit',sha:commit}});
    if(route.endsWith('/releases/tags/'+tag))return published?response({id:7,tag_name:tag,draft:false,prerelease:false,html_url:'https://github.com/example/release'}):response(null,404);
    if(route.endsWith('/releases')&&init.method==='POST')return response({id:7,tag_name:tag,draft:true,assets:[],upload_url:'https://uploads.github.com/repos/301zrg/srvprotianti-desktop/releases/7/assets{?name}'});
    if(route.endsWith('/assets'))return response({size:init.body.length,digest:'sha256:'+hash(init.body)});
    if(route.endsWith('/releases/7')){published=true;return response({});}
    if(route.endsWith('/releases/latest'))return response({tag_name:'v0.1.4',assets:[{name:'srvprotianti-desktop-windows-x64.zip'}]});
    throw Error('Unexpected fixture route');
  }});
  const result=await publisher.release({tag,commit,archive:Buffer.from('archive'),manifest:Buffer.from('manifest')});
  assert.equal(result.latestApplication,'v0.1.4');
  assert.equal(calls.find(c=>c.method==='POST'&&c.route.endsWith('/releases')).body.make_latest,'false');
  assert.equal(calls.find(c=>c.method==='PATCH').body.make_latest,'false');
});

test('existing tag with another source never publishes or overwrites anything',async()=>{
  let writes=0;
  const publisher=createPublisher({tokenProvider:()=> 'fixture-token',fetchImpl:async(_url,init)=>{
    if(init.method!=='GET')writes++;
    return response({object:{type:'commit',sha:'b'.repeat(40)}});
  }});
  await assert.rejects(publisher.release({tag,commit,archive:Buffer.alloc(1),manifest:Buffer.alloc(1)}),/TAG_CONFLICT/);
  assert.equal(writes,0);
});

test('signed channel sequence cannot be downgraded and corrupted index is never replaced',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  const original=signManifestPayload({application:'org.srvprotianti.desktop',channel:'stable',sequence:5},{privateKey,keyId:'fixture'});
  for(const manifest of [original,{...original,signature:Buffer.alloc(64).toString('base64')}]){
    let writes=0;
    const publisher=createPublisher({tokenProvider:()=> 'fixture-token',fetchImpl:async(url,init)=>{
      if(init.method!=='GET')writes++;
      return new URL(url).pathname.includes('/git/ref/')?response({object:{sha:commit}}):response({encoding:'base64',content:Buffer.from(JSON.stringify(manifest)).toString('base64')});
    }});
    await assert.rejects(publisher.index({manifest:Buffer.from('new candidate'),sequence:4,publicKey:raw,keyId:'fixture'}),/SEQUENCE_CONFLICT|INDEX_SIGNATURE/);
    assert.equal(writes,0);
  }
});

test('uncertain channel creation is read back without repeating a write',async()=>{
  let created=false,writes=0;
  const manifest=Buffer.from('{"signed":"candidate"}');
  const publisher=createPublisher({tokenProvider:()=> 'fixture-token',fetchImpl:async(url,init)=>{
    const route=new URL(url).pathname;
    if(route.includes('/git/ref/'))return response(null,404);
    if(route.endsWith('/git/trees'))return response({sha:'tree'});
    if(route.endsWith('/git/commits'))return response({sha:commit});
    if(route.endsWith('/git/refs')){writes++;created=true;throw Error('Lost reply');}
    if(route.includes('/contents/stable.json')&&created)return response({encoding:'base64',content:manifest.toString('base64')});
    throw Error('Unexpected fixture route');
  }});
  const result=await publisher.index({manifest,sequence:1,publicKey:'',keyId:'fixture'});
  assert.equal(result.commit,commit);assert.equal(writes,1);
});
