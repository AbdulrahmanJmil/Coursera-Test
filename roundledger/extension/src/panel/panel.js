import { normalizeRounds, describe, evaluateStreakRule, verdictText, HISTOGRAM_BUCKETS } from '../../shared/analysis.js';
import { startRain } from './rain.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

let state = null;
let screen = 'main'; // main | settings | devices-full
let selected = null;
let pendingLogin = null; // credentials held in memory only while choosing a device to replace
let deviceChoices = [];
let aiResult = null;
let lastRenderKey = '';
let lastConsoleT = 0; // only lines newer than this animate in

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw { code: 'NO_RESPONSE', message: 'The extension background did not respond. Try reopening the panel.' };
  if (!res.ok) throw res.error;
  return res.data;
}

const fmtX = (x) => (x == null ? '—' : `${Number(x).toFixed(2)}x`);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const date = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour12: false });
function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

const ERROR_TEXT = {
  OFFLINE: 'Cannot reach the RoundLedger server. Check your connection.',
  TIMEOUT: 'The server took too long to respond.',
};
const errText = (e) => ERROR_TEXT[e?.code] || e?.message || 'Something went wrong.';

// ------------------------------------------------------------------ header & banner
function renderChrome() {
  const name = state?.config?.branding?.productName || 'RoundLedger';
  $('#productName').textContent = name;
  document.title = name;

  const b = $('#pillBackend');
  const bs = state?.backend?.status;
  b.className = 'pill ' + (bs === 'online' ? 'ok' : bs === 'offline' ? 'bad' : bs === 'maintenance' ? 'warn' : '');
  b.title = `Backend: ${bs || 'unknown'}${state?.backend?.lastError ? ' — ' + state.backend.lastError : ''}`;

  const p = $('#pillPlatform');
  const plat = state?.platforms?.find((x) => x.id === selected);
  const st = plat?.status?.state;
  const fresh = plat?.status?.lastFrameAt && Date.now() - plat.status.lastFrameAt < 60_000;
  p.className = 'pill ' + (st === 'receiving' && fresh ? 'ok' : st === 'connected' ? 'warn' : st === 'disconnected' ? 'bad' : '');
  p.title = `Game: ${plat ? platformStatusText(plat) : 'no platform selected'}`;

  const rg = state?.config?.branding?.responsibleGamblingUrl;
  const link = $('#rgLink');
  link.hidden = !rg;
  if (rg) link.href = rg;

  const msgs = [];
  if (state?.config?.maintenance?.enabled) msgs.push(state.config.maintenance.message || 'The service is under maintenance.');
  const minV = state?.config?.extension?.minimumVersion;
  const latest = state?.config?.extension?.latestVersion;
  if (minV && cmpVersion(state.build.version, minV) < 0) msgs.push(`This version (${state.build.version}) is no longer supported. Install version ${latest || minV} or later.`);
  else if (latest && cmpVersion(state.build.version, latest) < 0) msgs.push(`Version ${latest} is available.`);
  if (bs === 'offline' && state?.signedIn) msgs.push('Offline: showing cached data. Licence status will refresh when the server is reachable.');
  const s = state?.session;
  const mins = state?.prefs?.reminderMinutes;
  if (s && mins > 0 && Date.now() - s.lastActivityAt < 30 * 60_000 && Date.now() - s.startedAt > mins * 60_000) {
    msgs.push(`You have been in this session for ${Math.round((Date.now() - s.startedAt) / 60_000)} minutes. Consider taking a break.`);
  }
  const banner = $('#banner');
  banner.hidden = !msgs.length;
  banner.replaceChildren(...msgs.map((m) => el('div', {}, m)));
}

// ------------------------------------------------------------------ views
function mount(id) {
  view.replaceChildren($(`#tpl-${id}`).content.cloneNode(true));
}

function renderSignin() {
  mount('signin');
  let mode = 'signin';
  const form = $('#authForm');
  const regAllowed = state?.config?.registrationEnabled !== false;
  const toggle = $('[data-toggle]');
  toggle.hidden = !regAllowed;
  const apply = () => {
    $('[data-mode-title]').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    $('[data-submit]').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    toggle.textContent = mode === 'signin' ? 'Create an account' : 'I already have an account';
    $('[data-register-hint]').hidden = mode === 'signin';
    form.password.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  };
  toggle.addEventListener('click', () => { mode = mode === 'signin' ? 'register' : 'signin'; apply(); });
  apply();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    const errBox = $('[data-error]', form);
    errBox.textContent = '';
    if (!email || !password) { errBox.textContent = 'Enter your email and password.'; return; }
    const btn = $('[data-submit]');
    btn.disabled = true;
    try {
      await send(mode === 'signin' ? 'login' : 'register', { email, password });
      await refresh();
    } catch (err) {
      if (err.code === 'DEVICE_LIMIT_REACHED') {
        pendingLogin = { email, password };
        deviceChoices = err.details?.devices || [];
        screen = 'devices-full';
        render(true);
        return;
      }
      errBox.textContent = errText(err);
    } finally {
      btn.disabled = false;
    }
  });
}

function renderDevicesFull() {
  mount('devices-full');
  $('[data-msg]').textContent = 'Your plan’s device limit is reached. Replace one of these devices with this browser, or cancel.';
  const list = $('[data-list]');
  for (const d of deviceChoices) {
    list.append(el('li', {},
      el('span', {}, d.name || 'Unnamed device', el('br'), el('span', { class: 'meta' }, `last seen ${date(d.lastSeenAt)} · …${d.installIdSuffix}`)),
      el('button', { class: 'btn', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await send('login', { ...pendingLogin, replaceDeviceId: d.id });
          pendingLogin = null;
          screen = 'main';
          await refresh();
        } catch (err) {
          $('[data-error]').textContent = errText(err);
          e.target.disabled = false;
        }
      } }, 'Replace')));
  }
  $('[data-cancel]').addEventListener('click', () => { pendingLogin = null; screen = 'main'; render(true); });
}

const STATE_TEXT = {
  none: 'No active subscription on this account.',
  expired: 'Your subscription has expired.',
  trial_expired: 'Your free trial has ended.',
  suspended: 'Your subscription is suspended. Contact support.',
  revoked: 'Your subscription was revoked. Contact support.',
  account_suspended: 'This account is suspended. Contact support.',
};

function bindRedeem(root) {
  const form = $('[data-redeem]', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('[data-error]', root);
    errBox.textContent = '';
    const code = form.code.value.trim();
    if (!code) { errBox.textContent = 'Enter an activation code.'; return; }
    const btn = $('button', form);
    btn.disabled = true;
    try {
      await send('redeem', { code });
      form.code.value = '';
      await refresh();
    } catch (err) {
      errBox.textContent = errText(err);
    } finally {
      btn.disabled = false;
    }
  });
}

function renderLicense() {
  mount('license');
  const acc = state.account;
  const ent = acc?.entitlement;
  $('[data-state]').textContent = ent ? STATE_TEXT[ent.state] || 'No active subscription.' : (state.backend.status === 'offline' ? 'Cannot check your licence while offline.' : 'Checking licence…');
  const trial = acc?.trial;
  if (trial?.eligible) {
    $('[data-trial]').hidden = false;
    $('[data-trial-hint]').textContent = `${trial.durationDays}-day trial, once per account and per installation.`;
    $('[data-start-trial]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await send('startTrial'); await refresh(); } catch (err) { $('[data-error]').textContent = errText(err); e.target.disabled = false; }
    });
  }
  bindRedeem(view);
  const plans = state.config?.plans || [];
  const box = $('[data-plans]');
  if (plans.length) {
    box.append(el('h3', { class: 'sub' }, 'Plans'));
    for (const p of plans) {
      const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency }).format(p.priceCents / 100);
      const feats = [p.features.cloudHistory && 'cloud history', p.features.aiAnalysis && 'AI explanations'].filter(Boolean).join(', ');
      box.append(el('div', { class: 'plan' }, el('b', {}, p.name), ` · ${price} / ${p.durationDays} days · ${p.deviceLimit} device${p.deviceLimit > 1 ? 's' : ''}`,
        feats ? el('div', { class: 'muted small' }, feats) : null, p.description ? el('div', { class: 'muted small' }, p.description) : null));
    }
    const b = state.config.branding;
    const contact = b.supportUrl || (b.supportEmail ? `mailto:${b.supportEmail}` : '');
    box.append(el('p', { class: 'hint' }, 'Activation codes are issued by the seller. ', contact ? el('a', { href: contact, target: '_blank', rel: 'noopener noreferrer' }, 'Contact support') : null));
  }
  box.append(el('button', { class: 'link', onclick: () => send('logout').then(refresh) }, `Sign out (${state.email})`));
}

function platformStatusText(p) {
  if (!p.configured) return 'Not configured: no verified event map for this platform yet.';
  if (p.permission === 'needed') return 'Page access not granted.';
  const s = p.status || {};
  switch (s.state) {
    case 'license_required': return 'Licence required to record rounds.';
    case 'connected': return 'Connected: waiting for game events.';
    case 'receiving': return Date.now() - s.lastFrameAt > 60_000 ? `No game events for ${ago(s.lastFrameAt).replace(' ago', '')}.` : `Live: last event ${ago(s.lastFrameAt)}.`;
    case 'disconnected': return 'Game connection closed.';
    default: return 'Waiting: open the game page (reload it if it was already open).';
  }
}

const PHASE = { open: 'round open', betting: 'betting phase', running: 'in progress', ended: 'ended', unknown: '' };

function renderMain() {
  mount('main');
  const tabs = $('[data-tabs]');
  const enabled = state.platforms.filter((p) => p.enabled);
  if (!enabled.length) {
    view.replaceChildren(el('section', { class: 'panel' }, el('p', { class: 'empty' }, 'No platforms are enabled on the server.')));
    return;
  }
  for (const p of enabled) {
    tabs.append(el('button', { role: 'tab', 'aria-selected': String(p.id === selected), onclick: () => { selected = p.id; aiResult = null; sessionStorage.setItem('rl.platform', p.id); refresh(); } }, p.name));
  }
  const p = enabled.find((x) => x.id === selected) || enabled[0];
  const verified = $('[data-verified]');
  verified.textContent = p.verified ? 'VERIFIED ADAPTER' : 'UNVERIFIED ADAPTER';
  verified.className = 'tag ' + (p.verified ? 'ok' : 'warn');
  verified.title = p.verified ? 'Marked verified by the operator.' : 'This adapter has not been confirmed against live traffic. Recorded data may be incomplete.';
  $('[data-pstatus]').textContent = platformStatusText(p);
  if (p.configured && p.permission === 'needed') {
    $('[data-permission]').hidden = false;
    $('[data-permission-text]').textContent = `To observe ${p.name} game rounds, allow read access to: ${p.origins.join(', ')}. RoundLedger only reads game messages; it never places bets.`;
    $('[data-grant]').addEventListener('click', async () => {
      const granted = await chrome.permissions.request({ origins: p.origins }).catch(() => false);
      if (granted) await send('permissionsChanged');
      refresh();
    });
  }

  const st = p.status || {};
  const last = $('[data-last]');
  last.textContent = fmtX(st.lastResult?.multiplier ?? state.rounds.at(-1)?.multiplier);
  if ((st.lastResult?.multiplier ?? state.rounds.at(-1)?.multiplier ?? 2) < 2) last.classList.add('low');
  $('[data-round]').textContent = st.currentRoundKey ? `#${st.currentRoundKey}` : st.lastResult ? `#${st.lastResult.roundKey}` : '—';
  $('[data-phase]').textContent = st.state === 'receiving' ? PHASE[st.phase] || '' : '';

  const { rounds } = normalizeRounds(state.rounds);
  const values = rounds.map((r) => r.multiplier);
  const s = describe(values);
  const grid = $('[data-stats]');
  if (!s.n) {
    grid.replaceWith(el('p', { class: 'empty' }, 'No rounds recorded yet. Statistics appear here once rounds are observed.'));
    $('[data-dist]').remove();
    $('[data-chips]').remove();
  } else {
    const cells = [
      [String(s.n), 'rounds recorded'], [fmtX(s.median), 'median'], [fmtX(s.p90), '90th percentile'],
      [pct(s.shareAtLeast[2]), 'reached 2.00x'], [pct(s.shareAtLeast[10]), 'reached 10.00x'], [String(s.longestRunBelow2), 'longest run < 2x'],
    ];
    grid.replaceChildren(...cells.map(([v, l]) => el('div', { class: 'cell' }, el('b', {}, v), el('span', {}, l))));
    const max = Math.max(...s.histogram.map((h) => h.count), 1);
    $('[data-dist]').replaceChildren(...s.histogram.map((h, i) => el('div', { class: 'bar' + (HISTOGRAM_BUCKETS[i].min >= 2 ? ' hi' : ''), title: `${h.label}x: ${h.count}` },
      el('i', { style: `height:${Math.round((h.count / max) * 30)}px` }), el('small', {}, h.label))));
    $('[data-chips]').replaceChildren(...values.slice(-24).reverse().map((v) => el('span', { class: 'chip' + (v >= 2 ? ' hi' : '') }, v.toFixed(2))));
  }

  const ev = evaluateStreakRule(values, { k: 3, below: 2, target: 2 });
  $('[data-pattern]').textContent = s.n ? verdictText(ev) : 'Runs once rounds are recorded. It tests whether a streak of low results changes the next result.';

  const aiStatus = $('[data-ai-status]');
  const runBtn = $('[data-ai-run]');
  const ai = state.account?.ai || state.config?.ai;
  if (!ai?.available) aiStatus.textContent = 'AI explanations are not configured on the server.';
  else if (!state.account?.entitlement?.features?.aiAnalysis) aiStatus.textContent = 'AI explanations are not included in your plan.';
  else if (!state.account?.entitlement?.features?.cloudHistory) aiStatus.textContent = 'AI explanations need cloud history, which your plan does not include.';
  else {
    aiStatus.textContent = 'Plain-language summary of your recorded statistics. It describes the past and does not predict rounds.';
    runBtn.hidden = false;
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Generating…';
      try {
        aiResult = { ok: true, data: await send('analyze', { platform: p.id }) };
      } catch (err) {
        aiResult = { ok: false, error: errText(err) };
      }
      render(true);
    });
  }
  if (aiResult) {
    const out = $('[data-ai-out]');
    out.hidden = false;
    if (aiResult.ok) out.append(aiResult.data.text, el('span', { class: 'meta' }, `AI-generated by ${aiResult.data.provider} (${aiResult.data.model}) from ${aiResult.data.basedOnRounds} synced rounds, ${time(aiResult.data.generatedAt)}. Not a prediction.`));
    else out.append(el('span', { class: 'err' }, aiResult.error));
  }

  const lines = state.console.slice(-5);
  const seen = lastConsoleT;
  lastConsoleT = Math.max(lastConsoleT, ...lines.map((l) => l.t));
  $('[data-console]').replaceChildren(...(lines.length ? lines.map((l) => el('li', { class: l.level + (l.t > seen ? ' new' : '') }, el('time', {}, time(l.t)), l.text))
    : [el('li', { class: 'idle' }, 'No events yet.')]), el('li', { class: 'idle', 'aria-hidden': 'true' }, el('span', { class: 'cursor' }, '▌')));

  const sess = state.session;
  $('[data-session]').textContent = sess && Date.now() - sess.lastActivityAt < 30 * 60_000
    ? `Session ${Math.round((Date.now() - sess.startedAt) / 60_000)} min · ${sess.roundsObserved} rounds observed`
    : 'No active session';
  $('[data-session-reset]').addEventListener('click', () => send('resetSession').then(refresh));
}

async function renderSettings() {
  mount('settings');
  $('[data-back]').addEventListener('click', () => { screen = 'main'; render(true); });
  const ent = state.account?.entitlement;
  const kv = (box, pairs) => box.replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  kv($('[data-account]'), [
    ['Email', state.email || '—'],
    ['Status', ent ? (ent.active ? (ent.kind === 'trial' ? 'Trial' : 'Active') : (STATE_TEXT[ent.state] || ent.state)) : '—'],
    ['Plan', ent?.plan?.name || (ent?.kind === 'trial' ? 'Free trial' : '—')],
    ['Access until', date(ent?.coveredUntil || ent?.expiresAt)],
    ['Devices', ent ? `${ent.devicesUsed} of ${ent.deviceLimit}` : '—'],
  ]);
  bindRedeem(view);
  $('[data-logout]').addEventListener('click', () => send('logout').then(() => { screen = 'main'; refresh(); }));

  const perms = $('[data-perms]');
  for (const p of state.platforms) {
    const right = !p.configured ? el('span', { class: 'meta' }, 'not configured')
      : p.permission === 'granted'
        ? el('button', { class: 'btn ghost', onclick: async () => { await chrome.permissions.remove({ origins: p.origins }); await send('permissionsChanged'); refresh(); } }, 'Remove')
        : el('button', { class: 'btn', onclick: async () => { if (await chrome.permissions.request({ origins: p.origins }).catch(() => false)) await send('permissionsChanged'); refresh(); } }, 'Allow');
    perms.append(el('li', {}, el('span', {}, p.name, el('br'), el('span', { class: 'meta' }, p.origins.join(', ') || 'no page patterns')), right));
  }

  const rem = $('[data-reminder]');
  rem.value = state.prefs.reminderMinutes;
  rem.addEventListener('change', () => send('setPrefs', { prefs: { reminderMinutes: Number(rem.value) } }).then(refresh));

  kv($('[data-data]'), [
    ['Local rounds', `${state.rounds.length} (${state.platforms.find((p) => p.id === selected)?.name || '—'})`],
    ['Waiting to sync', String(state.pendingSync)],
    ['Last sync', state.lastSync ? `${ago(state.lastSync.at)}${state.lastSync.error ? ' — ' + state.lastSync.error : ''}` : 'never'],
    ['Cloud history', ent?.features?.cloudHistory ? 'included' : 'not included in plan'],
  ]);
  $('[data-sync]').addEventListener('click', () => send('syncNow').then(refresh).catch(() => refresh()));
  $('[data-clear]').addEventListener('click', async () => {
    if (!selected || !confirm('Delete the rounds stored in this browser for this platform? Synced cloud history is not affected.')) return;
    await send('clearHistory', { platform: selected });
    refresh();
  });

  kv($('[data-diag]'), [
    ['Extension', state.build.version],
    ['Server', state.config?.serverVersion || '—'],
    ['Backend', state.build.backendUrl],
    ['Status', state.backend.status + (state.backend.lastError ? ` (${state.backend.lastError})` : '')],
    ['Install', '…' + state.installIdSuffix],
  ]);

  const devBox = $('[data-devices]');
  try {
    const d = await send('devices');
    devBox.replaceChildren(...d.devices.map((x) => el('li', {},
      el('span', {}, (x.name || 'Unnamed device') + (x.current ? ' (this browser)' : ''), el('br'), el('span', { class: 'meta' }, `last seen ${date(x.lastSeenAt)} · …${x.installIdSuffix}`)),
      !x.current && d.selfRemovalAllowed ? el('button', { class: 'btn ghost', onclick: async (e) => {
        e.target.disabled = true;
        try { await send('removeDevice', { id: x.id }); renderSettings(); } catch (err) { e.target.replaceWith(el('span', { class: 'err' }, errText(err))); }
      } }, 'Remove') : null)));
  } catch (err) {
    devBox.replaceChildren(el('li', { class: 'err' }, errText(err)));
  }
}

function render(force = false) {
  renderChrome();
  if (!state) return mount('loading');
  // Avoid rebuilding forms while the user is typing in them.
  const key = JSON.stringify([screen, state.signedIn, state.entitled, selected]);
  const typing = view.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (!force && typing && key === lastRenderKey) return;
  lastRenderKey = key;
  if (screen === 'devices-full' && pendingLogin) return renderDevicesFull();
  if (!state.signedIn) return renderSignin();
  if (!state.entitled) return renderLicense();
  if (screen === 'settings') {
    if (!force && view.querySelector('[data-diag]')) return; // settings is static; refresh on demand
    return renderSettings();
  }
  return renderMain();
}

async function refresh() {
  try {
    state = await send('getState', { platform: selected });
    selected = state.selected;
  } catch (err) {
    view.replaceChildren(el('section', { class: 'panel' }, el('p', { class: 'err' }, errText(err))));
    return;
  }
  render();
}

$('#btnSettings').addEventListener('click', () => {
  if (!state?.signedIn) return;
  screen = screen === 'settings' ? 'main' : 'settings';
  lastRenderKey = '';
  view.replaceChildren();
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'state-changed') refresh();
});

selected = sessionStorage.getItem('rl.platform');
render();
startRain($('.rain'));
send('refresh').then((s) => { state = s; selected = selected || s.selected; refresh(); }).catch(() => refresh());
setInterval(() => { if (screen === 'main') refresh(); }, 5000);
