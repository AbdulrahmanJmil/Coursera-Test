// Produces a customer release in dist/release/<version>/.
//   ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run release
// Steps: full automated test suite → production extension build → installer → checksums.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const backend = process.env.ROUNDLEDGER_BACKEND_URL || '';
if (!backend.startsWith('https://')) {
  console.error('Set ROUNDLEDGER_BACKEND_URL to your production https:// backend, e.g.\n  ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run release');
  process.exit(1);
}
const run = (args, env = {}) => execFileSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

if (process.env.SKIP_TESTS !== '1') run(['npm', 'test', '--silent']);
run(['node', 'scripts/build-extension.js'], { ROUNDLEDGER_BACKEND_URL: backend, ROUNDLEDGER_TEST_HOST_PERMISSIONS: '' });
run(['node', 'scripts/build-installer.js']);

const out = path.join(root, 'dist/release', version);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const artifacts = [`RoundLedger-Setup-${version}.exe`, `roundledger-extension-${version}.zip`];
for (const a of artifacts) fs.copyFileSync(path.join(root, 'dist', a), path.join(out, a));
fs.copyFileSync(path.join(root, 'dist/extension.sha256'), path.join(out, 'extension-files.sha256'));
const sums = artifacts.map((a) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, a))).digest('hex')}  ${a}`);
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
const info = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-info.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'RELEASE.md'), `# RoundLedger ${version}

- Backend: ${info.backendUrl}
- Extension ID: ${info.extensionId} (add \`chrome-extension://${info.extensionId}\` to EXTENSION_ORIGINS)
- Built: ${info.builtAt}

| File | SHA-256 |
|---|---|
${sums.map((l) => { const [h, f] = l.split('  '); return `| ${f} | \`${h}\` |`; }).join('\n')}

The installer is **not code-signed**. Sign it with your Authenticode certificate before distribution
(e.g. \`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 RoundLedger-Setup-${version}.exe\`) and
recompute the checksum afterwards.
`);
console.log(`\nRelease ready: ${path.relative(root, out)}`);
