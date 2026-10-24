import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const PAGE_PACKAGE_LIMITS = Object.freeze({
  archiveSize: 20 * 1024 * 1024, unpackedSize: 50 * 1024 * 1024,
  fileSize: 5 * 1024 * 1024, files: 4096, manifestSize: 1024 * 1024, pathBytes: 240
});
export const PAGE_ARCHIVE_NAME = 'srvprotianti-desktop-pages.zip';
const DOMAIN = Buffer.from('srvprotianti-desktop-pages-v1\0');
const APPLICATION = 'org.srvprotianti.desktop';
const EXTENSIONS = new Set('html css js mjs json png jpg jpeg gif svg webp ico avif woff woff2 ttf otf eot txt webmanifest map'.split(' '));
const RESOURCE_DIRS = new Set('private config game games ygopro script scripts expansions replay replays deck decks database db card cards resources node_modules'.split(' '));
const CONFIG_FILES = new Set('config.json settings.json account.json accounts.json player.json players.json userdata.json key.json tauri.conf.json package.json package-lock.json tsconfig.json cargo.json'.split(' '));
const WEBSITE_SOURCE_FILES = [
  ...'intro rooms replays ladder deck-stats player-stats usage-stats deck-detail'.split(' ').map(name => `${name}.html`),
  ...'common.css site-shell.js stats-export.js stats-workbook.js exceljs-4.4.0.min.js player-duel-stats.js rating-rules.js'.split(' ').map(name => `assets/${name}`)
];
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const archiveURL = version => `https://github.com/301zrg/srvprotianti-desktop/releases/download/pages-v${version}/${PAGE_ARCHIVE_NAME}`;
const fail = message => { throw new Error(message); };

function boundedInteger(value, maximum, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} size or value exceeds limit`);
  return value;
}

function exactFields(value, fields, label) {
  const expected = fields.split(' ');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(field => !Object.hasOwn(value, field))) fail(`${label} schema has missing or unknown fields`);
}

function validPath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > PAGE_PACKAGE_LIMITS.pathBytes || !/^[A-Za-z0-9_./-]+$/.test(value)) fail('Invalid asset path');
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment || segment.startsWith('.') || segment.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail('Unsafe asset path');
  }
  if (segments.slice(0, -1).some(segment => RESOURCE_DIRS.has(segment.toLowerCase()))) fail('Resource directory is not a page asset');
  const name = segments.at(-1).toLowerCase();
  if (CONFIG_FILES.has(name) || /secret|credential|private[-_.]?key|id_rsa|id_ed25519|password/i.test(name)) fail('Private config file is not a page asset');
  if (!EXTENSIONS.has(name.split('.').at(-1))) fail('File type is not a frontend asset');
  return value;
}

function checkData(data) {
  boundedInteger(data.length, PAGE_PACKAGE_LIMITS.fileSize, 'File');
  if (data.subarray(0, 2).equals(Buffer.from('MZ')) || data.subarray(0, 4).equals(Buffer.from('\x7fELF'))) fail('Native executable bytes are not frontend assets');
  if (PRIVATE_KEY.test(data.toString('utf8'))) fail('Page asset contains a private key');
}

function validateFiles(files) {
  if (!Array.isArray(files)) fail('Missing page file list');
  boundedInteger(files.length, PAGE_PACKAGE_LIMITS.files, 'File count', 1);
  const names = new Set();
  let total = 0;
  for (const file of files) {
    exactFields(file, 'path size sha256', 'File');
    validPath(file.path);
    const insensitive = file.path.toLowerCase();
    if (names.has(insensitive)) fail('Duplicate page file path');
    names.add(insensitive);
    total += boundedInteger(file.size, PAGE_PACKAGE_LIMITS.fileSize, 'File');
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) fail('Invalid file hash');
  }
  if (!names.has('index.html') || !files.some(file => file.path === 'index.html')) fail('Page files require index.html');
  return boundedInteger(total, PAGE_PACKAGE_LIMITS.unpackedSize, 'Unpacked archive', 1);
}

function semver(value) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match.slice(1, 4).some(n => !Number.isSafeInteger(Number(n))) || (match[4] || '').split('.').some(n => /^0\d+$/.test(n))) fail('Invalid semantic version');
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
}

function compareVersions(a, b) {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i], right = y.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (/^\d+$/.test(left) !== /^\d+$/.test(right)) return /^\d+$/.test(left) ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function utcTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail('Invalid UTC time');
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== (value.includes('.') ? value : value.replace(/Z$/, '.000Z'))) fail('Invalid UTC time');
  return result;
}

function validatePayload(payload, { now, appVersion, bridgeVersion, minSequence }) {
  exactFields(payload, 'application channel version sequence bridgeVersion minAppVersion createdAt expiresAt archive files sourceCommits', 'Payload');
  if (!payload || payload.application !== APPLICATION) fail('Wrong application');
  if (payload.channel !== 'stable') fail('Wrong page channel');
  semver(payload.version);
  if (/[+-]/.test(payload.version)) fail('Stable page version cannot have prerelease or build identifiers');
  boundedInteger(payload.sequence, Number.MAX_SAFE_INTEGER, 'Sequence', 1);
  if (payload.sequence <= minSequence) fail('Page sequence is stale');
  if (payload.bridgeVersion !== bridgeVersion) fail('Incompatible bridge version');
  if (compareVersions(appVersion, payload.minAppVersion) < 0) fail('Application version is too old');
  const created = utcTime(payload.createdAt), expires = utcTime(payload.expiresAt);
  const current = new Date(now).getTime();
  if (!Number.isFinite(current) || created > current + 300000 || created >= expires) fail('Invalid page time range');
  if (current >= expires) fail('Page manifest has expired');
  exactFields(payload.sourceCommits, 'desktop website', 'Source commits');
  if (!/^[0-9a-f]{40}$/.test(payload.sourceCommits.desktop) || !/^[0-9a-f]{40}$/.test(payload.sourceCommits.website)) fail('Invalid source commits');
  const total = validateFiles(payload.files);
  exactFields(payload.archive, 'url size sha256 unpackedSize', 'Archive');
  if (payload.archive.url !== archiveURL(payload.version)) fail('Invalid archive URL source');
  boundedInteger(payload.archive.size, PAGE_PACKAGE_LIMITS.archiveSize, 'Archive', 22);
  if (!/^[0-9a-f]{64}$/.test(payload.archive.sha256)) fail('Invalid archive hash');
  if (payload.archive.unpackedSize !== total) fail('Unpacked archive size differs from file list');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// Store-only ZIPs have fixed metadata and no compressor-version dependency.
export function createPageArchive(entries) {
  const sorted = entries.map(entry => ({ path: validPath(entry.path), data: Buffer.from(entry.data) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  validateFiles(sorted.map(entry => ({ path: entry.path, size: entry.data.length, sha256: sha256(entry.data) })));
  const local = [], central = [];
  let offset = 0;
  for (const entry of sorted) {
    checkData(entry.data);
    const name = Buffer.from(entry.path), crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(entry.data.length, 20); record.writeUInt32LE(entry.data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0x81a40000, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...local, directory, end]);
  boundedInteger(archive.length, PAGE_PACKAGE_LIMITS.archiveSize, 'Archive');
  return archive;
}

function readPageArchive(archive) {
  const end = archive.length - 22;
  const range = (start, length, limit = archive.length) => { if (start < 0 || length < 0 || start + length > limit) fail('Truncated ZIP archive'); };
  range(end, 22);
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 20)) fail('Invalid ZIP archive ending');
  const count = archive.readUInt16LE(end + 10), start = archive.readUInt32LE(end + 16);
  boundedInteger(count, PAGE_PACKAGE_LIMITS.files, 'ZIP file count', 1);
  if (count !== archive.readUInt16LE(end + 8) || start + archive.readUInt32LE(end + 12) !== end) fail('Invalid ZIP directory size');
  const result = [], names = new Set();
  let cursor = start, localCursor = 0, total = 0, sourceManifest;
  for (let i = 0; i < count; i++) {
    range(cursor, 46, end);
    if (archive.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid ZIP directory entry');
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16), compressed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24);
    const nameSize = archive.readUInt16LE(cursor + 28), extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32);
    const attrs = archive.readUInt32LE(cursor + 38), offset = archive.readUInt32LE(cursor + 42);
    range(cursor + 46, nameSize + extra + comment, end);
    const filenameBytes = archive.subarray(cursor + 46, cursor + 46 + nameSize);
    if (filenameBytes.some(byte => byte > 127)) fail('Invalid ZIP path encoding');
    const filename = validPath(filenameBytes.toString('ascii'));
    if (names.has(filename.toLowerCase())) fail('Duplicate ZIP file path');
    names.add(filename.toLowerCase());
    const mode = (attrs >>> 16) & 0xf000;
    if ((mode && mode !== 0x8000) || (attrs & 0x10)) fail('ZIP links and special files are forbidden');
    if ((attrs >>> 16) & 0o111) fail('ZIP executable files are forbidden');
    if ((flags & ~0x800) || ![0, 8].includes(method) || archive.readUInt16LE(cursor + 34) || offset !== localCursor) fail('Unsupported ZIP file layout');
    boundedInteger(size, PAGE_PACKAGE_LIMITS.fileSize, 'ZIP file');
    total += size; boundedInteger(total, PAGE_PACKAGE_LIMITS.unpackedSize, 'ZIP unpacked');
    range(offset, 30, start);
    if (archive.readUInt32LE(offset) !== 0x04034b50 || archive.readUInt16LE(offset + 6) !== flags || archive.readUInt16LE(offset + 8) !== method || archive.readUInt32LE(offset + 14) !== crc || archive.readUInt32LE(offset + 18) !== compressed || archive.readUInt32LE(offset + 22) !== size || archive.readUInt16LE(offset + 26) !== nameSize) fail('ZIP local file header mismatch');
    const localExtra = archive.readUInt16LE(offset + 28), dataStart = offset + 30 + nameSize + localExtra;
    range(offset + 30, nameSize + localExtra, start); range(dataStart, compressed, start);
    if (!filenameBytes.equals(archive.subarray(offset + 30, offset + 30 + nameSize))) fail('ZIP local path mismatch');
    const packed = archive.subarray(dataStart, dataStart + compressed);
    let data;
    try { data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) }); }
    catch { fail('Invalid or oversized compressed ZIP data'); }
    if (data.length !== size || crc32(data) !== crc) fail('ZIP file size or CRC mismatch');
    checkData(data);
    if (filename.toLowerCase() === 'source-manifest.json') {
      if (filename !== 'source-manifest.json') fail('Source provenance filename must use its canonical lowercase path');
      sourceManifest = data;
    }
    result.push({ path: filename, size, sha256: sha256(data) });
    localCursor = dataStart + compressed; cursor += 46 + nameSize + extra + comment;
  }
  if (cursor !== end || localCursor !== start) fail('ZIP archive has unlisted data');
  return { files: result, sourceManifest };
}

function validateSourceManifest(bytes, websiteCommit) {
  boundedInteger(bytes.length, PAGE_PACKAGE_LIMITS.manifestSize, 'Source provenance', 1);
  let provenance;
  try { provenance = JSON.parse(bytes); } catch { fail('Source provenance JSON is invalid'); }
  exactFields(provenance, 'schemaVersion generatorVersion websiteCommit websiteBaseCommit sourceFiles generatedFiles', 'Source provenance');
  if (provenance.schemaVersion !== 1 || provenance.generatorVersion !== 1) fail('Unsupported source provenance schema');
  if (provenance.websiteCommit !== websiteCommit || provenance.websiteBaseCommit !== websiteCommit) fail('Source provenance website commit differs from signed website commit');
  for (const [files, paths] of [[provenance.sourceFiles, WEBSITE_SOURCE_FILES], [provenance.generatedFiles, WEBSITE_SOURCE_FILES.map(filename => filename.replace(/^assets\//, ''))]]) {
    if (!Array.isArray(files) || files.length !== paths.length) fail('Source provenance file list is incomplete');
    const expected = new Set(paths);
    for (const file of files) {
      exactFields(file, 'path size sha256', 'Source provenance file');
      if (!expected.delete(file.path)) fail('Source provenance contains unexpected or duplicate files');
      boundedInteger(file.size, PAGE_PACKAGE_LIMITS.fileSize, 'Source provenance file');
      if (!/^[0-9a-f]{64}$/.test(file.sha256)) fail('Invalid source provenance file hash');
    }
  }
}

function base64(value, length, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(`Invalid ${label} base64`);
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64') !== value || (length !== undefined && data.length !== length)) fail(`Invalid ${label} length`);
  return data;
}

export function signManifestPayload(payload, { privateKey, keyId }) {
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) fail('Invalid signing key ID');
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') fail('Signing requires an Ed25519 private key');
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { schemaVersion: 1, keyId, payload: bytes.toString('base64'), signature: sign(null, Buffer.concat([DOMAIN, bytes]), key).toString('base64') };
  boundedInteger(Buffer.byteLength(JSON.stringify(envelope)), PAGE_PACKAGE_LIMITS.manifestSize, 'Manifest');
  return envelope;
}

export function verifyPageManifest({ manifest, publicKey, keyId, now = new Date(), appVersion = '0.2.0', bridgeVersion = 1, minSequence = 0 }) {
  const manifestBytes = typeof manifest === 'string' || Buffer.isBuffer(manifest) ? Buffer.from(manifest) : Buffer.from(JSON.stringify(manifest));
  boundedInteger(manifestBytes.length, PAGE_PACKAGE_LIMITS.manifestSize, 'Manifest', 1);
  let envelope;
  try { envelope = JSON.parse(manifestBytes); } catch { fail('Invalid manifest JSON'); }
  exactFields(envelope, 'schemaVersion keyId payload signature', 'Envelope');
  if (envelope?.schemaVersion !== 1 || envelope.keyId !== keyId) fail('Untrusted manifest schema or key ID');
  const bytes = base64(envelope.payload, undefined, 'payload'), signature = base64(envelope.signature, 64, 'signature');
  const rawKey = typeof publicKey === 'string' ? base64(publicKey, 32, 'public key') : Buffer.from(publicKey);
  if (rawKey.length !== 32) fail('Invalid public key length');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' });
  if (!verify(null, Buffer.concat([DOMAIN, bytes]), key, signature)) fail('Invalid manifest signature');
  let payload;
  try { payload = JSON.parse(bytes); } catch { fail('Invalid signed payload JSON'); }
  boundedInteger(minSequence, Number.MAX_SAFE_INTEGER, 'Minimum sequence');
  validatePayload(payload, { now, appVersion, bridgeVersion, minSequence });
  return payload;
}

export function verifyPagePackage({ archive, requireSourceManifest = false, ...options }) {
  const payload = verifyPageManifest(options);
  archive = Buffer.from(archive);
  if (archive.length !== payload.archive.size) fail('Archive download size mismatch');
  if (sha256(archive) !== payload.archive.sha256) fail('Archive hash mismatch');
  const actual = readPageArchive(archive), expected = new Map(payload.files.map(file => [file.path, file]));
  if (actual.files.length !== expected.size) fail('ZIP file count differs from manifest');
  for (const file of actual.files) {
    const declared = expected.get(file.path);
    if (!declared || declared.size !== file.size || declared.sha256 !== file.sha256) fail('ZIP file hash or size differs from manifest');
  }
  if (actual.sourceManifest) validateSourceManifest(actual.sourceManifest, payload.sourceCommits.website);
  else if (requireSourceManifest) fail('Source provenance manifest is required for publication');
  return payload;
}

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function destinationPath(filename) {
  const absolute = path.resolve(filename);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await destinationPath(path.dirname(absolute)), path.basename(absolute));
  }
}

export async function collectPageEntries(distDir) {
  if ((await lstat(distDir)).isSymbolicLink()) fail('Page dist cannot be a link');
  const entries = [];
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const filename = path.join(directory, name), relative = prefix + name, info = await lstat(filename);
      if (info.isSymbolicLink()) fail('Page assets cannot contain links');
      if (info.isDirectory()) await walk(filename, relative + '/');
      else if (info.isFile()) {
        validPath(relative); boundedInteger(info.size, PAGE_PACKAGE_LIMITS.fileSize, 'File');
        if (info.mode & 0o111) fail('Executable files are not page assets');
        entries.push({ path: relative, data: await readFile(filename) });
        boundedInteger(entries.length, PAGE_PACKAGE_LIMITS.files, 'File count');
      } else fail('Special files are not page assets');
    }
  }
  await walk(distDir);
  return entries;
}

export async function buildPagePackage({ distDir, outputDir, privateKey, keyId, version, sequence, createdAt, expiresAt, sourceCommits, now = new Date(), requireSourceManifest = false }) {
  const dist = await realpath(distDir), output = await destinationPath(outputDir);
  if (inside(dist, output)) fail('Package output must be outside dist');
  const entries = await collectPageEntries(path.resolve(distDir)), archive = createPageArchive(entries);
  const payload = {
    application: APPLICATION, channel: 'stable', version, sequence, bridgeVersion: 1, minAppVersion: '0.2.0', createdAt, expiresAt,
    archive: { url: archiveURL(version), size: archive.length, sha256: sha256(archive), unpackedSize: entries.reduce((sum, entry) => sum + entry.data.length, 0) },
    files: entries.map(entry => ({ path: entry.path, size: entry.data.length, sha256: sha256(entry.data) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    sourceCommits: { desktop: sourceCommits?.desktop, website: sourceCommits?.website }
  };
  const envelope = signManifestPayload(payload, { privateKey, keyId });
  const key = createPublicKey(privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' }).subarray(-32);
  verifyPagePackage({ manifest: envelope, archive, publicKey: key, keyId, now, requireSourceManifest });
  await mkdir(output, { recursive: true });
  if (inside(dist, await realpath(output))) fail('Package output resolves inside dist');
  const archivePath = path.join(output, PAGE_ARCHIVE_NAME), manifestPath = path.join(output, 'stable.json');
  await writeFile(archivePath, archive, { flag: 'wx' });
  await writeFile(manifestPath, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  return { archive, manifest: envelope, payload, archivePath, manifestPath };
}

const USAGE = `Usage:
  node scripts/page-package.mjs build --dist dist --out <directory> --private-key <PKCS8-PEM-file> --key-id <id> --version <semver> --sequence <integer> --created-at <UTC> --expires-at <UTC> --desktop-commit <40hex> --website-commit <40hex>
  node scripts/page-package.mjs verify --manifest <stable.json> --archive <ZIP> --public-key <trusted-key.json> [--min-sequence <integer>] [--app-version <semver>]
Build writes a new output directory's ZIP and detached signed stable.json. Private keys must remain outside dist, output, and release-portable directories.`;

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help') { process.stdout.write(USAGE + '\n'); return; }
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(values, args[i].slice(2))) fail('Invalid or duplicate CLI option');
    values[args[i].slice(2)] = args[i + 1];
  }
  const required = names => { for (const name of names.split(' ')) if (!values[name]) fail(`Missing --${name}`); };
  if (command === 'build') {
    required('dist out private-key key-id version sequence created-at expires-at desktop-commit website-commit');
    const keyPath = await realpath(values['private-key']), dist = await realpath(values.dist), out = await destinationPath(values.out);
    if (inside(dist, keyPath) || inside(out, keyPath) || keyPath.split(path.sep).some(segment => segment.toLowerCase() === 'release-portable')) fail('Private key must remain outside package and portable artifact directories');
    const result = await buildPagePackage({
      distDir: values.dist, outputDir: values.out, privateKey: await readFile(keyPath), keyId: values['key-id'],
      version: values.version, sequence: Number(values.sequence), createdAt: values['created-at'], expiresAt: values['expires-at'],
      sourceCommits: { desktop: values['desktop-commit'], website: values['website-commit'] }
    });
    process.stdout.write(JSON.stringify({ version: result.payload.version, sequence: result.payload.sequence, archivePath: result.archivePath, manifestPath: result.manifestPath, files: result.payload.files.length, sha256: result.payload.archive.sha256 }) + '\n');
  } else if (command === 'verify') {
    required('manifest archive public-key');
    const trusted = JSON.parse(await readFile(values['public-key'], 'utf8'));
    const payload = verifyPagePackage({ manifest: await readFile(values.manifest), archive: await readFile(values.archive), ...trusted, minSequence: Number(values['min-sequence'] || 0), appVersion: values['app-version'] || '0.2.0' });
    process.stdout.write(JSON.stringify({ verified: true, version: payload.version, sequence: payload.sequence, files: payload.files.length, sha256: payload.archive.sha256 }) + '\n');
  } else fail('Unknown page package command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // Never serialize crypto errors, key bytes, CLI arguments, or secret file contents.
    const message = error.code ? 'Page package operation failed while reading or writing a file' : error.message;
    process.stderr.write(`Page package error: ${message}\n`);
    process.exitCode = 1;
  });
}
