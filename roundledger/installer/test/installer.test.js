// Packaging test for the Windows installer. Needs `makensis`; uses `7z` (if
// present) to unpack the result. Running the installer itself requires
// Windows and is a manual test (docs/TESTING.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const exe = path.join(root, 'dist', `RoundLedger-Setup-${version}.exe`);

test('installer refuses an extension built for a non-https backend', { skip: !has('makensis') && 'makensis not installed' }, () => {
  assert.equal(spawnSync('node', ['scripts/build-extension.js'], { cwd: root }).status, 0);
  const r = spawnSync('node', ['scripts/build-installer.js'], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_LOCAL_BACKEND: '' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /https/);
});

test('installer builds and contains every extension file', { skip: !has('makensis') && 'makensis not installed' }, () => {
  const r = spawnSync('node', ['scripts/build-installer.js'], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_LOCAL_BACKEND: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const head = fs.readFileSync(exe).subarray(0, 2).toString('latin1');
  assert.equal(head, 'MZ');
  assert.ok(fs.existsSync(exe + '.sha256'));
  if (!has('7z')) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-inst-'));
  assert.equal(spawnSync('7z', ['x', '-y', `-o${out}`, exe]).status, 0);
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/)[1]);
  for (const rel of sums) assert.ok(fs.existsSync(path.join(out, 'extension', rel)), rel);
  for (const f of ['setup-guide.html', 'verify-files.ps1', 'README.txt', 'roundledger.ico']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'extension/manifest.json')));
  assert.equal(manifest.version, version);
  fs.rmSync(out, { recursive: true, force: true });
});

test('NSIS script checks Windows version, Chrome presence and Chrome version', () => {
  const nsi = fs.readFileSync(path.join(root, 'installer/windows/roundledger.nsi'), 'utf8');
  assert.match(nsi, /AtLeastWin10/);
  assert.match(nsi, /Google Chrome was not found/);
  assert.match(nsi, /VersionCompare/);
  assert.match(nsi, /RequestExecutionLevel user/);
  assert.match(nsi, /WriteUninstaller/);
});
