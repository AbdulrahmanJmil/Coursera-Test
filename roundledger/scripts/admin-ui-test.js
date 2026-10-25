// Browser test of the admin dashboard against a real in-process backend and a
// fake Gemini endpoint. Screenshots go to dist/admin-ui-test/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createApp } = await import('../server/src/app.js');
const { loadConfig } = await import('../server/src/config.js');
const { createUser } = await import('../server/src/services/auth.js');
const { startFakeGemini, seedRounds } = await import('../server/test/helpers.js');

const shots = path.join(root, 'dist/admin-ui-test');
fs.mkdirSync(shots, { recursive: true });
const gem = await startFakeGemini();
const config = loadConfig({}, { databasePath: ':memory:', logRequests: false, encryptionKey: crypto.randomBytes(32), geminiBaseUrl: gem.url });
const { server, db } = createApp(config, { log: { info() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const PASSWORD = 'admin-password-1';
createUser(db, { email: 'owner@example.com', password: PASSWORD, role: 'admin' });
const customer = createUser(db, { email: 'customer@example.com', password: 'customer-pass-1' });
db.prepare("INSERT INTO devices (user_id, install_id, name, extension_version, first_seen_at, last_seen_at) VALUES (?, 'install-0123456789abcdef', 'Chrome on Windows', '0.1.0', ?, ?)").run(customer, Date.now(), Date.now());
seedRounds(db, customer, 'melbet', [1.2, 3.4, 2.2, 1.01]);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.log('  ✔', name); }
  catch (err) { results.push(['FAIL', name]); console.log('  ✖', name, '\n    ', err.message.split('\n')[0]); }
};
const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`), fullPage: true });
const dialogOk = async (fill = {}) => {
  await page.waitForSelector('dialog[open]');
  for (const [name, v] of Object.entries(fill)) {
    const sel = `dialog [name="${name}"]`;
    if (typeof v === 'boolean') { if (v) await page.check(sel); else await page.uncheck(sel); }
    else if ((await page.$eval(sel, (e) => e.tagName)) === 'SELECT') await page.selectOption(sel, String(v));
    else await page.fill(sel, String(v));
  }
  await page.click('dialog button[value="ok"]');
  await page.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => {});
};

await step('login screen and sign-in', async () => {
  await page.goto(base + '/admin/');
  await page.waitForSelector('#loginForm');
  await page.fill('#loginForm [name=email]', 'owner@example.com');
  await page.fill('#loginForm [name=password]', 'wrong-password-1');
  await page.click('#loginForm button');
  await page.waitForFunction(() => document.querySelector('#loginError').textContent.length > 0);
  await page.fill('#loginForm [name=password]', PASSWORD);
  await page.click('#loginForm button');
  await page.waitForSelector('h1:has-text("Overview")');
  assert.match(await page.textContent('main'), /Users/);
  await shot('01-overview');
});

await step('create a plan', async () => {
  await page.goto(base + '/admin/#/plans');
  await page.click('text=+ New plan');
  await dialogOk({ code: 'monthly-plus', name: 'Monthly Plus', price: '19.99', currency: 'usd', durationDays: 30, deviceLimit: 2, f_aiAnalysis: true, f_cloudHistory: true, isActive: true });
  await page.waitForSelector('td:has-text("$19.99")');
  await shot('02-plans');
});

await step('generate activation codes (shown once)', async () => {
  await page.goto(base + '/admin/#/codes');
  await page.fill('[name=count]', '3');
  await page.fill('[name=note]', 'reseller batch');
  await page.click('button:has-text("Generate")');
  await page.waitForSelector('.codes-out');
  const codes = (await page.inputValue('.codes-out')).split('\n');
  assert.equal(codes.length, 3);
  assert.match(codes[0], /^RL-/);
  await shot('03-codes');
});

await step('user list, detail, grant subscription, suspend/reactivate', async () => {
  await page.goto(base + '/admin/#/users');
  await page.click('a:has-text("customer@example.com")');
  await page.waitForSelector('h2:has-text("Grant subscription")');
  await page.click('button:has-text("Grant")');
  await page.waitForSelector('td:has-text("Monthly Plus")');
  await page.click('button:has-text("Suspend")');
  await dialogOk({ reason: 'test' });
  await page.waitForSelector('h1 .badge:has-text("suspended")');
  await page.click('button:has-text("Reactivate")');
  await page.waitForSelector('h1 .badge:has-text("active")');
  assert.match(await page.textContent('main'), /melbet: 4/);
  await shot('04-user');
});

await step('subscriptions: renew', async () => {
  await page.goto(base + '/admin/#/subscriptions?state=current');
  await page.click('button:has-text("Renew")');
  await dialogOk({ days: 10 });
  await page.waitForSelector('.toast:has-text("renewed")');
  await shot('05-subscriptions');
});

await step('devices: revoke and restore', async () => {
  await page.goto(base + '/admin/#/devices');
  await page.click('button:has-text("Revoke")');
  await dialogOk();
  await page.waitForSelector('button:has-text("Restore")');
  await page.click('button:has-text("Restore")');
  await page.waitForSelector('.toast:has-text("restored")');
  await shot('06-devices');
});

await step('AI provider: save key (masked), fetch models, enable, tests', async () => {
  await page.goto(base + '/admin/#/ai');
  await page.fill('[name=apiKey]', 'AIzaFAKEFAKEFAKEFAKEFAKE9876');
  await page.click('button:has-text("Save key")');
  await page.waitForSelector('text=••••9876');
  assert.ok(!(await page.content()).includes('AIzaFAKEFAKEFAKEFAKEFAKE9876'));
  await page.click('button:has-text("Fetch available models")');
  await page.waitForSelector('option[value="test-flash-001"]', { state: 'attached' });
  await page.selectOption('[name=model]', 'test-flash-001');
  await page.check('[name=enabled]');
  await page.click('button:has-text("Save configuration")');
  await page.waitForSelector('.toast:has-text("Configuration saved")');
  await page.click('button:has-text("Test key")');
  await page.waitForSelector('text=key accepted');
  const before = gem.calls.filter((c) => c.method === 'POST').length;
  await page.click('button:has-text("Test generation")');
  await dialogOk({ confirm: false });
  assert.equal(gem.calls.filter((c) => c.method === 'POST').length, before, 'no generation without confirmation');
  await page.click('button:has-text("Test generation")');
  await dialogOk({ confirm: true });
  await page.waitForSelector('text=replied "Your rounds look random."');
  await shot('07-ai');
});

await step('settings: change trial duration and validate platforms JSON', async () => {
  await page.goto(base + '/admin/#/settings');
  const trial = page.locator('.card', { has: page.locator('h2:has-text("Free trial")') });
  await trial.locator('label:has-text("durationDays") input').fill('5');
  await trial.locator('button:has-text("Save")').click();
  await page.waitForSelector('.toast:has-text("Free trial saved")');
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'trial'").get().value).durationDays, 5);
  const ta = page.locator('textarea').first();
  await ta.fill('{ not json');
  await page.click('button:has-text("Save platforms")');
  await page.waitForSelector('.toast.bad');
  await shot('08-settings');
});

await step('audit log lists the actions', async () => {
  await page.goto(base + '/admin/#/audit');
  await page.waitForSelector('td .mono');
  const text = await page.textContent('main');
  for (const a of ['plan.create', 'code.generate', 'subscription.grant', 'user.suspend', 'device.revoke', 'ai.credential_set', 'ai.test', 'settings.update', 'auth.login']) assert.ok(text.includes(a), a);
  assert.ok(!text.includes('AIzaFAKE'));
  await shot('09-audit');
});

await step('narrow viewport has no horizontal page overflow', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(base + '/admin/#/overview');
  await page.waitForSelector('h1:has-text("Overview")');
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(o <= 0, `overflow ${o}`);
  await shot('10-mobile');
});

await step('sign out returns to login and blocks API', async () => {
  await page.click('#logout');
  await page.waitForSelector('#loginForm');
  const status = await page.evaluate(() => fetch('/api/admin/overview').then((r) => r.status));
  assert.equal(status, 401);
});

await step('no console errors (CSP violations, exceptions)', async () => {
  const relevant = consoleErrors.filter((e) => !/401|Unauthorized|status of 4\d\d/.test(e));
  assert.deepEqual(relevant, []);
});

await browser.close();
server.close();
await gem.close();
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\nAdmin UI test: ${results.length - failed} passed, ${failed} failed. Screenshots: ${path.relative(root, shots)}`);
process.exit(failed ? 1 : 0);
