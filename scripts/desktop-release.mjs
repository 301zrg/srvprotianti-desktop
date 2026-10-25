import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repository='301zrg/srvprotianti-desktop';
const assetName='srvprotianti-desktop-windows-x64.zip';
const stable=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function requireValue(condition,message){if(!condition)throw Error(message);}

export async function makeManifest({version,commit,archive}){
  requireValue(stable.test(version),'A stable canonical version is required');
  requireValue(/^[a-f0-9]{40}$/.test(commit),'A full source commit is required');
  requireValue(path.basename(archive)===assetName,'Unexpected application asset name');
  const bytes=await readFile(archive);
  requireValue(bytes.length>0,'Application ZIP is empty');
  return {schemaVersion:1,version,tag:'v'+version,sourceCommit:commit,asset:{name:assetName,size:bytes.length,sha256:digest(bytes)}};
}

export async function verifyManifest(manifest,{archive,tag,commit}){
  const expected=await makeManifest({version:tag?.slice(1),commit,archive});
  requireValue(tag===expected.tag&&JSON.stringify(manifest)===JSON.stringify(expected),'Manifest does not match application ZIP, version or source commit');
  return expected;
}

export async function publishRelease({archive,manifestPath,tag,commit,run=args=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']})}){
  requireValue(path.basename(manifestPath)==='desktop-update.json','Unexpected manifest asset name');
  const manifestBytes=await readFile(manifestPath);
  const manifest=await verifyManifest(JSON.parse(manifestBytes),{archive,tag,commit});
  const api=endpoint=>JSON.parse(run(['api',`repos/${repository}/${endpoint}`]));
  const reference=api(`git/ref/tags/${tag}`);
  requireValue(reference.object?.type==='commit'&&reference.object.sha===commit,'Release tag points to another source commit');
  // Existing/uncertain releases are never overwritten or silently retried.
  run(['release','create',tag,archive,manifestPath,'--repo',repository,'--draft','--verify-tag','--title',tag,'--generate-notes']);
  const expected=[manifest.asset,{name:'desktop-update.json',size:manifestBytes.length,sha256:digest(manifestBytes)}];
  function verifyAssets(release,draft){
    requireValue(release.tag_name===tag&&release.draft===draft&&release.prerelease===false,'Unexpected Release state');
    for(const asset of expected){
      const matches=release.assets?.filter(value=>value.name===asset.name)||[];
      requireValue(matches.length===1&&matches[0].state==='uploaded'&&matches[0].size===asset.size&&matches[0].digest===`sha256:${asset.sha256}`,'Release asset size or digest mismatch');
    }
  }
  verifyAssets(api(`releases/tags/${tag}`),true);
  run(['release','edit',tag,'--repo',repository,'--draft=false','--latest']);
  verifyAssets(api(`releases/tags/${tag}`),false);
  verifyAssets(api('releases/latest'),false);
  return {tag,sourceCommit:commit,archiveSha256:manifest.asset.sha256,manifestSha256:digest(manifestBytes)};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    const [command,...raw]=process.argv.slice(2),args={};
    for(let i=0;i<raw.length;i+=2){requireValue(raw[i].startsWith('--')&&raw[i+1],'Expected --name value');args[raw[i].slice(2)]=raw[i+1];}
    const version=args.version||JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
    if(command==='manifest')await writeFile(args.out,JSON.stringify(await makeManifest({version,commit:args.commit,archive:args.archive}))+ '\n');
    else if(command==='verify')await verifyManifest(JSON.parse(await readFile(args.manifest,'utf8')),{archive:args.archive,tag:args.tag||'v'+version,commit:args.commit});
    else if(command==='publish')console.log(JSON.stringify(await publishRelease({archive:args.archive,manifestPath:args.manifest,tag:args.tag,commit:args.commit})));
    else throw Error('Expected manifest, verify or publish');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
