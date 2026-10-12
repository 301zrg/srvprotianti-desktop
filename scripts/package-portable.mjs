import { copyFile, cp, mkdir, stat, writeFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {checkPageSnapshot, checkEnvironment, releaseDefaults, regularFiles, sha} from './release-contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'src-tauri', 'target', 'release', 'srvprotianti-desktop.exe');
const {values} = parseArgs({options: {'output':{type:'string'}, 'deployment':{type:'string'}, 'help':{type:'boolean'}}});
if (values.help) {
  console.log('node scripts/package-portable.mjs [--deployment PUBLIC_PROFILE.json] [--output NEW_DIRECTORY]');
  process.exit(0);
}
const output = path.resolve(values.output || path.join(root, 'release-portable'));
const defaults = releaseDefaults(JSON.parse(await readFile(path.join(root, 'src-tauri/resources/config.default.json'), 'utf8')),
  values.deployment ? JSON.parse(await readFile(values.deployment, 'utf8')) : null);
const snapshotSha256 = checkPageSnapshot(root);
const environment = path.join(root, 'src-tauri/resources/environment/1103-201103-v1');
checkEnvironment(environment);
await stat(executable);
try {
  await lstat(output);
  throw new Error('Output already exists; choose --output NEW_DIRECTORY. Existing user data is never packaged.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
for (let parent = path.dirname(output); parent !== path.dirname(parent); parent = path.dirname(parent)) {
  try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Output parent cannot be a link'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(path.join(output, 'srvprotianti-desktop-data'), { recursive: true });
await copyFile(executable, path.join(output, 'srvprotianti-desktop.exe'));
await writeFile(path.join(output, 'srvprotianti-desktop-data/config.default.json'), JSON.stringify(defaults, null, 2) + '\n', {flag:'wx'});
await cp(
  environment,
  path.join(output, 'srvprotianti-desktop-data', 'resources', '1103-201103-v1'),
  { recursive: true, force: true }
);
await writeFile(path.join(output, 'page-snapshot.json'), await readFile(path.join(root, 'web-source/provenance.json')), {flag:'wx'});
await writeFile(path.join(output, 'deployment-info.json'), JSON.stringify({
  format:1, sourceCommit:execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root,encoding:'utf8'}).trim(),
  sourceDirty:Boolean(execFileSync('git', ['status','--porcelain'], {cwd:root,encoding:'utf8'}).trim()),
  productionDefaults:Boolean(values.deployment), version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,
  defaultsSha256:sha(JSON.stringify(defaults)), pageSnapshotSha256:snapshotSha256,
  environmentRevision:'1103-201103-v1', files:regularFiles(output),
  realGameClientValidated:false,
}, null, 2) + '\n', {flag:'wx'});
console.log('Portable files prepared in ' + output);
