import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'src-tauri', 'target', 'release', 'srvprotianti-desktop.exe');
const output = path.join(root, 'release-portable');
await stat(executable);
await mkdir(path.join(output, 'srvprotianti-desktop-data'), { recursive: true });
await copyFile(executable, path.join(output, 'srvprotianti-desktop.exe'));
await copyFile(
  path.join(root, 'src-tauri', 'resources', 'config.default.json'),
  path.join(output, 'srvprotianti-desktop-data', 'config.default.json')
);
await cp(
  path.join(root, 'src-tauri', 'resources', 'environment', '1103-201103-v1'),
  path.join(output, 'srvprotianti-desktop-data', 'resources', '1103-201103-v1'),
  { recursive: true, force: true }
);
console.log('Portable files prepared in ' + output);
