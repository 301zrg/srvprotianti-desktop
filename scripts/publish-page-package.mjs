import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash,verify,createPublicKey} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {verifyPagePackage} from './page-package.mjs';
import {verifyWebsiteProvenance} from './sync-web-source.mjs';

const REPOSITORY='301zrg/srvprotianti-desktop';
const API=`https://api.github.com/repos/${REPOSITORY}`;
const DOMAIN=Buffer.from('srvprotianti-desktop-pages-v1\0');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});

export function localCredential(){
  const provided=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  if(provided)return provided;
  const result=spawnSync('git',['credential','fill'],{input:`protocol=https\nhost=github.com\nusername=${REPOSITORY.split('/')[0]}\n\n`,encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
  if(result.status!==0)throw fail('PAGE_PUBLISH_AUTH_REQUIRED');
  const token=result.stdout.match(/^password=(.+)$/m)?.[1]?.trim();
  if(!token)throw fail('PAGE_PUBLISH_AUTH_REQUIRED');
  return token;
}

export function createPublisher({fetchImpl=fetch,tokenProvider=localCredential}={}){
  let token;
  async function request(route,{method='GET',body,raw,type='application/json',missing=false}={}){
    token??=await tokenProvider();
    const url=route.startsWith('https://')?route:API+route;
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!['api.github.com','uploads.github.com'].includes(parsed.hostname))throw fail('PAGE_PUBLISH_DESTINATION_INVALID');
    let response;
    try{response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'srvpro-desktop-pages',Authorization:`Bearer ${token}`,...((body!==undefined||raw)?{'Content-Type':type}:{})},body:raw??(body===undefined?undefined:JSON.stringify(body))});}
    catch{throw fail('PAGE_PUBLISH_REQUEST_UNCERTAIN');}
    if(missing&&response.status===404)return null;
    if(!response.ok)throw fail(`PAGE_PUBLISH_HTTP_${response.status}`);
    try{return await response.json();}catch{throw fail('PAGE_PUBLISH_RESPONSE_INVALID');}
  }
  async function ensureTag(tag,commit){
    let ref=await request(`/git/ref/tags/${tag}`,{missing:true});
    if(!ref){
      try{await request('/git/refs',{method:'POST',body:{ref:`refs/tags/${tag}`,sha:commit}});}catch{}
      ref=await request(`/git/ref/tags/${tag}`,{missing:true});
    }
    if(ref?.object?.type!=='commit'||ref.object.sha!==commit)throw fail('PAGE_PUBLISH_TAG_CONFLICT');
  }
  async function release({tag,commit,archive,manifest}){
    await ensureTag(tag,commit);
    let value=await request(`/releases/tags/${tag}`,{missing:true});
    if(!value){
      try{value=await request('/releases',{method:'POST',body:{tag_name:tag,target_commitish:commit,name:`Desktop pages ${tag.slice(7)}`,body:'Signed desktop pages. Requires desktop application 0.2.0 or later. Application downloads remain under the latest application release.',draft:true,prerelease:false,make_latest:'false'}});}
      catch{value=await request(`/releases/tags/${tag}`,{missing:true});if(!value)throw fail('PAGE_PUBLISH_RELEASE_UNCERTAIN');}
    }
    if(value.tag_name!==tag)throw fail('PAGE_PUBLISH_RELEASE_INVALID');
    for(const [name,bytes,type] of [['srvprotianti-desktop-pages.zip',archive,'application/zip'],['stable.json',manifest,'application/json']]){
      const existing=value.assets?.find(asset=>asset.name===name);
      if(existing){
        if(existing.size!==bytes.length||existing.digest!==`sha256:${digest(bytes)}`)throw fail('PAGE_PUBLISH_ASSET_CONFLICT');
      }else{
        if(!value.draft)throw fail('PAGE_PUBLISH_IMMUTABLE_RELEASE');
        const base=value.upload_url?.split('{')[0];
        if(!base?.startsWith(`https://uploads.github.com/repos/${REPOSITORY}/releases/`))throw fail('PAGE_PUBLISH_UPLOAD_INVALID');
        const asset=await request(`${base}?name=${encodeURIComponent(name)}`,{method:'POST',raw:bytes,type});
        if(asset.size!==bytes.length||asset.digest!==`sha256:${digest(bytes)}`)throw fail('PAGE_PUBLISH_ASSET_HASH');
      }
    }
    if(value.draft){
      try{await request(`/releases/${value.id}`,{method:'PATCH',body:{draft:false,make_latest:'false'}});}catch{}
      value=await request(`/releases/tags/${tag}`);
    }
    if(value.draft||value.prerelease)throw fail('PAGE_PUBLISH_RELEASE_UNCONFIRMED');
    const latest=await request('/releases/latest');
    if(latest.tag_name===tag||!latest.assets?.some(asset=>asset.name==='srvprotianti-desktop-windows-x64.zip'))throw fail('PAGE_PUBLISH_LATEST_CHANGED');
    return {id:value.id,url:value.html_url,latestApplication:latest.tag_name};
  }
  async function index({manifest,sequence,publicKey,keyId}){
    const previous=await request('/git/ref/heads/page-updates',{missing:true});
    const previousSha=previous?.object?.sha;
    if(previous){
      const current=await request('/contents/stable.json?ref=page-updates',{missing:true});
      if(!current||current.encoding!=='base64')throw fail('PAGE_PUBLISH_INDEX_INVALID');
      const bytes=Buffer.from(current.content,'base64');
      if(digest(bytes)===digest(manifest))return {commit:previousSha,alreadyPublished:true};
      let envelope,payload;
      try{
        envelope=JSON.parse(bytes);const raw=Buffer.from(envelope.payload,'base64');
        const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicKey,'base64')]),format:'der',type:'spki'});
        if(envelope.schemaVersion!==1||envelope.keyId!==keyId||!verify(null,Buffer.concat([DOMAIN,raw]),key,Buffer.from(envelope.signature,'base64')))throw Error();
        payload=JSON.parse(raw);
      }catch{throw fail('PAGE_PUBLISH_INDEX_SIGNATURE');}
      if(payload.application!=='org.srvprotianti.desktop'||payload.channel!=='stable'||!Number.isSafeInteger(payload.sequence)||payload.sequence>=sequence)throw fail('PAGE_PUBLISH_SEQUENCE_CONFLICT');
    }
    const tree=await request('/git/trees',{method:'POST',body:{tree:[{path:'stable.json',mode:'100644',type:'blob',content:manifest.toString('utf8')}]}});
    const commit=await request('/git/commits',{method:'POST',body:{message:`Publish signed desktop page sequence ${sequence}`,tree:tree.sha,parents:previousSha?[previousSha]:[]}});
    const observed=await request('/git/ref/heads/page-updates',{missing:true});
    if(observed?.object?.sha!==previousSha)throw fail('PAGE_PUBLISH_INDEX_RACED');
    try{
      if(previousSha)await request('/git/refs/heads/page-updates',{method:'PATCH',body:{sha:commit.sha,force:false}});
      else await request('/git/refs',{method:'POST',body:{ref:'refs/heads/page-updates',sha:commit.sha}});
    }catch{}
    const result=await request('/contents/stable.json?ref=page-updates');
    if(result.encoding!=='base64'||digest(Buffer.from(result.content,'base64'))!==digest(manifest))throw fail('PAGE_PUBLISH_INDEX_UNCONFIRMED');
    return {commit:commit.sha,alreadyPublished:false};
  }
  return {request,release,index};
}

export async function publishPagePackage({manifestPath,archivePath,publicKeyPath,commit,websiteRoot,sourceDirectory=path.resolve(import.meta.dirname,'../web-source'),...options}){
  if(!/^[a-f0-9]{40}$/.test(commit||''))throw fail('PAGE_PUBLISH_COMMIT_INVALID');
  const [manifest,archive,keyBytes]=await Promise.all([readFile(manifestPath),readFile(archivePath),readFile(publicKeyPath)]);
  const key=JSON.parse(keyBytes);
  const payload=verifyPagePackage({manifest,archive,publicKey:key.publicKey,keyId:key.keyId,requireSourceManifest:true});
  if(payload.sourceCommits.desktop!==commit)throw fail('PAGE_PUBLISH_SOURCE_MISMATCH');
  if(typeof websiteRoot!=='string'||!websiteRoot)throw fail('PAGE_PUBLISH_WEBSITE_ROOT_REQUIRED');
  let provenance;
  try{provenance=await verifyWebsiteProvenance({websiteRoot,sourceDirectory,websiteCommit:payload.sourceCommits.website});}
  catch{throw fail('PAGE_PUBLISH_WEBSITE_PROVENANCE_INVALID');}
  const sourceBytes=await readFile(path.join(sourceDirectory,'source-manifest.json'));
  const signedSource=payload.files.find(file=>file.path==='source-manifest.json');
  // Bind the exact signed bytes to the same manifest verified above, even if a
  // local process replaces the file between the provenance check and this read.
  let sameManifest=false;
  try{sameManifest=JSON.stringify(JSON.parse(sourceBytes))===JSON.stringify(provenance);}catch{}
  if(!sameManifest||!signedSource||signedSource.size!==sourceBytes.length||signedSource.sha256!==digest(sourceBytes))throw fail('PAGE_PUBLISH_SOURCE_MANIFEST_MISMATCH');
  const publisher=createPublisher(options);
  const release=await publisher.release({tag:`pages-v${payload.version}`,commit,archive,manifest});
  const index=await publisher.index({manifest,sequence:payload.sequence,publicKey:key.publicKey,keyId:key.keyId});
  return {release,index,pageVersion:payload.version,sequence:payload.sequence,archiveSha256:digest(archive),manifestSha256:digest(manifest)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
  publishPagePackage({manifestPath:args.manifest,archivePath:args.archive,publicKeyPath:args['public-key'],commit:args.commit,websiteRoot:args['website-root'],sourceDirectory:args['source-directory']}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.code||'PAGE_PUBLISH_FAILED');process.exitCode=1;});
}
