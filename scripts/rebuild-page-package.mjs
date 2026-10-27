import { lstat, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PAGE_ARCHIVE_NAME, PAGE_PACKAGE_LIMITS, collectPageEntries, createPageArchive,
  verifyPageManifest, verifyPagePackage
} from './page-package.mjs';

async function boundedFile(filename, maximum) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Invalid or oversized manifest/key file');
  const bytes = await readFile(filename);
  if (bytes.length > maximum) throw new Error('Manifest/key file exceeds size limit');
  return bytes;
}

async function verificationInputs({ manifestPath, publicKeyPath }) {
  const [manifest, keyBytes] = await Promise.all([
    boundedFile(manifestPath, PAGE_PACKAGE_LIMITS.manifestSize), boundedFile(publicKeyPath, 4096)
  ]);
  const trusted = JSON.parse(keyBytes);
  return { manifest, publicKey: trusted.publicKey, keyId: trusted.keyId };
}

export async function readVerifiedPageManifest({ manifestPath, publicKeyPath, now, appVersion, bridgeVersion, minSequence }) {
  const inputs = await verificationInputs({ manifestPath, publicKeyPath });
  return verifyPageManifest({ ...inputs, now, appVersion, bridgeVersion, minSequence });
}

async function destinationPath(filename) {
  const absolute = path.resolve(filename);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await destinationPath(path.dirname(absolute)), path.basename(absolute));
  }
}

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function rebuildPagePackage({ distDir, manifestPath, publicKeyPath, outputDir, now, appVersion, bridgeVersion, minSequence }) {
  const inputs = await verificationInputs({ manifestPath, publicKeyPath });
  const options = { ...inputs, now, appVersion, bridgeVersion, minSequence };
  const payload = verifyPageManifest(options);
  const dist = await realpath(distDir), output = await destinationPath(outputDir);
  if (inside(dist, output)) throw new Error('Archive output must be outside dist');
  const entries = await collectPageEntries(path.resolve(distDir));
  const expected = new Set(payload.files.map(file => file.path));
  if (entries.length !== expected.size || entries.some(entry => !expected.has(entry.path))) throw new Error('Dist file list differs from the signed manifest');
  const archive = createPageArchive(entries);
  verifyPagePackage({ ...options, archive });
  await mkdir(output, { recursive: true });
  if (inside(dist, await realpath(output))) throw new Error('Archive output resolves inside dist');
  const archivePath = path.join(output, PAGE_ARCHIVE_NAME);
  try { await writeFile(archivePath, archive, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Immutable archive output already exists');
    throw error;
  }
  return { archivePath, payload };
}

const USAGE = `Usage:
  node scripts/rebuild-page-package.mjs metadata --manifest <signed-stable.json> --public-key <trusted-key.json> [--field desktop|website]
  node scripts/rebuild-page-package.mjs rebuild --dist <built-dist> --manifest <signed-stable.json> --public-key <trusted-key.json> --out <artifact-directory>
Metadata writes only the selected authenticated 40-character source commit (desktop by default). Rebuild needs no signing key and writes a new ZIP only after full verification.`;

async function main([command, ...args]) {
  if (!command || command === '--help') { process.stdout.write(USAGE + '\n'); return; }
  if (!['metadata', 'rebuild'].includes(command)) throw new Error('Unknown reconstruction command');
  const required = command === 'metadata' ? ['manifest', 'public-key'] : ['manifest', 'public-key', 'dist', 'out'];
  const allowed = new Set([...required, ...(command === 'metadata' ? ['field'] : [])]);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(values, key)) throw new Error('Invalid or duplicate reconstruction option');
    values[key] = args[i + 1];
  }
  for (const key of required) if (!values[key]) throw new Error(`Missing --${key}`);
  const options = { manifestPath: values.manifest, publicKeyPath: values['public-key'] };
  if (command === 'metadata') {
    const field = values.field || 'desktop';
    if (!['desktop', 'website'].includes(field)) throw new Error('Unsupported metadata field');
    const payload = await readVerifiedPageManifest(options);
    process.stdout.write(payload.sourceCommits[field] + '\n');
  } else {
    const result = await rebuildPagePackage({ ...options, distDir: values.dist, outputDir: values.out });
    process.stdout.write(JSON.stringify({ verified: true, archivePath: result.archivePath, sourceCommit: result.payload.sourceCommits.desktop, version: result.payload.version, sha256: result.payload.archive.sha256 }) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Page reconstruction error: ${error.code ? 'Unable to read or write a required file' : error.message}\n`);
    process.exitCode = 1;
  });
}
