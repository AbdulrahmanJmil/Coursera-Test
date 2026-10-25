import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist/extension');
const build = (env = {}) => spawnSync('node', ['scripts/build-extension.js'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });

test('build succeeds and produces a valid MV3 manifest', () => {
  const r = build({ ROUNDLEDGER_BACKEND_URL: 'https://api.example.com' });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(m.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
  assert.deepEqual(m.host_permissions, ['https://api.example.com/*']);
  assert.deepEqual(m.optional_host_permissions, ['https://*/*'], 'game sites are opt-in at runtime');
  assert.ok(!m.permissions.includes('tabs') && !m.permissions.includes('webRequest'), 'no broad permissions');
  assert.ok(m.key, 'stable extension id');
  for (const f of [m.background.service_worker, m.side_panel.default_path, ...Object.values(m.icons)]) assert.ok(fs.existsSync(path.join(dist, f)), f);
  assert.match(m.content_security_policy.extension_pages, /script-src 'self'/);
});

test('imports in built JS resolve to files in the package', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); })(dist);
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [, spec] of src.matchAll(/(?:import|from)\s+['"](\.[^'"]+)['"]/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), spec)), `${path.relative(dist, f)} → ${spec}`);
    }
    execFileSync('node', ['--check', f]);
  }
});

test('package contains no provider keys or direct provider calls', () => {
  const all = fs.readdirSync(dist, { recursive: true }).filter((f) => /\.(js|json|html)$/.test(f)).map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('\n');
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(all));
  assert.ok(!/generativelanguage\.googleapis/.test(all));
});

test('build refuses a plain-http remote backend', () => {
  const r = build({ ROUNDLEDGER_BACKEND_URL: 'http://api.example.com' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /https/);
  assert.equal(build().status, 0); // restore default build
});
