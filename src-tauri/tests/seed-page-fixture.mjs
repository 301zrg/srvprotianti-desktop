// Seed only an isolated smoke game root. The native loader still independently verifies every byte on launch.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { verifyPagePackage } from '../../scripts/page-package.mjs';

const [gameArgument, packageArgument] = process.argv.slice(2);
const game=path.resolve(gameArgument), source=path.resolve(packageArgument);
assert.ok(game.replaceAll('\\','/').includes('/target/native-smoke/'),'only the isolated native smoke fixture may be seeded');
const envelope=await fs.readFile(path.join(source,'stable.json'));
const archive=await fs.readFile(path.join(source,'srvprotianti-desktop-pages.zip'));
const trusted=JSON.parse(await fs.readFile(new URL('../page-update-public-key.json',import.meta.url),'utf8'));
const manifest=verifyPagePackage({manifest:envelope,archive,...trusted});
const root=path.join(game,'srvprotianti-desktop-data','page-packages');
const container=path.join(root,'packages',manifest.version);
await fs.mkdir(container,{recursive:true});
const zip=await JSZip.loadAsync(archive);
for(const file of manifest.files){
  const destination=path.join(container,'dist',file.path);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,await zip.file(file.path).async('nodebuffer'));
}
await fs.writeFile(path.join(container,'manifest.json'),envelope);
const digest=createHash('sha256').update(envelope).digest('hex');
const reference={version:manifest.version,sequence:manifest.sequence,envelopeSha256:digest};
const prior=await fs.readFile(path.join(root,'state.json'),'utf8').then(JSON.parse).catch(()=>({active:null,previous:null,quarantined:[]}));
await fs.writeFile(path.join(root,'state.json'),JSON.stringify({schemaVersion:1,highestSequence:manifest.sequence,highestVersion:manifest.version,highestManifestHash:digest,active:prior.active,pending:reference,previous:prior.previous,booting:null,quarantined:prior.quarantined.filter(item=>item.version!==manifest.version),forceBuiltin:false},null,2));
console.log(JSON.stringify({seeded:true,version:manifest.version,files:manifest.files.length,root}));
