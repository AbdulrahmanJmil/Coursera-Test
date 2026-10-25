// RoundLedger service worker.
//
// Responsibilities: account session with the backend, cached licence state,
// platform adapters and round tracking, local history, cloud sync, and an
// operational event log for the side panel. All licensing and AI decisions are
// made by the backend; this worker only caches and displays them.

import { BUILD } from './build-config.js';
import { api, ApiError } from './api.js';
import { createAdapters, ADAPTERS } from '../shared/adapters/index.js';
import { RoundTracker } from '../shared/round-tracker.js';

const MAX_LOCAL_ROUNDS = 5000;
const CONSOLE_MAX = 60;
const SYNC_BATCH = 500;
const SESSION_IDLE_MS = 30 * 60_000;

const local = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: (k) => chrome.storage.local.remove(k),
};
const sess = {
  get: async (k) => (await chrome.storage.session.get(k))[k],
  set: (k, v) => chrome.storage.session.set({ [k]: v }),
};

// Serialize all state mutations: frames can arrive faster than storage round-trips.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

// ------------------------------------------------------------------ notify
let notifyTimer = null;
function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    chrome.runtime.sendMessage({ type: 'state-changed' }).catch(() => {});
  }, 250);
}

// ------------------------------------------------------------- event log
let lastLogText = '';
async function logEvent(text, level = 'info') {
  if (text === lastLogText) return;
  lastLogText = text;
  const list = (await sess.get('console')) || [];
  list.push({ t: Date.now(), text, level });
  await sess.set('console', list.slice(-CONSOLE_MAX));
  notify();
}

// ------------------------------------------------------------ diagnostics
let lastReportAt = 0;
async function reportError(source, message, context) {
  const auth = await local.get('auth');
  if (!auth?.token || Date.now() - lastReportAt < 60_000) return;
  lastReportAt = Date.now();
  api('/api/diagnostics/errors', { method: 'POST', token: auth.token, body: { source, message: String(message).slice(0, 900), context: { version: BUILD.version, ...context } } })
    .catch(() => {});
}

// ------------------------------------------------------------------ install id
async function installId() {
  let id = await local.get('installId');
  if (!id) {
    id = crypto.randomUUID();
    await local.set('installId', id);
  }
  return id;
}

// ------------------------------------------------------------------ backend state
const backend = { status: 'unknown', lastError: null, checkedAt: null };

function setBackend(status, err) {
  const changed = backend.status !== status;
  backend.status = status;
  backend.lastError = err ? err.message : null;
  backend.checkedAt = Date.now();
  if (changed) logEvent(status === 'online' ? 'Backend connection established' : `Backend unreachable: ${err?.message || 'unknown error'}`, status === 'online' ? 'ok' : 'warn');
}

async function call(path, opts = {}) {
  try {
    const r = await api(path, opts);
    setBackend('online');
    return r;
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'OFFLINE' || err.code === 'TIMEOUT')) setBackend('offline', err);
    else if (err instanceof ApiError && err.status === 503 && err.code === 'MAINTENANCE') setBackend('maintenance', err);
    else setBackend('online');
    throw err;
  }
}

async function authedCall(path, opts = {}) {
  const auth = await local.get('auth');
  if (!auth?.token) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required.');
  try {
    return await call(path, { ...opts, token: auth.token });
  } catch (err) {
    if (err.status === 401) {
      await local.remove('auth');
      await local.remove('account');
      await logEvent(err.code === 'DEVICE_REVOKED' ? 'Signed out: this installation was deactivated' : 'Session expired — sign in again', 'warn');
    }
    throw err;
  }
}

// ------------------------------------------------------------------ config & adapters
let adapters = [];
const trackers = new Map();

async function refreshConfig() {
  try {
    const cfg = await call('/api/public/config');
    await local.set('publicConfig', cfg);
  } catch { /* keep cached config */ }
  await rebuildAdapters();
}

async function rebuildAdapters() {
  const cfg = await local.get('publicConfig');
  adapters = createAdapters(cfg?.platforms || []);
  await syncContentScripts();
}

function originsFor(adapter) {
  const set = new Set();
  for (const p of adapter.config.pageUrlPatterns || []) {
    const m = /^(https:\/\/[^/]+)\//.exec(p);
    if (m) set.add(m[1] + '/*');
  }
  return [...set];
}

async function permissionState(adapter) {
  const origins = originsFor(adapter);
  if (!origins.length) return 'not_configured';
  return (await chrome.permissions.contains({ origins })) ? 'granted' : 'needed';
}

async function syncContentScripts() {
  try {
    const existing = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => id.startsWith('rl-'));
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing });
    const scripts = [];
    for (const a of adapters) {
      if ((await permissionState(a)) !== 'granted') continue;
      const matches = a.config.pageUrlPatterns;
      scripts.push(
        { id: `rl-hook-${a.id}`, matches, js: ['src/content/page-hook.js'], runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true },
        { id: `rl-bridge-${a.id}`, matches, js: ['src/content/bridge.js'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true },
      );
    }
    if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
  } catch (err) {
    await logEvent('Could not register page observers: ' + err.message, 'error');
    reportError('background.scripts', err.message);
  }
}

async function trackerFor(platformId) {
  if (trackers.has(platformId)) return trackers.get(platformId);
  const rounds = (await local.get(`rounds:${platformId}`)) || [];
  const state = await sess.get(`tracker:${platformId}`);
  const t = new RoundTracker({ knownKeys: rounds.map((r) => r.roundKey), state });
  trackers.set(platformId, t);
  return t;
}

// ------------------------------------------------------------------ platform status
async function platformStatus() {
  return (await sess.get('platformStatus')) || {};
}

async function updateStatus(platformId, patch) {
  const all = await platformStatus();
  all[platformId] = { ...(all[platformId] || {}), ...patch };
  await sess.set('platformStatus', all);
  notify();
}

// ------------------------------------------------------------------ licence
async function account() {
  return local.get('account');
}

function entitled(acc, feature) {
  const e = acc?.entitlement;
  if (!e?.active || !(e.expiresAt > Date.now())) return false;
  return feature ? e.features?.[feature] === true : true;
}

async function refreshAccount() {
  const auth = await local.get('auth');
  if (!auth?.token) return null;
  try {
    const me = await authedCall('/api/me');
    const acc = { ...me, fetchedAt: Date.now() };
    await local.set('account', acc);
    notify();
    return acc;
  } catch (err) {
    if (err.status !== 401) await logEvent('Could not refresh licence: ' + err.message, 'warn');
    notify();
    return account();
  }
}

// ------------------------------------------------------------------ session tracking
async function touchSession(rounds) {
  const now = Date.now();
  let s = await local.get('session');
  if (!s || now - (s.lastActivityAt || 0) > SESSION_IDLE_MS) s = { startedAt: now, roundsObserved: 0 };
  s.lastActivityAt = now;
  s.roundsObserved += rounds;
  await local.set('session', s);
}

// ------------------------------------------------------------------ frames
async function handleWs(msg, sender) {
  const frameUrl = sender.url || msg.pageUrl;
  const adapter = adapters.find((a) => a.matchesPage(frameUrl) && a.matchesSocket(msg.socketUrl));
  if (!adapter) return;
  const pid = adapter.id;
  const acc = await account();
  if (!entitled(acc)) {
    await updateStatus(pid, { state: 'license_required', lastFrameAt: Date.now() });
    return;
  }
  if (msg.kind === 'open') {
    await updateStatus(pid, { state: 'connected', socketOpen: true, tabId: sender.tab?.id, since: Date.now() });
    await logEvent(`${adapter.config.name}: game connection detected`, 'ok');
    return;
  }
  if (msg.kind === 'close') {
    await updateStatus(pid, { state: 'disconnected', socketOpen: false });
    await logEvent(`${adapter.config.name}: game connection closed`, 'warn');
    return;
  }
  const parsed = adapter.parseFrame(msg.data);
  const tracker = await trackerFor(pid);
  const recorded = [];
  for (const ev of parsed.events) {
    const out = tracker.apply(ev);
    recorded.push(...out.recorded);
    for (const w of out.warnings) await logEvent(`${adapter.config.name}: ${w}`, 'warn');
  }
  const st = (await platformStatus())[pid] || {};
  await updateStatus(pid, {
    state: 'receiving', socketOpen: true, lastFrameAt: Date.now(), tabId: sender.tab?.id,
    phase: tracker.phase, currentRoundKey: tracker.currentRoundKey, lastResult: tracker.lastResult,
    parseErrors: (st.parseErrors || 0) + parsed.errors, unsupportedFrames: (st.unsupportedFrames || 0) + (parsed.unsupported ? 1 : 0),
  });
  await sess.set(`tracker:${pid}`, tracker.snapshotState());
  if (!recorded.length) return;
  const key = `rounds:${pid}`;
  const rounds = (await local.get(key)) || [];
  rounds.push(...recorded.map((r) => ({ ...r, synced: false })));
  await local.set(key, rounds.slice(-MAX_LOCAL_ROUNDS));
  await touchSession(recorded.length);
  for (const r of recorded) await logEvent(`${adapter.config.name}: round ${r.roundKey} recorded at ${r.multiplier.toFixed(2)}x${r.source === 'snapshot' ? ' (history)' : ''}`, 'ok');
  scheduleSync();
}

// ------------------------------------------------------------------ sync
let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => serial(syncRounds), 5000);
}

async function syncRounds() {
  const acc = await account();
  if (!entitled(acc, 'cloudHistory')) return;
  for (const id of Object.keys(ADAPTERS)) {
    const key = `rounds:${id}`;
    const rounds = (await local.get(key)) || [];
    const pending = rounds.filter((r) => !r.synced);
    if (!pending.length) continue;
    for (let i = 0; i < pending.length; i += SYNC_BATCH) {
      const batch = pending.slice(i, i + SYNC_BATCH);
      try {
        await authedCall('/api/rounds', { method: 'POST', body: { platform: id, rounds: batch.map(({ roundKey, multiplier, observedAt, source }) => ({ roundKey, multiplier, observedAt, source })) } });
        const keys = new Set(batch.map((r) => r.roundKey));
        const fresh = (await local.get(key)) || [];
        for (const r of fresh) if (keys.has(r.roundKey)) r.synced = true;
        await local.set(key, fresh);
        await local.set('lastSync', { at: Date.now(), error: null });
      } catch (err) {
        await local.set('lastSync', { at: Date.now(), error: err.message });
        if (err.code !== 'OFFLINE') await logEvent('History sync failed: ' + err.message, 'warn');
        notify();
        return;
      }
    }
    await logEvent(`History synced (${pending.length} round${pending.length === 1 ? '' : 's'})`, 'ok');
  }
}

// ------------------------------------------------------------------ panel API
async function getState({ platform } = {}) {
  const [cfg, auth, acc, consoleLines, status, session, prefs, lastSync, iid] = await Promise.all([
    local.get('publicConfig'), local.get('auth'), account(), sess.get('console'), platformStatus(),
    local.get('session'), local.get('prefs'), local.get('lastSync'), installId(),
  ]);
  const platforms = [];
  for (const p of cfg?.platforms || []) {
    const adapter = adapters.find((a) => a.id === p.id);
    const configured = !!adapter && (adapter.configured ?? true) && !!p.socketUrlContains && !!p.events?.crashed;
    platforms.push({
      id: p.id, name: p.name, enabled: p.enabled, verified: p.verified, configured,
      origins: adapter ? originsFor(adapter) : [],
      permission: adapter ? await permissionState(adapter) : 'not_configured',
      status: status[p.id] || { state: 'idle' },
    });
  }
  const selected = platform || platforms.find((p) => p.enabled)?.id || null;
  const rounds = selected ? (await local.get(`rounds:${selected}`)) || [] : [];
  return {
    build: BUILD,
    installIdSuffix: iid.slice(-6),
    backend,
    config: cfg || null,
    signedIn: !!auth?.token,
    email: auth?.email || null,
    account: acc || null,
    entitled: entitled(acc),
    platforms,
    selected,
    rounds,
    pendingSync: rounds.filter((r) => !r.synced).length,
    lastSync: lastSync || null,
    console: consoleLines || [],
    session: session || null,
    prefs: { reminderMinutes: 60, ...(prefs || {}) },
  };
}

function deviceName() {
  const p = navigator.userAgentData?.platform || 'Unknown OS';
  return `Chrome on ${p}`.slice(0, 80);
}

const handlers = {
  getState: (m) => getState(m),
  refresh: async () => { await refreshConfig(); await refreshAccount(); return getState(); },

  async login({ email, password, replaceDeviceId }) {
    const r = await call('/api/auth/login', { method: 'POST', body: {
      email, password, client: 'extension', installId: await installId(), deviceName: deviceName(), extensionVersion: BUILD.version,
      ...(replaceDeviceId ? { replaceDeviceId } : {}),
    } });
    await local.set('auth', { token: r.token, email: r.user.email, expiresAt: r.expiresAt });
    await logEvent(`Signed in as ${r.user.email}`, 'ok');
    await refreshAccount();
    serial(syncRounds);
    return { ok: true };
  },

  async register({ email, password }) {
    await call('/api/auth/register', { method: 'POST', body: { email, password } });
    await logEvent('Account created', 'ok');
    return handlers.login({ email, password });
  },

  async logout() {
    const auth = await local.get('auth');
    if (auth?.token) await api('/api/auth/logout', { method: 'POST', token: auth.token }).catch(() => {});
    await local.remove('auth');
    await local.remove('account');
    await logEvent('Signed out', 'info');
    return { ok: true };
  },

  async startTrial() {
    await authedCall('/api/license/trial', { method: 'POST', body: {} });
    await logEvent('Free trial started', 'ok');
    await refreshAccount();
    return { ok: true };
  },

  async redeem({ code }) {
    const r = await authedCall('/api/license/redeem', { method: 'POST', body: { code } });
    await logEvent(`Activation code accepted: ${r.plan.name}`, 'ok');
    await refreshAccount();
    serial(syncRounds);
    return { ok: true, plan: r.plan, expiresAt: r.expiresAt };
  },

  devices: () => authedCall('/api/devices'),
  async removeDevice({ id }) {
    await authedCall(`/api/devices/${Number(id)}`, { method: 'DELETE' });
    await logEvent('Device removed', 'info');
    return { ok: true };
  },

  async analyze({ platform }) {
    await serial(syncRounds);
    await logEvent('AI explanation requested', 'info');
    try {
      const r = await authedCall('/api/ai/analyze', { method: 'POST', body: { platform }, timeoutMs: 130000 });
      await logEvent(`AI explanation received (${r.basedOnRounds} rounds)`, 'ok');
      return r;
    } catch (err) {
      await logEvent('AI explanation failed: ' + err.message, 'warn');
      throw err;
    }
  },

  async permissionsChanged() {
    await syncContentScripts();
    await logEvent('Page access updated — reload the game tab to start observing', 'info');
    return getState();
  },

  async clearHistory({ platform }) {
    if (!ADAPTERS[platform]) throw new ApiError(400, 'BAD_PLATFORM', 'Unknown platform');
    await local.remove(`rounds:${platform}`);
    trackers.delete(platform);
    await chrome.storage.session.remove(`tracker:${platform}`);
    await logEvent(`Local history cleared for ${platform}`, 'info');
    return { ok: true };
  },

  async resetSession() {
    await local.set('session', { startedAt: Date.now(), lastActivityAt: Date.now(), roundsObserved: 0 });
    return { ok: true };
  },

  async setPrefs({ prefs }) {
    const cur = (await local.get('prefs')) || {};
    const minutes = Number(prefs?.reminderMinutes);
    if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 600) cur.reminderMinutes = minutes;
    await local.set('prefs', cur);
    return { ok: true };
  },

  syncNow: () => serial(syncRounds).then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (msg?.type === 'ws') {
    if (!sender.tab || fromExtensionPage) return false;
    ready.then(() => serial(() => handleWs(msg, sender))).catch((err) => reportError('background.ws', err.message));
    return false;
  }
  const fn = handlers[msg?.type];
  if (!fn || !fromExtensionPage) return false; // extension pages only; content scripts may only send frames
  ready
    .then(() => fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      if (!(err instanceof ApiError)) reportError('background.' + msg.type, err.message);
      sendResponse({ ok: false, error: { status: err.status ?? 0, code: err.code || 'ERROR', message: err.message, details: err.details } });
    });
  return true;
});

// ------------------------------------------------------------------ lifecycle
async function init() {
  await installId();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await rebuildAdapters();
  if (!(await sess.get('booted'))) {
    await sess.set('booted', true);
    await logEvent(`Extension initialized (v${BUILD.version})`, 'info');
  }
  refreshConfig().then(refreshAccount);
}

const ready = init();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 30 });
  chrome.alarms.create('sync', { periodInMinutes: 2 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh') ready.then(refreshConfig).then(refreshAccount);
  if (a.name === 'sync') ready.then(() => serial(syncRounds));
});
chrome.permissions.onAdded.addListener(() => ready.then(syncContentScripts));
chrome.permissions.onRemoved.addListener(() => ready.then(syncContentScripts));
