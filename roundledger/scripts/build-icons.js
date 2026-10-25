// Renders branding/logo.svg into the PNG/ICO/BMP assets used by the extension,
// dashboard and Windows installer. Requires Playwright's Chromium and Python Pillow.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const svg = fs.readFileSync(path.join(root, 'branding/logo.svg'), 'utf8');
const tmp = fs.mkdtempSync(path.join(root, '.icons-'));

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(html, w, h, out) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}
const icon = (size) => svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);

fs.mkdirSync(path.join(root, 'extension/icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) await render(icon(size), size, size, path.join(root, `extension/icons/icon${size}.png`));
for (const size of [16, 24, 32, 48, 64, 128, 256]) await render(icon(size), size, size, path.join(tmp, `ico${size}.png`));

const font = 'font-family:Segoe UI,DejaVu Sans,Arial,sans-serif';
await render(`<div style="width:150px;height:57px;background:#05080D;display:flex;align-items:center;gap:8px;padding-left:10px;box-sizing:border-box">
  ${icon(36)}<div style="${font};color:#D7E3EA;font-size:15px;font-weight:600">Round<span style="color:#34F08A">Ledger</span></div></div>`, 150, 57, path.join(tmp, 'header.png'));
await render(`<div style="width:164px;height:314px;background:linear-gradient(#05080D,#0A111B);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;border-right:2px solid #16324A;box-sizing:border-box">
  ${icon(88)}<div style="${font};color:#D7E3EA;font-size:18px;font-weight:600">Round<span style="color:#34F08A">Ledger</span></div>
  <div style="font-family:Consolas,DejaVu Sans Mono,monospace;color:#7C93A3;font-size:10px">round history ledger</div></div>`, 164, 314, path.join(tmp, 'wizard.png'));
await browser.close();

const assets = path.join(root, 'installer/windows/assets');
fs.mkdirSync(assets, { recursive: true });
execFileSync('python3', ['-I', '-c', `
import sys
from PIL import Image
tmp, out = sys.argv[1], sys.argv[2]
sizes = [16, 24, 32, 48, 64, 128, 256]
big = Image.open(f"{tmp}/ico256.png").convert("RGBA")
imgs = [Image.open(f"{tmp}/ico{s}.png").convert("RGBA") for s in sizes]
big.save(f"{out}/roundledger.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs)
for name in ("header", "wizard"):
    Image.open(f"{tmp}/{name}.png").convert("RGB").save(f"{out}/{name}.bmp", format="BMP")
`, tmp, assets], { stdio: 'inherit' });
fs.copyFileSync(path.join(root, 'branding/logo.svg'), path.join(root, 'admin/logo.svg'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Icons written.');
