import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function regularFiles(root, prefix = '') {
  const result = [];
  for (const name of readdirSync(path.join(root, prefix)).sort()) {
    const relative = path.posix.join(prefix, name);
    const filename = path.join(root, relative);
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('Release input contains a link');
    if (stat.isDirectory()) result.push(...regularFiles(root, relative));
    else if (stat.isFile()) result.push({path: relative, bytes: stat.size, sha256: sha(readFileSync(filename))});
    else throw new Error('Non-regular release input');
  }
  return result;
}

export function checkPageSnapshot(root) {
  const folder = path.join(root, 'web-source');
  const manifest = JSON.parse(readFileSync(path.join(folder, 'provenance.json'), 'utf8'));
  const files = readdirSync(folder).filter(name => name !== 'provenance.json').sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('Page snapshot inventory changed');
  for (const name of files) {
    const stat = lstatSync(path.join(folder, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid snapshot input');
    const normalized = readFileSync(path.join(folder, name), 'utf8').replace(/\r\n/g, '\n');
    if (sha(normalized) !== manifest.files[name]) throw new Error('Page snapshot changed: ' + name + '; review and refresh provenance');
  }
  return sha(JSON.stringify(manifest));
}

export function releaseDefaults(original, deployment) {
  const config = structuredClone(original);
  if (config.schemaVersion !== 1 || config.player.launchName !== '') throw new Error('Release defaults must not contain a player login');
  if (!deployment) return config;
  const input = deployment.public;
  if (deployment.format !== 1 || !input) throw new Error('Missing public deployment profile');
  const url = new URL(input.apiBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || /[?#\s\\]/.test(input.apiBaseUrl) ||
      !['', '/'].includes(url.pathname) || url.hostname.includes('*')) throw new Error('Production API must be an HTTPS root URL without credentials');
  if (typeof input.gameHost !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(input.gameHost) ||
      input.gameHost.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-')) ||
      !Number.isInteger(input.gamePort) || input.gamePort < 1 || input.gamePort > 65535) throw new Error('Invalid game endpoint');
  config.server = {gameHost: input.gameHost, gamePort: input.gamePort, apiBaseUrl: url.href};
  return config;
}

export function checkEnvironment(folder) {
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.revision !== '1103-201103-v1' || manifest.cardCount !== 5267 || manifest.banlistProtocolHash !== '0x73ec4051') throw new Error('Unreviewed environment revision');
  const expected = new Set(['manifest.json', 'lflist.conf']);
  if (sha(readFileSync(path.join(folder, 'lflist.conf'))) !== manifest.banlistSha256) throw new Error('Banlist checksum mismatch');
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const record = manifest.locales[locale];
    for (const [name, field] of [['cards.cdb', 'cardsSha256'], ['strings.conf', 'stringsSha256']]) {
      const relative = locale + '/' + name;
      expected.add(relative);
      if (sha(readFileSync(path.join(folder, relative))) !== record[field]) throw new Error('Environment checksum mismatch');
    }
  }
  const actual = regularFiles(folder).map(row => row.path);
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw new Error('Unlisted environment input');
}
