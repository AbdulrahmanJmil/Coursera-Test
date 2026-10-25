// RoundLedger admin dashboard. Plain ES modules, no build step.
// All authorization is enforced by the server; this UI only renders what the
// admin API returns. Never use innerHTML with server data: build nodes instead.

const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');

// ------------------------------------------------------------------ helpers
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(3)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'RoundLedger', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = json?.error || {};
    if (res.status === 401 && !path.startsWith('/api/auth/')) showLogin();
    throw new ApiError(res.status, e.code, e.message || `Request failed (${res.status})`, e.details);
  }
  return json;
}

const fmtDate = (t) => (t ? new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—');
const n0 = (x) => (x == null ? 0 : x);
const money = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${cur}`; } };
const badge = (text, kind = '') => el('span', { class: `badge ${kind}` }, text);
const statusBadge = (s) => badge(s, { active: 'ok', available: 'ok', success: 'ok', ok: 'ok', redeemed: '', suspended: 'warn', expired: 'warn', revoked: 'bad', failure: 'bad', error: 'bad' }[s] ?? '');
const toDateInput = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 7000 : 3500);
}

/** Runs an action, toasts success/failure, then re-renders the current route. */
async function act(fn, ok = 'Saved') {
  try {
    const r = await fn();
    if (ok) toast(ok);
    await route();
    return r;
  } catch (err) {
    toast(err.message || 'Action failed', true);
    return undefined;
  }
}

/** Modal dialog. fields: [{name,label,type,value,options,required}] → resolves to values or null. */
function dialog({ title, text, fields = [], confirmText = 'Confirm', danger = false }) {
  const d = $('#dialog');
  const f = $('#dialogForm');
  const inputs = {};
  f.replaceChildren(
    el('h3', {}, title),
    text ? el('p', { class: 'muted' }, text) : null,
    ...fields.map((fd) => {
      let input;
      if (fd.type === 'select') input = el('select', { name: fd.name }, fd.options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(fd.value) || null }, l)));
      else if (fd.type === 'checkbox') input = el('input', { type: 'checkbox', name: fd.name, checked: fd.value });
      else if (fd.type === 'textarea') input = el('textarea', { name: fd.name }, fd.value ?? '');
      else input = el('input', { name: fd.name, type: fd.type || 'text', value: fd.value ?? '', required: fd.required, min: fd.min, max: fd.max, step: fd.step, autocomplete: 'off' });
      inputs[fd.name] = input;
      return fd.type === 'checkbox' ? el('label', { class: 'check' }, input, fd.label) : el('label', {}, fd.label, input);
    }),
    el('p', { class: 'err', 'data-err': '' }),
    el('div', { class: 'row' }, el('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok' }, confirmText)),
  );
  return new Promise((resolve) => {
    d.onclose = () => {
      if (d.returnValue !== 'ok') return resolve(null);
      const out = {};
      for (const [k, i] of Object.entries(inputs)) out[k] = i.type === 'checkbox' ? i.checked : i.value;
      resolve(out);
    };
    d.returnValue = '';
    d.showModal();
  });
}

function table(cols, rows, { onRow, empty = 'Nothing to show.' } = {}) {
  if (!rows.length) return el('p', { class: 'muted' }, empty);
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', {}, c.label)))),
    el('tbody', {}, rows.map((r) => el('tr', { class: onRow ? 'click' : null, onclick: onRow ? (e) => { if (!e.target.closest('button,a,input,select')) onRow(r); } : null },
      cols.map((c) => el('td', {}, c.render ? c.render(r) : r[c.key] ?? '—')))))));
}

function pager(data, go) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return el('div', { class: 'pager' },
    `${data.total} total · page ${data.page} of ${pages}`,
    el('button', { class: 'btn sm', disabled: data.page <= 1 || null, onclick: () => go(data.page - 1) }, '‹ Prev'),
    el('button', { class: 'btn sm', disabled: data.page >= pages || null, onclick: () => go(data.page + 1) }, 'Next ›'));
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

function setHashQuery(base, params) {
  location.hash = base + qs(params);
}

function filterBar(fields, values, onApply) {
  const inputs = {};
  const form = el('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); const v = {}; for (const [k, i] of Object.entries(inputs)) v[k] = i.value; onApply(v); } },
    fields.map((f) => {
      const input = f.options
        ? el('select', { name: f.name }, f.options.map(([v, l]) => el('option', { value: v, selected: values[f.name] === v || null }, l)))
        : el('input', { name: f.name, value: values[f.name] || '', placeholder: f.placeholder || '' });
      inputs[f.name] = input;
      return el('label', { class: f.grow ? 'grow' : null }, f.label, input);
    }),
    el('button', { class: 'btn', type: 'submit' }, 'Apply'));
  return form;
}

// ------------------------------------------------------------------ auth
let me = null;
function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  me = null;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#loginError').textContent = '';
  try {
    const r = await api('POST', '/api/auth/login', { email: f.email.value.trim(), password: f.password.value, client: 'web' });
    me = r.user;
    f.password.value = '';
    start();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  showLogin();
});

// ------------------------------------------------------------------ views
const views = {};

views.overview = async () => {
  const o = await api('GET', '/api/admin/overview');
  const ai = Object.entries(o.ai.providers)[0]?.[1];
  const stat = (label, value, sub) => el('div', { class: 'card stat' }, el('h2', {}, label), el('b', {}, String(value)), sub ? el('span', { class: 'muted small' }, sub) : null);
  return [
    el('h1', {}, 'Overview', el('span', { class: 'muted small' }, `as of ${fmtDate(o.generatedAt)}`)),
    o.health.configProblems.length ? el('div', { class: 'warnbox' }, o.health.configProblems.map((p) => el('div', {}, p))) : null,
    !o.health.encryptionKeyConfigured ? el('div', { class: 'warnbox' }, 'APP_ENCRYPTION_KEY is not set: AI provider keys cannot be stored.') : null,
    o.health.maintenance ? el('div', { class: 'warnbox' }, 'Maintenance mode is ON: customers cannot use the service.') : null,
    el('div', { class: 'grid' },
      stat('Users', n0(o.users.total), `${n0(o.users.active)} active · ${n0(o.users.suspended)} suspended · ${n0(o.users.admins)} admin`),
      stat('Paid subscriptions', n0(o.subscriptions.activePaid), `${n0(o.subscriptions.activeTrials)} trials · ${n0(o.subscriptions.scheduled)} scheduled`),
      stat('Ended subscriptions', n0(o.subscriptions.expired) + n0(o.subscriptions.revoked), `${n0(o.subscriptions.expired)} expired · ${n0(o.subscriptions.revoked)} revoked · ${n0(o.subscriptions.suspended)} suspended`),
      stat('Activation codes', n0(o.codes.available), `available · ${n0(o.codes.redeemed)} used · ${n0(o.codes.revoked)} revoked`),
      stat('Devices', n0(o.devices.active), `active · ${n0(o.devices.seen7d)} seen in 7 days · ${n0(o.devices.revoked)} revoked`),
      stat('AI (today)', ai ? n0(ai.usage.today.requests) : 0, ai
        ? `${o.ai.publicStatus.available ? 'available' : 'unavailable (' + o.ai.publicStatus.reason + ')'} · ${n0(ai.usage.today.errors)} errors · ${n0(ai.usage.today.totalTokens)} tokens`
        : 'no provider'),
      stat('Client errors (24h)', o.clientErrors24h, 'reported by extensions'),
    ),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('h2', {}, 'System health'), el('dl', { class: 'kv' },
        el('dt', {}, 'Server'), el('dd', {}, `v${o.health.version} · Node ${o.health.node}`),
        el('dt', {}, 'Uptime'), el('dd', {}, `${Math.floor(o.health.uptimeSec / 3600)}h ${Math.floor((o.health.uptimeSec % 3600) / 60)}m`),
        el('dt', {}, 'Database'), el('dd', {}, `${o.health.database}${o.health.databaseBytes != null ? ` · ${(o.health.databaseBytes / 1048576).toFixed(1)} MB` : ''}`),
        el('dt', {}, 'Secret storage'), el('dd', {}, o.health.encryptionKeyConfigured ? statusBadge('ok') : badge('not configured', 'bad')),
        el('dt', {}, 'AI provider'), el('dd', {}, ai ? `${o.ai.activeProvider} · ${ai.enabled ? 'enabled' : 'disabled'} · ${ai.model || 'no model'} · key ${ai.credentialConfigured ? 'set' : 'missing'}` : '—'),
        ai?.lastError ? [el('dt', {}, 'Last AI error'), el('dd', {}, `${fmtDate(ai.lastError.created_at)} · ${ai.lastError.error_code}`)] : null,
      )),
    ),
    el('div', { class: 'card' }, el('h2', {}, 'Recent administrative activity'), auditTable(o.recentActivity, false)),
  ];
};

function auditTable(rows, withDetails = true) {
  return table([
    { label: 'When', render: (r) => fmtDate(r.created_at) },
    { label: 'Actor', render: (r) => r.actor_email || 'system' },
    { label: 'Action', render: (r) => el('span', { class: 'mono' }, r.action) },
    { label: 'Resource', render: (r) => (r.resource_type ? `${r.resource_type} ${r.resource_id ?? ''}` : '—') },
    { label: 'Outcome', render: (r) => statusBadge(r.outcome) },
    ...(withDetails ? [{ label: 'Details', render: (r) => (r.details ? el('pre', {}, JSON.stringify(JSON.parse(r.details), null, 1)) : '') }, { label: 'IP', render: (r) => r.ip || '—' }] : []),
  ], rows, { empty: 'No activity recorded yet.' });
}

views.users = async (q) => {
  const data = await api('GET', '/api/admin/users' + qs({ q: q.q, status: q.status, role: q.role, page: q.page }));
  return [
    el('h1', {}, 'Users', el('button', { class: 'btn sm', onclick: createUser }, '+ New user')),
    el('div', { class: 'card' },
      filterBar([
        { name: 'q', label: 'Search email', grow: true },
        { name: 'status', label: 'Status', options: [['', 'Any'], ['active', 'Active'], ['suspended', 'Suspended']] },
        { name: 'role', label: 'Role', options: [['', 'Any'], ['user', 'User'], ['admin', 'Admin']] },
      ], q, (v) => setHashQuery('#/users', v)),
      table([
        { label: 'Email', render: (u) => el('a', { href: `#/users/${u.id}` }, u.email) },
        { label: 'Role', key: 'role' },
        { label: 'Status', render: (u) => statusBadge(u.status) },
        { label: 'Access until', render: (u) => (u.access_until ? fmtDay(u.access_until) : badge('none')) },
        { label: 'Devices', key: 'active_devices' },
        { label: 'Created', render: (u) => fmtDay(u.created_at) },
        { label: 'Last sign-in', render: (u) => fmtDate(u.last_login_at) },
      ], data.items, { onRow: (u) => (location.hash = `#/users/${u.id}`) }),
      pager(data, (p) => setHashQuery('#/users', { ...q, page: p }))),
  ];
};

async function createUser() {
  const v = await dialog({ title: 'Create user', fields: [{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Initial password (10+ chars, letters and numbers)', type: 'password', required: true }], confirmText: 'Create' });
  if (v) await act(() => api('POST', '/api/admin/users', v), 'User created');
}

let plansCache = null;
async function plans() {
  plansCache = (await api('GET', '/api/admin/plans')).items;
  return plansCache;
}

function subscriptionActions(s) {
  if (s.status === 'revoked') return '—';
  return el('div', { class: 'actions' },
    el('button', { class: 'btn sm', onclick: async () => {
      const v = await dialog({ title: 'Renew subscription', text: 'Adds days from the current expiry (or from now if already expired).', fields: [{ name: 'days', label: 'Days to add', type: 'number', min: 1, max: 3650, value: 30 }], confirmText: 'Renew' });
      if (v) act(() => api('POST', `/api/admin/subscriptions/${s.id}/renew`, { days: Number(v.days) }), 'Subscription renewed');
    } }, 'Renew'),
    el('button', { class: 'btn sm', onclick: async () => {
      const v = await dialog({ title: 'Change expiry', fields: [{ name: 'expiresAt', label: 'New expiry (local time)', type: 'datetime-local', value: toDateInput(s.expiresAt) }], confirmText: 'Save' });
      if (v?.expiresAt) act(() => api('PATCH', `/api/admin/subscriptions/${s.id}`, { expiresAt: new Date(v.expiresAt).toISOString() }), 'Expiry changed');
    } }, 'Expiry'),
    s.status === 'active'
      ? el('button', { class: 'btn sm', onclick: () => act(() => api('PATCH', `/api/admin/subscriptions/${s.id}`, { status: 'suspended' }), 'Suspended') }, 'Suspend')
      : el('button', { class: 'btn sm', onclick: () => act(() => api('PATCH', `/api/admin/subscriptions/${s.id}`, { status: 'active' }), 'Reactivated') }, 'Reactivate'),
    el('button', { class: 'btn sm danger', onclick: async () => {
      const v = await dialog({ title: 'Revoke subscription?', text: 'Revocation is permanent. The customer loses access immediately.', confirmText: 'Revoke', danger: true });
      if (v) act(() => api('PATCH', `/api/admin/subscriptions/${s.id}`, { status: 'revoked' }), 'Revoked');
    } }, 'Revoke'));
}

function subState(s) {
  const now = Date.now();
  if (s.status !== 'active') return statusBadge(s.status);
  if (s.startsAt > now) return badge('scheduled');
  if (s.expiresAt <= now) return statusBadge('expired');
  return statusBadge('active');
}

const subColumns = (withEmail) => [
  { label: '#', key: 'id' },
  ...(withEmail ? [{ label: 'User', render: (s) => el('a', { href: `#/users/${s.userId}` }, s.email) }] : []),
  { label: 'Plan', render: (s) => s.planName || (s.kind === 'trial' ? 'Trial' : '—') },
  { label: 'Kind', key: 'kind' },
  { label: 'Source', key: 'source' },
  { label: 'State', render: subState },
  { label: 'Starts', render: (s) => fmtDay(s.startsAt) },
  { label: 'Expires', render: (s) => fmtDate(s.expiresAt) },
  { label: 'Devices', key: 'deviceLimit' },
  { label: '', render: subscriptionActions },
];

function deviceActions(d) {
  return el('div', { class: 'actions' },
    d.status === 'active'
      ? el('button', { class: 'btn sm danger', onclick: async () => {
        const v = await dialog({ title: 'Revoke device?', text: 'The installation is signed out and cannot sign in again until restored.', confirmText: 'Revoke', danger: true });
        if (v) act(() => api('POST', `/api/admin/devices/${d.id}/revoke`, {}), 'Device revoked');
      } }, 'Revoke')
      : d.revoked_reason === 'admin' ? el('button', { class: 'btn sm', onclick: () => act(() => api('POST', `/api/admin/devices/${d.id}/restore`, {}), 'Device restored') }, 'Restore') : null,
    d.status === 'active' ? el('button', { class: 'btn sm', onclick: async () => {
      const v = await dialog({ title: 'Reassign installation', text: 'Moves this installation to another account (that account’s device limit applies).', fields: [{ name: 'email', label: 'Target account email', type: 'email', required: true }], confirmText: 'Reassign' });
      if (v) act(() => api('POST', `/api/admin/devices/${d.id}/reassign`, { email: v.email }), 'Device reassigned');
    } }, 'Reassign') : null);
}

const deviceColumns = (withEmail) => [
  ...(withEmail ? [{ label: 'User', render: (d) => el('a', { href: `#/users/${d.user_id}` }, d.email) }] : []),
  { label: 'Name', render: (d) => d.name || '—' },
  { label: 'Install', render: (d) => el('span', { class: 'mono', title: d.install_id }, '…' + d.install_id.slice(-8)) },
  { label: 'Version', render: (d) => d.extension_version || '—' },
  { label: 'Status', render: (d) => [statusBadge(d.status), d.revoked_reason ? el('span', { class: 'muted small' }, ' ' + d.revoked_reason) : null] },
  { label: 'First seen', render: (d) => fmtDay(d.first_seen_at) },
  { label: 'Last seen', render: (d) => fmtDate(d.last_seen_at) },
  { label: '', render: deviceActions },
];

const codeColumns = [
  { label: 'Code', render: (c) => el('span', { class: 'mono' }, c.hint) },
  { label: 'Plan', key: 'planName' },
  { label: 'Days', key: 'durationDays' },
  { label: 'Status', render: (c) => statusBadge(c.status) },
  { label: 'Assigned to', render: (c) => c.assignedEmail || '—' },
  { label: 'Redeemed by', render: (c) => (c.redeemedEmail ? [c.redeemedEmail, el('div', { class: 'muted small' }, fmtDate(c.redeemedAt))] : '—') },
  { label: 'Valid until', render: (c) => fmtDay(c.validUntil) },
  { label: 'Note', render: (c) => c.note || '' },
  { label: 'Created', render: (c) => fmtDay(c.createdAt) },
  { label: '', render: (c) => (c.status !== 'available' ? '' : el('div', { class: 'actions' },
    el('button', { class: 'btn sm', onclick: async () => {
      const v = await dialog({ title: 'Assign code', text: 'Only this account will be able to redeem it. Leave empty to unassign.', fields: [{ name: 'email', label: 'Account email', type: 'email', value: c.assignedEmail || '' }], confirmText: 'Save' });
      if (v) act(() => api('POST', `/api/admin/codes/${c.id}/assign`, { email: v.email || undefined }), 'Assignment saved');
    } }, 'Assign'),
    el('button', { class: 'btn sm danger', onclick: async () => {
      const v = await dialog({ title: 'Revoke this code?', text: 'It can no longer be redeemed.', confirmText: 'Revoke', danger: true });
      if (v) act(() => api('POST', `/api/admin/codes/${c.id}/revoke`, {}), 'Code revoked');
    } }, 'Revoke'))) },
];

views.user = async (q, id) => {
  const [d, ps] = await Promise.all([api('GET', `/api/admin/users/${id}`), plans()]);
  const u = d.user;
  const e = d.entitlement;
  const self = me && me.id === u.id;
  return [
    el('h1', {}, el('a', { href: '#/users', class: 'small' }, '← Users'), u.email, statusBadge(u.status), u.role === 'admin' ? badge('admin', 'warn') : null),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('h2', {}, 'Account'), el('dl', { class: 'kv' },
        el('dt', {}, 'ID'), el('dd', {}, String(u.id)),
        el('dt', {}, 'Created'), el('dd', {}, fmtDate(u.created_at)),
        el('dt', {}, 'Last sign-in'), el('dd', {}, fmtDate(u.last_login_at)),
        u.status_reason ? [el('dt', {}, 'Status reason'), el('dd', {}, u.status_reason)] : null,
        u.locked_until && u.locked_until > Date.now() ? [el('dt', {}, 'Locked until'), el('dd', {}, fmtDate(u.locked_until))] : null,
        el('dt', {}, 'Trial'), el('dd', {}, d.trialClaim ? `used ${fmtDay(d.trialClaim.claimed_at)}` : 'not used'),
        el('dt', {}, 'Rounds synced'), el('dd', {}, d.rounds.length ? d.rounds.map((r) => `${r.platform}: ${r.count}`).join(', ') : '0'),
        el('dt', {}, 'AI requests'), el('dd', {}, `${n0(d.aiUsage.requests)} (${n0(d.aiUsage.errors)} errors)`)),
      el('div', { class: 'toolbar' },
        self ? el('span', { class: 'muted small' }, 'This is your account.') : u.status === 'active'
          ? el('button', { class: 'btn danger', onclick: async () => {
            const v = await dialog({ title: 'Suspend account?', text: 'Signs the user out everywhere and blocks sign-in.', fields: [{ name: 'reason', label: 'Reason (visible to admins)' }], confirmText: 'Suspend', danger: true });
            if (v) act(() => api('POST', `/api/admin/users/${u.id}/suspend`, { reason: v.reason || undefined }), 'Account suspended');
          } }, 'Suspend')
          : el('button', { class: 'btn', onclick: () => act(() => api('POST', `/api/admin/users/${u.id}/reactivate`, {}), 'Account reactivated') }, 'Reactivate'),
        el('button', { class: 'btn', onclick: () => act(() => api('POST', `/api/admin/users/${u.id}/unlock`, {}), 'Login lock cleared') }, 'Clear login lock'),
        el('button', { class: 'btn', onclick: async () => {
          const v = await dialog({ title: 'Set a new password', text: 'Give the new password to the customer through a secure channel. They are signed out everywhere.', fields: [{ name: 'password', label: 'New password (10+ chars, letters and numbers)', type: 'password', required: true }], confirmText: 'Set password' });
          if (v) act(() => api('POST', `/api/admin/users/${u.id}/password`, { password: v.password }), 'Password changed');
        } }, 'Reset password'),
        el('button', { class: 'btn', onclick: () => act(() => api('POST', `/api/admin/users/${u.id}/sessions/revoke`, {}), 'Sessions revoked') }, 'Sign out everywhere'))),
      el('div', { class: 'card' }, el('h2', {}, 'Entitlement now'), el('dl', { class: 'kv' },
        el('dt', {}, 'State'), el('dd', {}, statusBadge(e.state)),
        el('dt', {}, 'Plan'), el('dd', {}, e.plan?.name || (e.kind === 'trial' ? 'Trial' : '—')),
        el('dt', {}, 'Covered until'), el('dd', {}, fmtDate(e.coveredUntil || e.expiresAt)),
        el('dt', {}, 'Features'), el('dd', {}, Object.entries(e.features).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'),
        el('dt', {}, 'Devices'), el('dd', {}, `${e.devicesUsed} of ${e.deviceLimit}`)))),
    el('div', { class: 'card' }, el('h2', {}, 'Grant subscription'),
      el('form', { class: 'form', onsubmit: (ev) => {
        ev.preventDefault();
        const f = ev.target;
        act(() => api('POST', `/api/admin/users/${u.id}/subscriptions`, { planId: Number(f.planId.value), durationDays: f.durationDays.value ? Number(f.durationDays.value) : undefined, note: f.note.value || undefined }), 'Subscription granted');
      } },
      el('label', {}, 'Plan', el('select', { name: 'planId', required: true }, ps.map((p) => el('option', { value: p.id }, `${p.name}${p.isActive ? '' : ' (inactive)'} · ${p.durationDays}d`)))),
      el('label', {}, 'Days (blank = plan default)', el('input', { name: 'durationDays', type: 'number', min: 1, max: 3650 })),
      el('label', {}, 'Note', el('input', { name: 'note', maxlength: 300 })),
      el('button', { class: 'btn primary' }, 'Grant')),
      el('p', { class: 'note' }, 'New paid time starts when current paid coverage ends. Grants are audited.')),
    el('div', { class: 'card' }, el('h2', {}, 'Subscriptions'), table(subColumns(false), d.subscriptions, { empty: 'No subscriptions.' })),
    el('div', { class: 'card' }, el('h2', {}, 'Devices'), table(deviceColumns(false), d.devices, { empty: 'No devices registered.' })),
    el('div', { class: 'card' }, el('h2', {}, 'Activation codes'), table(codeColumns, d.codes, { empty: 'No codes assigned or redeemed.' })),
    el('div', { class: 'card' }, el('h2', {}, 'Activity'), auditTable(d.activity)),
    el('div', { class: 'card' }, el('h2', {}, 'Client errors'), table([
      { label: 'When', render: (r) => fmtDate(r.created_at) }, { label: 'Source', key: 'source' }, { label: 'Message', render: (r) => el('pre', {}, r.message) },
    ], d.errors, { empty: 'No errors reported.' })),
  ];
};

views.subscriptions = async (q) => {
  const data = await api('GET', '/api/admin/subscriptions' + qs(q));
  return [
    el('h1', {}, 'Subscriptions'),
    el('div', { class: 'card' },
      filterBar([
        { name: 'q', label: 'Search email', grow: true },
        { name: 'state', label: 'State', options: [['', 'Any'], ['current', 'Current'], ['expired', 'Expired'], ['suspended', 'Suspended'], ['revoked', 'Revoked']] },
        { name: 'kind', label: 'Kind', options: [['', 'Any'], ['paid', 'Paid'], ['trial', 'Trial']] },
      ], q, (v) => setHashQuery('#/subscriptions', v)),
      table(subColumns(true), data.items),
      pager(data, (p) => setHashQuery('#/subscriptions', { ...q, page: p }))),
  ];
};

async function editPlan(p, featureKeys) {
  const isNew = !p;
  p = p || { code: '', name: '', description: '', priceCents: 0, currency: 'USD', durationDays: 30, deviceLimit: 1, features: {}, isActive: false, isFeatured: false, displayOrder: 0 };
  const v = await dialog({
    title: isNew ? 'New plan' : `Edit plan: ${p.name}`,
    text: isNew ? null : 'Changes apply to new subscriptions only. Existing subscriptions keep the device limit and features they were sold with.',
    fields: [
      { name: 'code', label: 'Code (lowercase, permanent once used)', value: p.code, required: true },
      { name: 'name', label: 'Name', value: p.name, required: true },
      { name: 'description', label: 'Description', type: 'textarea', value: p.description },
      { name: 'price', label: 'Price', type: 'number', min: 0, step: '0.01', value: (p.priceCents / 100).toFixed(2) },
      { name: 'currency', label: 'Currency (ISO code)', value: p.currency },
      { name: 'durationDays', label: 'Duration (days)', type: 'number', min: 1, value: p.durationDays },
      { name: 'deviceLimit', label: 'Device limit', type: 'number', min: 1, value: p.deviceLimit },
      { name: 'displayOrder', label: 'Display order', type: 'number', min: 0, value: p.displayOrder },
      ...featureKeys.map((k) => ({ name: 'f_' + k, label: `Feature: ${k}`, type: 'checkbox', value: !!p.features[k] })),
      { name: 'isActive', label: 'Active (offered and usable for codes)', type: 'checkbox', value: p.isActive },
      { name: 'isFeatured', label: 'Featured', type: 'checkbox', value: p.isFeatured },
    ],
    confirmText: isNew ? 'Create plan' : 'Save changes',
  });
  if (!v) return;
  const body = {
    code: v.code.trim(), name: v.name.trim(), description: v.description, priceCents: Math.round(Number(v.price) * 100), currency: v.currency.trim().toUpperCase(),
    durationDays: Number(v.durationDays), deviceLimit: Number(v.deviceLimit), displayOrder: Number(v.displayOrder),
    features: Object.fromEntries(featureKeys.map((k) => [k, v['f_' + k]])), isActive: v.isActive, isFeatured: v.isFeatured,
  };
  await act(() => (isNew ? api('POST', '/api/admin/plans', body) : api('PATCH', `/api/admin/plans/${p.id}`, body)), isNew ? 'Plan created' : 'Plan saved');
}

views.plans = async () => {
  const r = await api('GET', '/api/admin/plans');
  return [
    el('h1', {}, 'Subscription plans', el('button', { class: 'btn sm', onclick: () => editPlan(null, r.featureKeys) }, '+ New plan')),
    el('div', { class: 'card' }, table([
      { label: 'Order', key: 'displayOrder' },
      { label: 'Name', render: (p) => [p.name, p.isFeatured ? ' ★' : '', el('div', { class: 'muted small mono' }, p.code)] },
      { label: 'Price', render: (p) => money(p.priceCents, p.currency) },
      { label: 'Duration', render: (p) => `${p.durationDays} days` },
      { label: 'Devices', key: 'deviceLimit' },
      { label: 'Features', render: (p) => Object.entries(p.features).filter(([, x]) => x).map(([k]) => k).join(', ') || 'none' },
      { label: 'Status', render: (p) => (p.isActive ? statusBadge('active') : badge('inactive')) },
      { label: 'Subscriptions', key: 'subscriptionCount' },
      { label: '', render: (p) => el('button', { class: 'btn sm', onclick: () => editPlan(p, r.featureKeys) }, 'Edit') },
    ], r.items, { empty: 'No plans yet. Create one to start issuing activation codes.' }),
    el('p', { class: 'note' }, 'Plans are never deleted; deactivate them instead. There is no payment processor integration: sell codes through your own channel.')),
  ];
};

views.codes = async (q) => {
  const [data, ps] = await Promise.all([api('GET', '/api/admin/codes' + qs(q)), plans()]);
  const out = el('div', { hidden: true });
  const genForm = el('form', { class: 'form', onsubmit: async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = $('button', f);
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/admin/codes', {
        planId: Number(f.planId.value), count: Number(f.count.value),
        durationDays: f.durationDays.value ? Number(f.durationDays.value) : undefined,
        assignedEmail: f.assignedEmail.value.trim() || undefined,
        validUntil: f.validUntil.value ? new Date(f.validUntil.value).toISOString() : undefined,
        note: f.note.value || undefined,
      });
      const text = r.codes.map((c) => c.code).join('\n');
      const csv = 'code,plan,batch\n' + r.codes.map((c) => `${c.code},"${r.plan.name.replace(/"/g, '""')}",${r.batchId}`).join('\n');
      out.hidden = false;
      out.replaceChildren(
        el('div', { class: 'warnbox' }, `${r.codes.length} code(s) generated for ${r.plan.name}. They are shown only now; the server stores hashes. Copy or download them before leaving this page.`),
        el('textarea', { class: 'codes-out', readonly: true }, text),
        el('div', { class: 'toolbar' },
          el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) }, 'Copy'),
          el('a', { class: 'btn', download: `roundledger-codes-${r.batchId.slice(0, 8)}.csv`, href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })) }, 'Download CSV')));
      toast('Codes generated');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  } },
  el('label', {}, 'Plan', el('select', { name: 'planId' }, ps.filter((p) => p.isActive).map((p) => el('option', { value: p.id }, `${p.name} · ${p.durationDays}d`)))),
  el('label', {}, 'How many', el('input', { name: 'count', type: 'number', min: 1, max: 500, value: 1 })),
  el('label', {}, 'Days (blank = plan default)', el('input', { name: 'durationDays', type: 'number', min: 1, max: 3650 })),
  el('label', {}, 'Assign to email (optional)', el('input', { name: 'assignedEmail', type: 'email' })),
  el('label', {}, 'Must be redeemed by (optional)', el('input', { name: 'validUntil', type: 'datetime-local' })),
  el('label', {}, 'Note', el('input', { name: 'note', maxlength: 300 })),
  el('button', { class: 'btn primary' }, 'Generate'));
  return [
    el('h1', {}, 'Activation codes'),
    el('div', { class: 'card' }, el('h2', {}, 'Generate'), ps.some((p) => p.isActive) ? genForm : el('p', { class: 'muted' }, 'Activate a plan first.'), out),
    el('div', { class: 'card' }, el('h2', {}, 'Codes'),
      filterBar([
        { name: 'q', label: 'Search (email, hint, note)', grow: true },
        { name: 'status', label: 'Status', options: [['', 'Any'], ['available', 'Available'], ['redeemed', 'Redeemed'], ['revoked', 'Revoked']] },
      ], q, (v) => setHashQuery('#/codes', v)),
      table(codeColumns, data.items),
      pager(data, (p) => setHashQuery('#/codes', { ...q, page: p }))),
  ];
};

views.devices = async (q) => {
  const data = await api('GET', '/api/admin/devices' + qs(q));
  return [
    el('h1', {}, 'Devices'),
    el('div', { class: 'card' },
      filterBar([
        { name: 'q', label: 'Search (email, install id, name)', grow: true },
        { name: 'status', label: 'Status', options: [['', 'Any'], ['active', 'Active'], ['revoked', 'Revoked']] },
      ], q, (v) => setHashQuery('#/devices', v)),
      table(deviceColumns(true), data.items),
      pager(data, (p) => setHashQuery('#/devices', { ...q, page: p }))),
  ];
};

views.ai = async () => {
  const d = await api('GET', '/api/admin/ai');
  return [el('h1', {}, 'AI providers'),
    !d.encryptionAvailable ? el('div', { class: 'warnbox' }, 'APP_ENCRYPTION_KEY is not configured on the server, so API keys cannot be stored.') : null,
    ...Object.entries(d.providers).map(([name, p]) => providerCard(name, p, d.activeProvider === name)),
    el('p', { class: 'note' }, 'Only Google Gemini is implemented. The per-user daily limit is under Settings → usage.')];
};

const lastTest = {}; // provider → last test result line, kept across re-renders

function providerCard(name, p, active) {
  const modelSelect = el('select', { name: 'model' }, el('option', { value: p.model }, p.model || '— select a model —'));
  const testOut = el('div', { class: 'note' }, lastTest[name] || '');
  const loadModels = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/admin/ai/${name}/models`, {});
      modelSelect.replaceChildren(el('option', { value: '' }, '— select a model —'), ...r.models.map((m) => el('option', { value: m.id, selected: m.id === p.model || null }, `${m.displayName} (${m.id})`)));
      toast(`${r.models.length} models available`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  const runTest = async (mode, btn) => {
    let body = { mode };
    if (mode === 'generate') {
      const v = await dialog({ title: 'Run a generation test?', text: `This sends a one-line prompt to ${p.displayName} using model "${modelSelect.value || p.model}". Depending on your Google account this may be billed.`,
        fields: [{ name: 'confirm', label: 'I understand this may incur charges', type: 'checkbox' }], confirmText: 'Run test' });
      if (!v) return;
      if (!v.confirm) return toast('Confirmation is required for a generation test.', true);
      body = { mode, confirmCharges: true, model: modelSelect.value || undefined };
    }
    btn.disabled = true;
    testOut.textContent = 'Running…';
    try {
      const r = await api('POST', `/api/admin/ai/${name}/test`, body);
      lastTest[name] = mode === 'models'
        ? `OK at ${fmtDate(r.executedAt)}: key accepted, ${r.modelCount} generateContent models listed.`
        : `OK at ${fmtDate(r.executedAt)}: ${r.model} replied "${r.reply}" in ${r.latencyMs} ms (${r.usage.totalTokens ?? '?'} tokens).`;
    } catch (err) {
      lastTest[name] = `Failed at ${fmtDate(Date.now())}: ${err.code || ''} ${err.message}`;
    } finally {
      btn.disabled = false;
      await route();
    }
  };
  const usageRow = (label, u) => [el('dt', {}, label), el('dd', {}, `${n0(u.requests)} requests · ${n0(u.errors)} errors · ${n0(u.promptTokens)} in / ${n0(u.outputTokens)} out tokens`)];
  return el('div', { class: 'card' },
    el('h2', {}, `${p.displayName} ${active ? '· active provider' : ''}`),
    el('div', { class: 'grid' },
      el('div', {},
        el('h2', {}, 'API key'),
        el('p', {}, p.credential.configured ? [statusBadge('ok'), ` ${p.credential.hint} · updated ${fmtDate(p.credential.updatedAt)}`] : badge('not set', 'bad')),
        el('form', { class: 'toolbar', onsubmit: (ev) => {
          ev.preventDefault();
          const v = ev.target.apiKey.value.trim();
          ev.target.apiKey.value = '';
          act(() => api('PUT', `/api/admin/ai/${name}/credential`, { apiKey: v }), 'API key saved');
        } },
        el('label', { class: 'grow' }, p.credential.configured ? 'Replace key (write-only)' : 'Set key (write-only)', el('input', { name: 'apiKey', type: 'password', autocomplete: 'off', required: true, placeholder: '••••••••' })),
        el('button', { class: 'btn' }, 'Save key')),
        p.credential.configured ? el('button', { class: 'btn sm danger', onclick: async () => {
          const v = await dialog({ title: 'Delete API key?', text: 'The provider is disabled until a new key is saved.', confirmText: 'Delete', danger: true });
          if (v) act(() => api('DELETE', `/api/admin/ai/${name}/credential`), 'Key deleted');
        } }, 'Delete key') : null),
      el('div', {},
        el('h2', {}, 'Usage'),
        el('dl', { class: 'kv small' }, usageRow('Today (UTC)', p.usage.today), usageRow('Last 7 days', p.usage.last7Days)),
        el('p', { class: 'note' }, 'Counts are recorded by this server from provider responses (usageMetadata). Check Google AI Studio for billing.'))),
    el('h2', {}, 'Configuration'),
    el('form', { class: 'form', onsubmit: (ev) => {
      ev.preventDefault();
      const f = ev.target;
      act(() => api('PUT', `/api/admin/ai/${name}`, {
        enabled: f.enabled.checked, model: f.model.value, temperature: Number(f.temperature.value), maxOutputTokens: Number(f.maxOutputTokens.value),
        timeoutMs: Number(f.timeoutMs.value), globalDailyRequestLimit: Number(f.globalDailyRequestLimit.value), makeActive: true,
      }), 'Configuration saved');
    } },
    el('label', { class: 'full' }, 'Model', el('div', { class: 'toolbar' }, modelSelect, el('button', { class: 'btn', type: 'button', onclick: (e) => loadModels(e.target) }, 'Fetch available models'))),
    el('label', {}, 'Temperature (0–2)', el('input', { name: 'temperature', type: 'number', min: 0, max: 2, step: '0.1', value: p.temperature })),
    el('label', {}, 'Max output tokens', el('input', { name: 'maxOutputTokens', type: 'number', min: 64, max: 8192, value: p.maxOutputTokens })),
    el('label', {}, 'Timeout (ms)', el('input', { name: 'timeoutMs', type: 'number', min: 2000, max: 120000, step: 1000, value: p.timeoutMs })),
    el('label', {}, 'Max analyses per day (all users)', el('input', { name: 'globalDailyRequestLimit', type: 'number', min: 0, value: p.globalDailyRequestLimit })),
    el('label', { class: 'check' }, el('input', { name: 'enabled', type: 'checkbox', checked: p.enabled }), 'Enabled for customers'),
    el('button', { class: 'btn primary' }, 'Save configuration')),
    el('h2', {}, 'Connection test'),
    el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: (e) => runTest('models', e.target) }, 'Test key (lists models, no generation)'),
      el('button', { class: 'btn', onclick: (e) => runTest('generate', e.target) }, 'Test generation (may be billed)…')),
    testOut,
    el('h2', {}, 'Recent errors'),
    table([
      { label: 'When', render: (r) => fmtDate(r.created_at) }, { label: 'Purpose', key: 'purpose' }, { label: 'Model', render: (r) => r.model || '—' },
      { label: 'Code', render: (r) => statusBadge(r.error_code) }, { label: 'Message', render: (r) => el('pre', {}, r.error_message || '') },
    ], p.recentErrors, { empty: 'No errors recorded.' }));
}

// ---- settings
const SETTING_LABELS = {
  branding: 'Branding & public information', registration: 'Registration', trial: 'Free trial', licensing: 'Licence & device policy',
  usage: 'Usage limits', maintenance: 'Maintenance mode', extension: 'Extension versions',
};
const FIELD_HELP = {
  durationDays: 'days', deviceLimit: 'devices', defaultDeviceLimit: 'devices for accounts without a subscription',
  selfRemovalCooldownHours: 'hours between self-service device removals', aiRequestsPerUserPerDay: 'AI explanations per user per UTC day',
  maxStoredRoundsPerPlatform: 'cloud rounds kept per user and platform', minimumVersion: 'older extensions are told to update', latestVersion: 'e.g. 0.2.0',
};

function settingsForm(key, value) {
  const inputs = [];
  const build = (obj, prefix = '') => Object.entries(obj).map(([k, v]) => {
    const path = prefix + k;
    if (v && typeof v === 'object' && !Array.isArray(v)) return el('fieldset', { class: 'full' }, el('legend', { class: 'muted small' }, k), el('div', { class: 'form' }, build(v, path + '.')));
    let input;
    if (typeof v === 'boolean') input = el('input', { type: 'checkbox', checked: v });
    else if (typeof v === 'number') input = el('input', { type: 'number', value: v, step: 'any' });
    else input = el('input', { value: v ?? '' });
    inputs.push({ path, input, type: typeof v });
    const help = FIELD_HELP[k] ? el('span', { class: 'muted small' }, FIELD_HELP[k]) : null;
    return typeof v === 'boolean' ? el('label', { class: 'check' }, input, k) : el('label', {}, k, input, help);
  });
  const collect = () => {
    const out = structuredClone(value);
    for (const { path, input, type } of inputs) {
      const parts = path.split('.');
      let o = out;
      for (const p of parts.slice(0, -1)) o = o[p];
      o[parts.at(-1)] = type === 'boolean' ? input.checked : type === 'number' ? Number(input.value) : input.value;
    }
    return out;
  };
  return el('div', { class: 'card' }, el('h2', {}, SETTING_LABELS[key] || key),
    el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); act(() => api('PUT', `/api/admin/settings/${key}`, collect()), `${SETTING_LABELS[key] || key} saved`); } },
      build(value), el('button', { class: 'btn primary' }, 'Save')),
    key === 'trial' ? el('p', { class: 'note' }, 'Each account and each installation can claim one trial. Changing the duration affects new trials only.') : null,
    key === 'maintenance' ? el('p', { class: 'note' }, 'While enabled, customers get a 503 with the message above; administrators keep access.') : null);
}

function platformsEditor(list) {
  const areas = list.map((p) => {
    const ta = el('textarea', {}, JSON.stringify(p, null, 2));
    return { ta, node: el('div', { class: 'full' }, el('label', {}, `${p.name} (${p.id})`, ta)) };
  });
  return el('div', { class: 'card' }, el('h2', {}, 'Supported platforms'),
    el('div', { class: 'warnbox' }, 'Only mark an adapter "verified": true after confirming its event map against real traffic in an authorized environment. The 1xBet adapter ships unconfigured because no verified observation exists.'),
    el('form', { class: 'form', onsubmit: (e) => {
      e.preventDefault();
      let platforms;
      try { platforms = areas.map((a) => JSON.parse(a.ta.value)); } catch (err) { return toast('Invalid JSON: ' + err.message, true); }
      act(() => api('PUT', '/api/admin/settings/platforms', { platforms }), 'Platforms saved');
    } }, areas.map((a) => a.node), el('button', { class: 'btn primary' }, 'Save platforms')),
    el('p', { class: 'note' }, 'Fields: pageUrlPatterns (Chrome match patterns, https only), socketUrlContains (substring of the game WebSocket URL), events (SignalR invocation targets and field names). Extensions pick up changes within 30 minutes or on panel open.'));
}

views.settings = async () => {
  const s = await api('GET', '/api/admin/settings');
  return [el('h1', {}, 'Settings'), ...['maintenance', 'branding', 'registration', 'trial', 'licensing', 'usage', 'extension'].map((k) => settingsForm(k, s[k])), platformsEditor(s.platforms)];
};

views.audit = async (q) => {
  const data = await api('GET', '/api/admin/audit' + qs(q));
  return [el('h1', {}, 'Audit log'), el('div', { class: 'card' },
    filterBar([
      { name: 'action', label: 'Action contains', grow: true, placeholder: 'e.g. subscription, ai., auth.login' },
      { name: 'actor', label: 'Actor email' },
      { name: 'outcome', label: 'Outcome', options: [['', 'Any'], ['success', 'Success'], ['failure', 'Failure']] },
    ], q, (v) => setHashQuery('#/audit', v)),
    auditTable(data.items),
    pager(data, (p) => setHashQuery('#/audit', { ...q, page: p })))];
};

views.errors = async (q) => {
  const data = await api('GET', '/api/admin/errors' + qs(q));
  return [el('h1', {}, 'Client errors'), el('div', { class: 'card' },
    table([
      { label: 'When', render: (r) => fmtDate(r.created_at) },
      { label: 'User', render: (r) => (r.user_id ? el('a', { href: `#/users/${r.user_id}` }, r.email || r.user_id) : '—') },
      { label: 'Source', key: 'source' },
      { label: 'Message', render: (r) => el('pre', {}, r.message) },
      { label: 'Context', render: (r) => (r.context ? el('pre', {}, r.context) : '') },
    ], data.items, { empty: 'No errors reported by extensions.' }),
    pager(data, (p) => setHashQuery('#/errors', { ...q, page: p })))];
};

// ------------------------------------------------------------------ router
async function route() {
  const [pathPart, query = ''] = location.hash.replace(/^#/, '').split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const q = Object.fromEntries(new URLSearchParams(query));
  let name = segs[0] || 'overview';
  let arg;
  if (name === 'users' && segs[1]) { name = 'user'; arg = segs[1]; }
  const fn = views[name] || views.overview;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.getAttribute('href') === '#/' + (name === 'user' ? 'users' : name));
  try {
    const nodes = await fn(q, arg);
    main.replaceChildren(...[nodes].flat().filter(Boolean));
  } catch (err) {
    if (err.status === 401) return;
    main.replaceChildren(el('h1', {}, 'Error'), el('p', { class: 'err' }, err.message));
  }
}

async function start() {
  $('#login').hidden = true;
  $('#shell').hidden = false;
  $('#whoami').textContent = me?.email || '';
  await route();
}

window.addEventListener('hashchange', () => { if (me) route(); });

// Probe the session cookie on load.
(async () => {
  try {
    await api('GET', '/api/admin/overview');
    const who = await api('GET', '/api/me');
    me = who.user;
    start();
  } catch {
    showLogin();
  }
})();
