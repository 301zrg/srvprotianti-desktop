import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkPageSnapshot, releaseDefaults, regularFiles, sha} from './release-contract.mjs';

const defaults = {schemaVersion:1,player:{launchName:''},server:{gameHost:'old.host',gamePort:7911,apiBaseUrl:'http://old.host:7922'},game:{executable:'ygopro.exe'},ui:{language:'zh'}};
function removeFixture(root) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.match(path.basename(root), /^desktop-(snapshot|inventory)-/);
  rmSync(root, {recursive:true});
}
test('controlled HTTPS defaults do not mutate repository or user defaults', () => {
  const profile = {format:1,public:{gameHost:'new.host',gamePort:7911,apiBaseUrl:'https://new.host/'}};
  const result = releaseDefaults(defaults, profile);
  assert.equal(result.server.apiBaseUrl, 'https://new.host/');
  assert.equal(defaults.server.apiBaseUrl, 'http://old.host:7922');
  for (const url of ['http://new.host:7922','https://user:secret@new.host','https://new.host/?x=1','https://new.host/api/']) {
    assert.throws(() => releaseDefaults(defaults,{...profile,public:{...profile.public,apiBaseUrl:url}}));
  }
  assert.throws(() => releaseDefaults({...defaults,player:{launchName:'player$private'}},profile));
});
test('page provenance rejects changed pages and unexpected inputs', () => {
  const root = mkdtempSync(path.join(tmpdir(),'desktop-snapshot-'));
  try {
    mkdirSync(path.join(root,'web-source'));
    writeFileSync(path.join(root,'web-source/page.html'),'original\n');
    writeFileSync(path.join(root,'web-source/provenance.json'),JSON.stringify({files:{'page.html':sha('original\n')}}));
    checkPageSnapshot(root);
    writeFileSync(path.join(root,'web-source/page.html'),'changed');
    assert.throws(() => checkPageSnapshot(root));
    writeFileSync(path.join(root,'web-source/config.user.json'),'private');
    assert.throws(() => checkPageSnapshot(root));
  } finally { removeFixture(root); }
});
test('release file inventory includes names and SHA without reading external state', () => {
  const root = mkdtempSync(path.join(tmpdir(),'desktop-inventory-'));
  try {
    writeFileSync(path.join(root,'file'),'bytes');
    assert.deepEqual(regularFiles(root),[{path:'file',bytes:5,sha256:sha('bytes')}]);
  } finally { removeFixture(root); }
});
