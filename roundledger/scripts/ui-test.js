// End-to-end UI test: loads the built extension in Chromium, runs it against a
// real in-process backend, a fake Gemini endpoint and a mocked game page/socket
// that sends SYNTHETIC frames. Screenshots go to dist/ui-test/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createApp } = await import('../server/src/app.js');
const { loadConfig } = await import('../server/src/config.js');
const { createUser } = await import('../server/src/services/auth.js');
const { startFakeGemini } = await import('../server/test/helpers.js');

const PORT = 8787;
const GAME = 'https://game.test';
const shots = path.join(root, 'dist/ui-test');
fs.mkdirSync(shots, { recursive: true });
const W = 360;
const H = 760;
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.log('  ✔', name); }
  catch (err) { results.push(['FAIL', name, err.message]); console.log('  ✖', name, '\n    ', err.message); }
};

execFileSync('node', ['scripts/build-extension.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, ROUNDLEDGER_BACKEND_URL: `http://127.0.0.1:${PORT}`, ROUNDLEDGER_TEST_HOST_PERMISSIONS: `${GAME}/*` } });
const extDir = path.join(root, 'dist/extension');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ui-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium', headless: true, viewport: { width: W, height: H },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const panelUrl = `chrome-extension://${extId}/src/panel/panel.html`;
const panel = await ctx.newPage();
const shot = (name) => panel.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

console.log('Extension', extId);

await step('disconnected state: panel renders with backend offline', async () => {
  await panel.goto(panelUrl);
  await panel.waitForSelector('#authForm');
  await panel.waitForFunction(() => document.querySelector('#pillBackend').className.includes('bad'), null, { timeout: 15000 });
  await shot('01-offline-signin');
  const err = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'login', email: 'a@b.co', password: 'x' })).error.code);
  assert.equal(err, 'OFFLINE');
});

// ---- backend up
const gem = await startFakeGemini();
const config = loadConfig({}, { port: PORT, databasePath: ':memory:', logRequests: false, encryptionKey: crypto.randomBytes(32), geminiBaseUrl: gem.url });
const { server, db } = createApp(config, { log: { info() {}, error: console.error } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const PASSWORD = 'ui-test-password-1';
createUser(db, { email: 'admin@example.com', password: PASSWORD, role: 'admin' });
const adminLogin = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD, client: 'web' }) });
const cookie = adminLogin.headers.get('set-cookie').split(';')[0];
const admin = (method, p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Requested-With': 'RoundLedger' }, body: body && JSON.stringify(body) }).then((r) => r.json());
const plan = await admin('POST', '/api/admin/plans', { code: 'plus', name: 'Monthly Plus', priceCents: 1999, currency: 'USD', durationDays: 30, deviceLimit: 2, features: { aiAnalysis: true, cloudHistory: true }, isActive: true });
const platforms = (await admin('GET', '/api/admin/settings')).platforms;
platforms[0].pageUrlPatterns = [`${GAME}/games-frame/games/371*`];
await admin('PUT', '/api/admin/settings/platforms', { platforms });
await admin('PUT', '/api/admin/ai/gemini/credential', { apiKey: 'AIzaTESTTESTTESTTESTTESTTEST00000' });
await admin('PUT', '/api/admin/ai/gemini', { enabled: true, model: 'test-flash-001', makeActive: true });

await step('registration from the panel, then licence screen', async () => {
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'refresh' }));
  await panel.reload();
  await panel.waitForSelector('#authForm');
  await panel.click('[data-toggle]');
  await panel.fill('input[name=email]', 'player@example.com');
  await panel.fill('input[name=password]', 'player-password-1');
  await panel.click('[data-submit]');
  await panel.waitForSelector('[data-redeem]', { timeout: 15000 });
  await panel.waitForSelector('[data-start-trial]');
  await shot('02-license');
});

await step('activation code unlocks the main view', async () => {
  const codes = await admin('POST', '/api/admin/codes', { planId: plan.id, count: 1 });
  await panel.fill('[data-redeem] input[name=code]', codes.codes[0].code);
  await panel.click('[data-redeem] button');
  await panel.waitForSelector('[data-tabs] button', { timeout: 15000 });
  await panel.waitForFunction(() => document.querySelector('#pillBackend').className.includes('ok'));
  assert.match(await panel.textContent('.empty'), /No rounds recorded yet/);
  assert.match(await panel.textContent('[data-ai-status]'), /does not predict/);
  await shot('03-main-empty');
});

await step('synthetic game frames are observed, de-duplicated and recorded', async () => {
  await ctx.route(`${GAME}/**`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Game (test)</title><p>synthetic test page</p>
    <script>window.sock = new WebSocket('wss://game.test/games-frame/sockets/crash?test=1');</script>` }));
  const frames = [];
  let x = 4242;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 40; i++) {
    const m = Math.max(1, Math.floor((0.97 / (1 - rnd())) * 100) / 100);
    frames.push(`{"type":1,"target":"OnStage","arguments":[{"l":${7000 + i}}]}\u001e`, `{"type":1,"target":"OnBetting","arguments":[{}]}\u001e`,
      `{"type":1,"target":"OnStart","arguments":[{}]}\u001e`, `{"type":1,"target":"OnCrash","arguments":[{"f":${m}}]}\u001e`);
    if (i === 5) frames.push(`{"type":1,"target":"OnCrash","arguments":[{"f":${m}}]}\u001e`); // duplicate crash
  }
  await ctx.routeWebSocket(/sockets\/crash/, (ws) => {
    let i = 0;
    const timer = setInterval(() => { if (i < frames.length) ws.send(frames[i++]); else clearInterval(timer); }, 15);
  });
  const game = await ctx.newPage();
  await game.goto(`${GAME}/games-frame/games/371`);
  const hooked = await game.evaluate(() => window.WebSocket.name);
  assert.equal(hooked, 'ObservedWebSocket', 'page hook must be injected');
  await panel.bringToFront();
  await panel.waitForFunction(() => /^40$/.test(document.querySelector('[data-stats] .cell b')?.textContent || ''), null, { timeout: 20000 });
  assert.match(await panel.textContent('[data-pstatus]'), /Live/);
  assert.match(await panel.textContent('[data-pattern]'), /n=/);
  const consoleText = await panel.textContent('[data-console]');
  assert.match(consoleText, /recorded at/);
  await shot('04-main-live');
  await game.close();
});

await step('rounds sync to the backend', async () => {
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'syncNow' }));
  const n = db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n;
  assert.equal(n, 40);
  const st = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
  assert.equal(st.data.pendingSync, 0, 'local rounds marked synced: ' + JSON.stringify(st.data.lastSync));
  assert.ok(st.data.lastSync?.at);
});

await step('AI explanation through the backend (fake provider)', async () => {
  await panel.click('[data-ai-run]');
  await panel.waitForSelector('[data-ai-out]:not([hidden])', { timeout: 20000 });
  assert.match(await panel.textContent('[data-ai-out]'), /Your rounds look random\..*Not a prediction/s);
  assert.equal(gem.calls.filter((c) => c.method === 'POST').length, 1);
  await shot('05-ai');
});

await step('settings view lists account, devices and diagnostics', async () => {
  await panel.click('#btnSettings');
  await panel.waitForSelector('[data-devices] li .meta');
  assert.match(await panel.textContent('[data-account]'), /Monthly Plus/);
  assert.match(await panel.textContent('[data-devices]'), /this browser/);
  await shot('06-settings');
  await panel.click('[data-back]');
});

await step('backend error handling: subscription revoked server-side', async () => {
  const sub = db.prepare('SELECT id FROM subscriptions LIMIT 1').get();
  await admin('PATCH', `/api/admin/subscriptions/${sub.id}`, { status: 'revoked' });
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'refresh' }));
  await panel.waitForSelector('[data-redeem]', { timeout: 10000 });
  assert.match(await panel.textContent('[data-state]'), /revoked/);
  await shot('07-revoked');
});

await step('no horizontal overflow at 320px width', async () => {
  await panel.setViewportSize({ width: 320, height: 700 });
  const overflow = await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `overflow ${overflow}px`);
});

await step('no auto-bet controls exist', async () => {
  const html = await panel.content();
  assert.ok(!/auto.?bet|place bet/i.test(html));
});

await ctx.close();
server.close();
await gem.close();
fs.rmSync(userDir, { recursive: true, force: true });
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\nUI test: ${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${path.relative(root, shots)}`);
process.exit(failed.length ? 1 : 0);
