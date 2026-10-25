import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, verify as verifySignature } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import {
  buildPagePackage, createPageArchive, signManifestPayload, verifyPageManifest, verifyPagePackage
} from './page-package.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const keyId = 'test-release-key';
const now = new Date('2026-10-24T12:00:00.000Z');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = {
  privateKey, keyId, version: '1.0.0', sequence: 1, now,
  createdAt: '2026-10-24T11:00:00.000Z', expiresAt: '2027-10-24T11:00:00.000Z',
  sourceCommits: { desktop: 'a'.repeat(40), website: 'b'.repeat(40) }
};
const entries = [
  { path: 'index.html', data: Buffer.from('<!doctype html><script src="/assets/main.js"></script>') },
  { path: 'assets/main.js', data: Buffer.from('window.ready = true;') }
];

function fixture(archive = createPageArchive(entries), fileEntries = entries) {
  const payload = {
    application: 'org.srvprotianti.desktop', channel: 'stable', version: '1.0.0', sequence: 1,
    bridgeVersion: 1, minAppVersion: '0.2.0', createdAt: options.createdAt, expiresAt: options.expiresAt,
    archive: {
      url: 'https://github.com/301zrg/srvprotianti-desktop/releases/download/pages-v1.0.0/srvprotianti-desktop-pages.zip',
      size: archive.length, sha256: digest(archive), unpackedSize: fileEntries.reduce((n, e) => n + e.data.length, 0)
    },
    files: fileEntries.map(e => ({ path: e.path, size: e.data.length, sha256: digest(e.data) })),
    sourceCommits: options.sourceCommits
  };
  return { archive, payload, manifest: signManifestPayload(payload, { privateKey, keyId }) };
}

function verify(bundle, overrides = {}) {
  return verifyPagePackage({ ...bundle, publicKey: rawPublicKey, keyId, now, ...overrides });
}

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-page-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
  for (const entry of entries) await writeFile(path.join(root, 'dist', entry.path), entry.data);
  return root;
}

test('build emits identical ZIP and signed bytes regardless of file mtime and creation order', async t => {
  const root = await directory(t);
  const first = await buildPagePackage({ ...options, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'out-one') });
  await utimes(path.join(root, 'dist', 'index.html'), 1900000000, 1900000000);
  await rm(path.join(root, 'dist', 'assets/main.js'));
  await writeFile(path.join(root, 'dist', 'assets/main.js'), entries[1].data);
  const second = await buildPagePackage({ ...options, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'out-two') });
  assert.deepEqual(first.archive, second.archive);
  assert.deepEqual(await readFile(first.manifestPath), await readFile(second.manifestPath));
  assert.equal(path.basename(first.archivePath), 'srvprotianti-desktop-pages.zip');
  assert.equal(path.basename(first.manifestPath), 'stable.json');
  assert.equal(verify(first).version, '1.0.0');
});

test('an independent ZIP reader sees exactly the sorted frontend files with valid CRCs', async () => {
  const bundle = fixture();
  const decoded = await JSZip.loadAsync(bundle.archive, { checkCRC32: true });
  assert.deepEqual(Object.keys(decoded.files), ['assets/main.js', 'index.html']);
  assert.equal(await decoded.file('assets/main.js').async('string'), 'window.ready = true;');
  assert.equal(decoded.file('stable.json'), null);
  const message = Buffer.concat([Buffer.from('srvprotianti-desktop-pages-v1\0'), Buffer.from(bundle.manifest.payload, 'base64')]);
  assert.ok(verifySignature(null, message, publicKey, Buffer.from(bundle.manifest.signature, 'base64')));
});

test('archive creation rejects traversal, Windows aliases, private config, resources, and executable types', () => {
  for (const filePath of ['../index.html', '/index.html', 'assets\\x.js', 'assets//x.js', 'assets/CON.txt', 'assets/x..', 'assets/x%20.js', 'assets/é.js', '.git/x.js', 'scripts/x.js', 'config.json', 'settings.json', 'assets/secret.txt', 'ygopro/card.json', 'script/c123.lua', 'cards.cdb', 'tool.exe']) {
    assert.throws(() => createPageArchive([{ path: filePath, data: Buffer.from('bad') }]), /path|file|type|asset|config|resource/i, filePath);
  }
});

test('archive creation rejects case-insensitive duplicates and embedded PEM private keys', () => {
  assert.throws(() => createPageArchive([...entries, { path: 'ASSETS/main.js', data: Buffer.from('other') }]), /duplicate/i);
  assert.throws(() => createPageArchive([{ path: 'index.html', data: Buffer.from('-----BEGIN PRIVATE KEY-----\nnever publish') }]), /private key/i);
});

test('filesystem input rejects symlinks instead of following them into a package', async t => {
  const root = await directory(t);
  await mkdir(path.join(root, 'outside'));
  await writeFile(path.join(root, 'outside', 'hidden.js'), 'private');
  await symlink(path.join(root, 'outside'), path.join(root, 'dist', 'linked'), 'junction');
  await assert.rejects(buildPagePackage({ ...options, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'out') }), /link/i);
});

test('build refuses output inside dist and oversized files before publishing artifacts', async t => {
  const root = await directory(t);
  await assert.rejects(buildPagePackage({ ...options, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'dist', 'packages') }), /output/i);
  await writeFile(path.join(root, 'dist', 'assets', 'large.js'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(buildPagePackage({ ...options, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'out') }), /size|limit/i);
});

test('signature verification rejects changed payload bytes, wrong key IDs, and truncated signatures', () => {
  const bundle = fixture();
  const changed = structuredClone(bundle.manifest);
  changed.payload = Buffer.from(Buffer.from(changed.payload, 'base64').toString().replace('stable', 'beta')).toString('base64');
  assert.throws(() => verify({ ...bundle, manifest: changed }), /signature/i);
  assert.throws(() => verify(bundle, { keyId: 'untrusted-key' }), /key/i);
  assert.throws(() => verify({ ...bundle, manifest: { ...bundle.manifest, signature: 'AA==' } }), /signature/i);
});

test('trusted signatures still reject incompatible metadata, stale sequence, and bad sources', () => {
  const bundle = fixture();
  const changes = [
    { application: 'another.application' }, { channel: 'beta' }, { version: '01.0.0' }, { version: '1.0.0-beta' }, { version: '1.0.0+build' },
    { sequence: 0 }, { bridgeVersion: 2 }, { minAppVersion: '0.3.0' },
    { createdAt: '2026-10-24T14:00:00.000Z' }, { expiresAt: '2026-10-24T11:30:00.000Z' },
    { sourceCommits: { desktop: 'dirty', website: 'b'.repeat(40) } }
  ];
  for (const change of changes) {
    const payload = { ...bundle.payload, ...change };
    if (change.version) payload.archive = { ...payload.archive, url: `https://github.com/301zrg/srvprotianti-desktop/releases/download/pages-v${change.version}/srvprotianti-desktop-pages.zip` };
    const manifest = signManifestPayload(payload, { privateKey, keyId });
    assert.throws(() => verify({ ...bundle, manifest }), /application|channel|version|sequence|bridge|time|expired|source|commit/i, JSON.stringify(change));
  }
  assert.throws(() => verify(bundle, { minSequence: 1 }), /sequence/i);
  const wrongURL = { ...bundle.payload, archive: { ...bundle.payload.archive, url: 'http://example.com/pages.zip' } };
  assert.throws(() => verify({ ...bundle, manifest: signManifestPayload(wrongURL, { privateKey, keyId }) }), /url|source/i);
});

test('archive hashes reject corrupted or truncated downloads', () => {
  const bundle = fixture();
  const damaged = Buffer.from(bundle.archive);
  damaged[40] ^= 1;
  assert.throws(() => verify({ ...bundle, archive: damaged }), /hash/i);
  assert.throws(() => verify({ ...bundle, archive: bundle.archive.subarray(0, -8) }), /size|length/i);
});

test('even freshly signed truncated ZIPs and ZIP entries missing from the file list are rejected', () => {
  const bundle = fixture();
  const truncated = bundle.archive.subarray(0, -8);
  const payload = { ...bundle.payload, archive: { ...bundle.payload.archive, size: truncated.length, sha256: digest(truncated) } };
  assert.throws(() => verify({ archive: truncated, manifest: signManifestPayload(payload, { privateKey, keyId }) }), /zip|archive/i);
  const missing = { ...bundle.payload, files: bundle.payload.files.filter(f => f.path === 'index.html') };
  assert.throws(() => verify({ ...bundle, manifest: signManifestPayload(missing, { privateKey, keyId }) }), /file|size|archive/i);
});

test('signed hashes do not bypass ZIP path, duplicate, link, or per-file checks', async () => {
  for (const invalid of ['../evil.js', 'ASSETS/main.js', 'assets/link.js']) {
    const zip = new JSZip();
    zip.file('index.html', entries[0].data);
    zip.file('assets/main.js', entries[1].data, { createFolders: false });
    zip.file(invalid, 'bad', { createFolders: false, ...(invalid.endsWith('link.js') ? { unixPermissions: 0o120777 } : {}) });
    const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    const bundle = fixture(archive);
    assert.throws(() => verify(bundle), invalid.startsWith('..') ? /path/i : invalid.startsWith('ASSETS') ? /duplicate/i : /link/i, invalid);
  }
  const bundle = fixture();
  const wrongFile = structuredClone(bundle.payload);
  wrongFile.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => verify({ ...bundle, manifest: signManifestPayload(wrongFile, { privateKey, keyId }) }), /hash/i);
});

test('a signed ZIP cannot grant executable permissions to frontend assets', async () => {
  const zip = new JSZip();
  zip.file('index.html', entries[0].data, { unixPermissions: 0o100755 });
  zip.file('assets/main.js', entries[1].data, { createFolders: false });
  const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', createFolders: false });
  assert.throws(() => verify(fixture(archive)), /executable/i);
});

test('signed metadata rejects oversized archives, expanded totals, file counts, and ambiguous paths', () => {
  const bundle = fixture();
  const rejected = [
    { ...bundle.payload, archive: { ...bundle.payload.archive, size: 20 * 1024 * 1024 + 1 } },
    { ...bundle.payload, files: [{ path: 'index.html', size: 5 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) }] },
    { ...bundle.payload, files: Array.from({ length: 11 }, (_, i) => ({ path: i ? `assets/${i}.js` : 'index.html', size: 5 * 1024 * 1024, sha256: 'a'.repeat(64) })) },
    { ...bundle.payload, files: Array.from({ length: 4097 }, (_, i) => ({ path: i ? `assets/${i}.js` : 'index.html', size: 0, sha256: 'a'.repeat(64) })) },
    { ...bundle.payload, files: [...bundle.payload.files, { ...bundle.payload.files[0], path: 'INDEX.html' }] },
    { ...bundle.payload, files: [{ ...bundle.payload.files[0], path: `assets/${'x'.repeat(240)}.js` }] }
  ];
  for (const payload of rejected) assert.throws(() => verify({ ...bundle, manifest: signManifestPayload(payload, { privateKey, keyId }) }), /size|limit|duplicate|path/i);
});

test('builder normalizes source-commit property order in signed output', async t => {
  const root = await directory(t);
  const first = await buildPagePackage({ ...options, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'first') });
  const second = await buildPagePackage({ ...options, sourceCommits: { website: 'b'.repeat(40), desktop: 'a'.repeat(40) }, distDir: path.join(root, 'dist'), outputDir: path.join(root, 'second') });
  assert.deepEqual(first.manifest, second.manifest);
});

test('CLI builds and verifies detached outputs and refuses keys located in dist without logging key bytes', async t => {
  const root = await directory(t);
  const keyFile = path.join(root, 'signing.pem'), trustedFile = path.join(root, 'trusted.json');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(keyFile, pem);
  await writeFile(trustedFile, JSON.stringify({ keyId, publicKey: rawPublicKey }));
  const common = [
    'scripts/page-package.mjs', 'build', '--dist', path.join(root, 'dist'), '--out', path.join(root, 'output'),
    '--key-id', keyId, '--version', '1.0.0', '--sequence', '1',
    '--created-at', new Date(Date.now() - 1000).toISOString(), '--expires-at', new Date(Date.now() + 86400000).toISOString(),
    '--desktop-commit', 'a'.repeat(40), '--website-commit', 'b'.repeat(40)
  ];
  const built = JSON.parse(execFileSync(process.execPath, [...common, '--private-key', keyFile], { encoding: 'utf8' }));
  assert.equal(built.files, 2);
  const checked = JSON.parse(execFileSync(process.execPath, ['scripts/page-package.mjs', 'verify', '--manifest', built.manifestPath, '--archive', built.archivePath, '--public-key', trustedFile], { encoding: 'utf8' }));
  assert.equal(checked.verified, true);
  await writeFile(path.join(root, 'dist', 'signing.pem'), pem);
  const refused = spawnSync(process.execPath, [...common, '--private-key', path.join(root, 'dist', 'signing.pem')], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /outside/i);
  assert.ok(!refused.stderr.includes(pem) && !refused.stdout.includes(pem));
});

test('CLI refuses a signing key reached through a symlinked publish directory', async t => {
  const root = await directory(t);
  const privateDir = path.join(root, 'private');
  await mkdir(privateDir);
  await writeFile(path.join(privateDir, 'signing.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await symlink(privateDir, path.join(root, 'publish'), 'junction');
  const result = spawnSync(process.execPath, [
    'scripts/page-package.mjs', 'build', '--dist', path.join(root, 'dist'), '--out', path.join(root, 'publish'),
    '--private-key', path.join(privateDir, 'signing.pem'), '--key-id', keyId, '--version', '1.0.0', '--sequence', '1',
    '--created-at', new Date(Date.now() - 1000).toISOString(), '--expires-at', new Date(Date.now() + 86400000).toISOString(),
    '--desktop-commit', 'a'.repeat(40), '--website-commit', 'b'.repeat(40)
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside/i);
});

test('renamed native executable bytes cannot be packaged as a frontend asset', () => {
  for (const data of [Buffer.from('MZ executable'), Buffer.from('\x7fELF executable')]) {
    assert.throws(() => createPageArchive([{ path: 'index.html', data }]), /executable/i);
  }
});

test('unknown signed fields are rejected consistently with the native schema', () => {
  const bundle = fixture();
  const changes = [
    { ...bundle.payload, anotherField: true },
    { ...bundle.payload, archive: { ...bundle.payload.archive, anotherField: true } },
    { ...bundle.payload, sourceCommits: { ...bundle.payload.sourceCommits, anotherField: true } },
    { ...bundle.payload, files: bundle.payload.files.map(file => ({ ...file, anotherField: true })) }
  ];
  for (const payload of changes) assert.throws(() => verify({ ...bundle, manifest: signManifestPayload(payload, { privateKey, keyId }) }), /field|schema/i);
  assert.throws(() => verify({ ...bundle, manifest: { ...bundle.manifest, anotherField: true } }), /field|schema/i);
});

test('manifest-only verification authenticates source metadata without needing archive bytes', () => {
  const bundle = fixture();
  const verified = verifyPageManifest({ manifest: bundle.manifest, publicKey: rawPublicKey, keyId, now });
  assert.equal(verified.sourceCommits.desktop, 'a'.repeat(40));
  const manifest = { ...bundle.manifest, signature: Buffer.alloc(64).toString('base64') };
  assert.throws(() => verifyPageManifest({ manifest, publicKey: rawPublicKey, keyId, now }), /signature/i);
  const bad = { ...bundle.payload, sourceCommits: { desktop: 'a'.repeat(40) + '\nsourceCommit=evil', website: 'b'.repeat(40) } };
  assert.throws(() => verifyPageManifest({ manifest: signManifestPayload(bad, { privateKey, keyId }), publicKey: rawPublicKey, keyId, now }), /source|commit/i);
});

function syntheticProvenance() {
  const paths = ['intro.html', 'rooms.html', 'replays.html', 'ladder.html', 'deck-stats.html', 'player-stats.html', 'usage-stats.html', 'deck-detail.html', 'assets/common.css', 'assets/site-shell.js', 'assets/stats-export.js', 'assets/stats-workbook.js', 'assets/exceljs-4.4.0.min.js', 'assets/player-duel-stats.js', 'assets/deck-card-usage.js', 'assets/rating-rules.js'];
  return {
    schemaVersion: 1, generatorVersion: 1, websiteCommit: 'b'.repeat(40), websiteBaseCommit: 'b'.repeat(40),
    sourceFiles: paths.map(path => ({ path, size: 1, sha256: digest('x') })),
    generatedFiles: paths.map(path => ({ path: path.replace(/^assets\//, ''), size: 1, sha256: digest('x') }))
  };
}

function provenanceBundle(provenance) {
  const fileEntries = [...entries, { path: 'source-manifest.json', data: Buffer.from(typeof provenance === 'string' ? provenance : JSON.stringify(provenance)) }];
  return fixture(createPageArchive(fileEntries), fileEntries);
}

test('production verification requires a source declaration while generic fixtures may omit it', () => {
  assert.equal(verify(fixture()).version, '1.0.0');
  assert.throws(() => verify(fixture(), { requireSourceManifest: true }), /source|provenance/i);
  assert.equal(verify(provenanceBundle(syntheticProvenance()), { requireSourceManifest: true }).sourceCommits.website, 'b'.repeat(40));
});

test('signed packages reject null, different, incomplete, and malformed website provenance declarations', () => {
  const good = syntheticProvenance();
  const changes = [
    { websiteCommit: null, websiteBaseCommit: null },
    { websiteCommit: 'c'.repeat(40), websiteBaseCommit: 'c'.repeat(40) },
    { websiteBaseCommit: 'c'.repeat(40) }, { schemaVersion: 2 },
    { sourceFiles: good.sourceFiles.slice(1) },
    { generatedFiles: [...good.generatedFiles.slice(1), good.generatedFiles[1]] },
    { generatedFiles: good.generatedFiles.map(file => ({ ...file, sha256: 'bad' })) },
    { extraField: 'not a complete known schema' }
  ];
  for (const change of changes) assert.throws(() => verify(provenanceBundle({ ...good, ...change })), /source|provenance|commit|schema|hash|file/i);
  assert.throws(() => verify(provenanceBundle('{malformed JSON')), /source|provenance|json/i);
});

test('build checks website provenance before writing any package artifacts', async t => {
  const root = await directory(t), outputDir = path.join(root, 'out');
  const distDir = path.join(root, 'dist');
  await assert.rejects(buildPagePackage({ ...options, distDir, outputDir, requireSourceManifest: true }), /source|provenance/i);
  await writeFile(path.join(distDir, 'source-manifest.json'), JSON.stringify({ ...syntheticProvenance(), websiteCommit: null }));
  await assert.rejects(buildPagePackage({ ...options, distDir, outputDir }), /source|provenance|commit/i);
  await assert.rejects(readFile(path.join(outputDir, 'stable.json')), { code: 'ENOENT' });
  await writeFile(path.join(distDir, 'source-manifest.json'), JSON.stringify(syntheticProvenance()));
  const built = await buildPagePackage({ ...options, distDir, outputDir, requireSourceManifest: true });
  assert.equal(verify(built, { requireSourceManifest: true }).files.length, 3);
});
