// Stages the built extension and compiles the Windows installer with NSIS.
// Requires: npm run build:extension first, and `makensis` (NSIS 3) on PATH.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const ext = path.join(root, 'dist/extension');
const win = path.join(root, 'installer/windows');
const stage = path.join(root, 'dist/installer-stage');
const outFile = path.join(root, 'dist', `RoundLedger-Setup-${version}.exe`);

if (!fs.existsSync(path.join(ext, 'manifest.json'))) {
  console.error('dist/extension is missing. Run `npm run build:extension` first.');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
if (manifest.version !== version) {
  console.error(`dist/extension is version ${manifest.version} but package.json is ${version}. Rebuild the extension.`);
  process.exit(1);
}
const info = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-info.json'), 'utf8'));
if (!info.backendUrl.startsWith('https://') && process.env.ALLOW_LOCAL_BACKEND !== '1') {
  console.error(`The extension was built for ${info.backendUrl}. Customer installers must point at an https:// backend.\n` +
    'Rebuild with ROUNDLEDGER_BACKEND_URL=https://... or set ALLOW_LOCAL_BACKEND=1 for a test installer.');
  process.exit(1);
}
if (manifest.host_permissions.some((h) => !h.startsWith(new URL(info.backendUrl).origin))) {
  console.error('dist/extension is a test build (extra host permissions). Rebuild it without ROUNDLEDGER_TEST_HOST_PERMISSIONS.');
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(ext, path.join(stage, 'extension'), { recursive: true });
fs.copyFileSync(path.join(win, 'setup-guide.html'), path.join(stage, 'setup-guide.html'));
fs.copyFileSync(path.join(win, 'verify-files.ps1'), path.join(stage, 'verify-files.ps1'));
fs.copyFileSync(path.join(root, 'dist/extension.sha256'), path.join(stage, 'SHA256SUMS.txt'));
fs.writeFileSync(path.join(stage, 'README.txt'), [
  `RoundLedger ${version}`, '',
  'Open setup-guide.html in Google Chrome to finish installation.',
  'The extension files are in the "extension" folder next to this file.',
  `Backend: ${info.backendUrl}`, '',
].join('\r\n'));

execFileSync('makensis', ['-V2', '-INPUTCHARSET', 'UTF8', `-DVERSION=${version}`, `-DSTAGE=${stage}`, `-DOUTFILE=${outFile}`, path.join(win, 'roundledger.nsi')], { stdio: 'inherit', cwd: win });
const hash = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
fs.writeFileSync(outFile + '.sha256', `${hash}  ${path.basename(outFile)}\n`);
console.log(`Installer: ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)\nSHA-256: ${hash}`);
console.log('Not code-signed: Windows SmartScreen will warn until it is signed with an Authenticode certificate.');
