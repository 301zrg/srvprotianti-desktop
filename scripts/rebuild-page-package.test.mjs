import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildPagePackage, signManifestPayload } from './page-package.mjs';
import { rebuildPagePackage, readVerifiedPageManifest } from './rebuild-page-package.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'rebuild-fixture';
const source = 'a'.repeat(40);
const trusted = { keyId, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'page-rebuild-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distDir = path.join(root, 'dist');
  await mkdir(path.join(distDir, 'assets'), { recursive: true });
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><script src="/assets/main.js"></script>');
  await writeFile(path.join(distDir, 'assets', 'main.js'), 'window.ready=true;');
  const built = await buildPagePackage({ distDir, outputDir: path.join(root, 'signed'), privateKey, keyId, version: '1.0.0', sequence: 1, createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), sourceCommits: { desktop: source, website: 'b'.repeat(40) } });
  const publicKeyPath = path.join(root, 'trusted.json');
  await writeFile(publicKeyPath, JSON.stringify(trusted));
  return { root, built, distDir, manifestPath: built.manifestPath, publicKeyPath, outputDir: path.join(root, 'rebuilt') };
}

test('reconstruction matches the signed ZIP byte for byte without any private key', async t => {
  const data = await fixture(t), before = await readFile(data.manifestPath);
  const result = await rebuildPagePackage(data);
  assert.deepEqual(await readFile(result.archivePath), data.built.archive);
  assert.equal(result.payload.sourceCommits.desktop, source);
  assert.deepEqual(await readdir(data.outputDir), ['srvprotianti-desktop-pages.zip']);
  assert.deepEqual(await readFile(data.manifestPath), before);
});

test('extra and missing dist files are rejected before an artifact directory is created', async t => {
  const data = await fixture(t);
  await writeFile(path.join(data.distDir, 'assets', 'extra.js'), 'extra');
  await assert.rejects(rebuildPagePackage(data), /file list|extra/i);
  await assert.rejects(stat(data.outputDir), { code: 'ENOENT' });
  await rm(path.join(data.distDir, 'assets', 'extra.js'));
  await rm(path.join(data.distDir, 'assets', 'main.js'));
  await assert.rejects(rebuildPagePackage(data), /file list|missing/i);
  await assert.rejects(stat(data.outputDir), { code: 'ENOENT' });
});

test('symlinked dist entries are rejected before reconstruction', async t => {
  const data = await fixture(t);
  const outside = path.join(data.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'outside.js'), 'never package');
  await symlink(outside, path.join(data.distDir, 'linked'), 'junction');
  await assert.rejects(rebuildPagePackage(data), /link/i);
  await assert.rejects(stat(data.outputDir), { code: 'ENOENT' });
});

test('changed dist contents and incorrect signed archive hashes cannot produce artifacts', async t => {
  const data = await fixture(t);
  await writeFile(path.join(data.distDir, 'assets', 'main.js'), 'window.ready=oops;');
  await assert.rejects(rebuildPagePackage(data), /hash|size/i);
  await assert.rejects(stat(data.outputDir), { code: 'ENOENT' });
  await writeFile(path.join(data.distDir, 'assets', 'main.js'), 'window.ready=true;');
  const payload = { ...data.built.payload, archive: { ...data.built.payload.archive, sha256: '0'.repeat(64) } };
  await writeFile(data.manifestPath, JSON.stringify(signManifestPayload(payload, { privateKey, keyId })));
  await assert.rejects(rebuildPagePackage(data), /hash/i);
  await assert.rejects(stat(data.outputDir), { code: 'ENOENT' });
});

test('invalid signatures are rejected before inspecting dist or exposing source metadata', async t => {
  const data = await fixture(t);
  await writeFile(data.manifestPath, JSON.stringify({ ...data.built.manifest, signature: Buffer.alloc(64).toString('base64') }));
  await assert.rejects(rebuildPagePackage({ ...data, distDir: path.join(data.root, 'does-not-exist') }), /signature/i);
  await assert.rejects(readVerifiedPageManifest(data), /signature/i);
});

test('reconstruction never overwrites artifacts or writes artifacts inside dist', async t => {
  const data = await fixture(t);
  await assert.rejects(rebuildPagePackage({ ...data, outputDir: path.join(data.distDir, 'output') }), /outside|output/i);
  await symlink(data.distDir, path.join(data.root, 'output-link'), 'junction');
  await assert.rejects(rebuildPagePackage({ ...data, outputDir: path.join(data.root, 'output-link') }), /outside|output/i);
  const result = await rebuildPagePackage(data);
  await assert.rejects(rebuildPagePackage(data), /exist|immutable|overwrite/i);
  assert.deepEqual(await readFile(result.archivePath), data.built.archive);
});

test('metadata and rebuild CLIs emit only authenticated metadata and a verified artifact result', async t => {
  const data = await fixture(t);
  const common = ['--manifest', data.manifestPath, '--public-key', data.publicKeyPath];
  const metadata = execFileSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'metadata', ...common], { encoding: 'utf8' });
  assert.equal(metadata, source + '\n');
  const rebuilt = JSON.parse(execFileSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'rebuild', ...common, '--dist', data.distDir, '--out', data.outputDir], { encoding: 'utf8' }));
  assert.equal(rebuilt.verified, true);
  assert.equal(rebuilt.sourceCommit, source);
  assert.deepEqual(await readFile(rebuilt.archivePath), data.built.archive);
  const changed = { ...data.built.payload, sourceCommits: { desktop: source + '\nkey=malicious', website: 'b'.repeat(40) } };
  await writeFile(data.manifestPath, JSON.stringify(signManifestPayload(changed, { privateKey, keyId })));
  const refused = spawnSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'metadata', ...common], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
});

test('metadata CLI selects authenticated website SHA and rejects unsupported fields or invalid signed SHA values', async t => {
  const data = await fixture(t);
  const common = ['--manifest', data.manifestPath, '--public-key', data.publicKeyPath];
  const website = execFileSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'metadata', ...common, '--field', 'website'], { encoding: 'utf8' });
  assert.equal(website, 'b'.repeat(40) + '\n');
  const desktop = execFileSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'metadata', ...common, '--field', 'desktop'], { encoding: 'utf8' });
  assert.equal(desktop, source + '\n');
  const unknown = spawnSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'metadata', ...common, '--field', '__proto__'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  const payload = { ...data.built.payload, sourceCommits: { desktop: source, website: 'b'.repeat(40) + '\nwebsiteCommit=bad' } };
  await writeFile(data.manifestPath, JSON.stringify(signManifestPayload(payload, { privateKey, keyId })));
  const invalid = spawnSync(process.execPath, ['scripts/rebuild-page-package.mjs', 'metadata', ...common, '--field', 'website'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});
