import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const pages=['intro','rooms','replays','ladder','deck-stats','player-stats','usage-stats','deck-detail'];
const assets=['common.css','site-shell.js','stats-export.js','stats-workbook.js','exceljs-4.4.0.min.js','player-duel-stats.js','deck-card-usage.js','rating-rules.js'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputs=[...pages.map(page=>page+'.html'),...assets.map(asset=>'assets/'+asset)];
const outputs=[...pages.map(page=>page+'.html'),...assets];
const validCommit=value=>value===null||(typeof value==='string'&&/^[a-f0-9]{40}$/.test(value));
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

function validateManifest(manifest) {
  if(!exactKeys(manifest,['schemaVersion','generatorVersion','websiteCommit','websiteBaseCommit','sourceFiles','generatedFiles'])||
    manifest.schemaVersion!==1||manifest.generatorVersion!==1||!validCommit(manifest.websiteCommit)||!validCommit(manifest.websiteBaseCommit))throw Error('Invalid source manifest schema or commit fields');
  for(const [key,names] of [['sourceFiles',inputs],['generatedFiles',outputs]]) {
    const allowed=new Set(names),list=manifest[key];
    if(!Array.isArray(list)||list.length!==allowed.size)throw Error('Invalid source manifest '+key+' list');
    for(const file of list) {
      if(!exactKeys(file,['path','size','sha256'])||!allowed.delete(file.path)||!Number.isSafeInteger(file.size)||file.size<0||file.size>20*1024*1024||
        typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid source manifest '+key+' entry');
    }
  }
}

export async function verifySynchronizedSource(directory,manifest) {
  validateManifest(manifest);
  for(const file of manifest.generatedFiles) {
    const info=await lstat(path.join(directory,file.path));
    if(!info.isFile()||info.isSymbolicLink())throw Error('Generated source must be a regular file: '+file.path);
    const bytes=await readFile(path.join(directory,file.path));
    if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw Error('Generated web-source changed: '+file.path+'; rerun the explicit website sync');
  }
}

export function adaptPage(page,html) {
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) throw Error(page+': inline event attributes are forbidden');
  html=html.replace(/<(?:script|link)\b[^>]*(?:src|href)="\/assets\/(?:web-client-config|deck-web-open|replay-web-open)(?:\.js|\.css)[^"]*"[^>]*>(?:<\/script>)?/g,'');
  if(page==='intro') {
    html=html.replace(/<script src="\/assets\/intro-web\.js[^"]*"><\/script>/g,'')
      .replace(/<p data-web-intro>[\s\S]*?<\/p>/g,'').replace('SrvproIntroWeb.apply(I18N);','');
  }
  // These controls import into browser storage; native download controls already
  // save/open the same bytes through the fixed Rust commands.
  html=html.replace(/\s*(?:var|const) openButton = document\.createElement\('button'\);[\s\S]*?actions\.appendChild\(openButton\);/g,'')
    .replace(/\s*const playButton = document\.createElement\('button'\);[\s\S]*?replayActions\.appendChild\(playButton\);/g,'')
    .replace(/<button type="button" class="deck-web-open"[\s\S]*?<\/button>/g,'')
    .replace(/root\.querySelectorAll\('\[data-open-(?:deck|template)\]'\)\.forEach\(function\(b\)\{[\s\S]*?\}\);/g,'')
    .replace(/function openPlayerDeck\([\s\S]*?(?=async function downloadDeck)/,'');
  if(/Srvpro(?:Deck|Replay)Web/.test(html)) throw Error(page+': an unadapted browser import remains');
  html=html.replace(/<script>([\s\S]*?)<\/script>/g,(_,code)=>{
    if(['ladder','player-stats'].includes(page)) {
      code=code.replaceAll('SrvproWeb.rateColor(', 'SrvproWeb.rateClass(').replaceAll('SrvproWeb.semanticColor(', 'SrvproWeb.semanticClass(')
        .replaceAll("'#73d6a3'", "'desktop-positive'").replaceAll("'#ef837f'", "'desktop-negative'")
        .replaceAll("'<span style=\"color:'", "'<span class=\"'");
    }
    if(page==='deck-detail') code=code.replaceAll('SrvproWeb.deckRateColor(', 'SrvproWeb.deckRateClass(').replaceAll('strong style="color:', 'strong class="');
    if(page==='deck-stats') code=code.replace('var color = SrvproWeb.deckRateColor(rate);','var color = SrvproWeb.deckRateClass(rate);')
      .replace('class="val-colored" style="color:\'+color+\';"','class="val-colored \'+color+\'"');
    return '<script>'+code+'</script>';
  });
  return html.replace(/^[ \t]+$/gm,'');
}

function adaptShell(code) {
  const marker='  global.SrvproWeb = Object.freeze({';
  if(!code.includes(marker))throw Error('Shared shell export contract changed');
  const helpers=`  function rateClass(rate) {
    var value=Number(rate);
    return 'desktop-rate-'+(Number.isFinite(value)?Math.round(Math.max(0,Math.min(100,value))):50);
  }
  function semanticClass(value) { return Number(value)>0?'desktop-positive':Number(value)<0?'desktop-negative':'desktop-rate-50'; }
`;
  return code.replace("  'use strict';",`  'use strict';
  // These hrefs are public fallbacks; the native bridge captures every game action.
  global.SRVPRO_WEB_CLIENT_URL='https://ocg1103nexus.com/';
  global.SRVPRO_WEB_CLIENT_ENABLED=true;`).replace(marker,helpers+marker).replace('    rateColor: rateColor,',`    rateColor: rateColor,
    rateClass: rateClass,
    deckRateClass: function(rate) { return rateClass(50+(Number(rate)-50)*2); },
    semanticClass: semanticClass,`);
}

function git(directory,args,encoding) {
  return execFileSync('git',['-C',directory,...args],{encoding,stdio:['ignore','pipe','pipe'],maxBuffer:24*1024*1024,timeout:15000,windowsHide:true});
}
function sameTextBytes(left,right) {
  return left.equals(right)||Buffer.from(left.toString('latin1').replaceAll('\r\n','\n'),'latin1').equals(Buffer.from(right.toString('latin1').replaceAll('\r\n','\n'),'latin1'));
}

async function websiteSnapshot({websiteRoot,websiteCommit=null}={}) {
  if(!websiteRoot||/^[a-z]+:\/\//i.test(websiteRoot))throw Error('--website-root must name an explicit local source directory');
  if(!validCommit(websiteCommit))throw Error('--website-commit must be a full Git commit');
  const inputRoot=await realpath(path.resolve(websiteRoot));
  let repository=null,baseCommit=null,sourcePrefix='';
  if(websiteCommit!==null) {
    try {repository=await realpath(git(inputRoot,['rev-parse','--show-toplevel'],'utf8').trim());}
    catch {throw Error('Website provenance requires a Git repository');}
    const relative=path.relative(repository,inputRoot);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Website source is outside its Git repository');
    sourcePrefix=relative.split(path.sep).join('/');
    try {if(git(repository,['rev-parse','--verify',websiteCommit+'^{commit}'],'utf8').trim()!==websiteCommit)throw Error();}
    catch {throw Error('Website commit is not present in the source Git repository');}
    baseCommit=websiteCommit;
  } else {
    try {baseCommit=git(inputRoot,['rev-parse','HEAD'],'utf8').trim();if(!validCommit(baseCommit))baseCommit=null;}catch{/* Draft exports are identified by their complete local file hashes. */}
  }
  const sourceFiles=[],generatedFiles=[],pending=[];
  for(const input of inputs) {
    const file=path.join(inputRoot,input), info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink())throw Error('Source must be a regular file: '+input);
    const resolved=await realpath(file), relative=path.relative(inputRoot,resolved);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Source file escapes the selected website directory');
    const workingBytes=await readFile(file);
    let bytes=workingBytes;
    if(repository) {
      const treePath=(sourcePrefix?sourcePrefix+'/':'')+input;
      let object;
      try {
        const entry=git(repository,['ls-tree','-z',websiteCommit,'--',treePath],'utf8');
        const match=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
        if(!match||match[3]!==treePath)throw Error();
        object=git(repository,['cat-file','blob',match[2]]);
      } catch {throw Error('Website commit lacks a regular source blob: '+input);}
      if(!sameTextBytes(workingBytes,object))throw Error('Website working file differs from declared commit: '+input);
      bytes=object;
    }
    sourceFiles.push({path:input,size:bytes.length,sha256:sha256(bytes)});
    const destination=input.startsWith('assets/')?input.slice(7):input;
    let contents=bytes.toString('utf8');
    if(input.endsWith('.html'))contents=adaptPage(input.slice(0,-5),contents);
    if(destination==='site-shell.js')contents=adaptShell(contents);
    if(destination==='common.css')contents+='\n/* Native platform actions share the website layout. */\n.deck-actions,.replay-actions{display:inline-flex;align-items:center;gap:6px;flex-wrap:nowrap}.desktop-room-action{margin-left:8px;padding:4px 8px;background:#2f5c86;color:#fff;border-radius:4px}.nav a[data-desktop-settings]{margin-left:4px}\n';
    const output=Buffer.from(contents);generatedFiles.push({path:destination,size:output.length,sha256:sha256(output)});pending.push([destination,output]);
  }
  const manifest={schemaVersion:1,generatorVersion:1,websiteCommit,websiteBaseCommit:baseCommit,sourceFiles,generatedFiles};
  validateManifest(manifest);
  return {inputRoot,manifest,pending};
}

export async function syncWebsite({websiteRoot,outputRoot=path.join(root,'web-source'),websiteCommit=null}={}) {
  const {inputRoot,manifest,pending}=await websiteSnapshot({websiteRoot,websiteCommit});
  if(path.resolve(outputRoot)===inputRoot)throw Error('Source and output must differ');
  await mkdir(outputRoot,{recursive:true});
  for(const [name] of pending) {
    try {if((await lstat(path.join(outputRoot,name))).isSymbolicLink())throw Error('Generated output must not be a symbolic link');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const [name,contents] of pending)await writeFile(path.join(outputRoot,name),contents);
  await writeFile(path.join(outputRoot,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

export async function verifyWebsiteProvenance({websiteRoot,sourceDirectory=path.join(root,'web-source'),websiteCommit}={}) {
  if(websiteCommit===null||websiteCommit===undefined||!validCommit(websiteCommit))throw Error('Website provenance requires a declared full Git commit');
  const actual=JSON.parse(await readFile(path.join(sourceDirectory,'source-manifest.json'),'utf8'));
  await verifySynchronizedSource(sourceDirectory,actual);
  const {manifest:expected}=await websiteSnapshot({websiteRoot,websiteCommit});
  if(actual.websiteCommit!==websiteCommit||actual.websiteBaseCommit!==websiteCommit)throw Error('Website provenance commit does not match the declared source');
  for(const key of ['sourceFiles','generatedFiles']) {
    const sort=list=>[...list].sort((a,b)=>a.path.localeCompare(b.path)).map(file=>[file.path,file.size,file.sha256]);
    if(JSON.stringify(sort(actual[key]))!==JSON.stringify(sort(expected[key])))throw Error('Website provenance '+key+' differs from the declared Git blobs');
  }
  return actual;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), options={};
  let verifyOnly=false;
  while(args.length){const option=args.shift();if(option==='--website-root')options.websiteRoot=args.shift();else if(option==='--website-commit')options.websiteCommit=args.shift();else if(option==='--source-directory')options.sourceDirectory=args.shift();else if(option==='--verify-only')verifyOnly=true;else throw Error('Unknown argument: '+option);}
  if(!verifyOnly&&options.sourceDirectory)throw Error('--source-directory is only valid with --verify-only');
  const manifest=verifyOnly?await verifyWebsiteProvenance(options):await syncWebsite(options);
  console.log((verifyOnly?'Verified website provenance for ':'Synchronized ')+manifest.sourceFiles.length+' explicit website files');
}
