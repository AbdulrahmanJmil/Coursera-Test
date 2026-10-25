import { badRequest } from './http.js';
import { DEFAULT_PLATFORM_CONFIGS, ADAPTERS } from '../../shared/adapters/index.js';

export const FEATURE_KEYS = ['aiAnalysis', 'cloudHistory'];

export const DEFAULT_SETTINGS = {
  branding: {
    productName: 'RoundLedger',
    tagline: 'Round history and session tracking for crash games',
    supportEmail: '',
    supportUrl: '',
    responsibleGamblingUrl: 'https://www.begambleaware.org/',
  },
  registration: { enabled: true },
  trial: { enabled: true, durationDays: 3, deviceLimit: 1, features: { aiAnalysis: false, cloudHistory: true } },
  licensing: { defaultDeviceLimit: 1, allowSelfDeviceRemoval: true, selfRemovalCooldownHours: 24 },
  usage: { aiRequestsPerUserPerDay: 20, maxRoundsPerUpload: 500, maxStoredRoundsPerPlatform: 20000 },
  maintenance: { enabled: false, message: '' },
  platforms: DEFAULT_PLATFORM_CONFIGS,
  extension: { latestVersion: '', minimumVersion: '', downloadUrl: '' },
  ai: {
    activeProvider: 'gemini',
    providers: {
      gemini: { enabled: false, model: '', temperature: 0.3, maxOutputTokens: 800, timeoutMs: 20000, globalDailyRequestLimit: 1000 },
    },
  },
};

// ---- small validation helpers -------------------------------------------------
const fail = (path, msg) => { throw badRequest(`${path}: ${msg}`, { field: path }); };
const obj = (v, p) => (v && typeof v === 'object' && !Array.isArray(v) ? v : fail(p, 'must be an object'));
const b = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'must be true or false'));
const i = (v, p, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : fail(p, `must be an integer ${min}–${max}`));
const n = (v, p, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(p, `must be a number ${min}–${max}`));
const s = (v, p, max, re) => (typeof v === 'string' && v.length <= max && (!re || v === '' || re.test(v)) ? v.trim() : fail(p, `must be text up to ${max} characters${re ? ' in a valid format' : ''}`));
const URL_RE = /^https:\/\/[^\s]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const IDENT_RE = /^\w{1,64}$/;
const MATCH_RE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/[^\s]*$/i;

function features(v, p) {
  obj(v, p);
  const out = {};
  for (const k of FEATURE_KEYS) out[k] = v[k] === undefined ? false : b(v[k], `${p}.${k}`);
  return out;
}

function eventMap(v, p) {
  obj(v, p);
  const out = {};
  const spec = {
    roundOpen: ['target', 'roundKeyField'],
    betting: ['target'],
    running: ['target'],
    crashed: ['target', 'multiplierField', 'roundKeyField'],
    snapshot: ['target', 'roundKeyField', 'historyField', 'historyMultiplierField', 'historyRoundKeyField'],
  };
  for (const [name, fields] of Object.entries(spec)) {
    if (v[name] == null) continue;
    const e = obj(v[name], `${p}.${name}`);
    const o = {};
    for (const f of fields) {
      if (e[f] == null || e[f] === '') continue;
      if (typeof e[f] !== 'string' || !IDENT_RE.test(e[f])) fail(`${p}.${name}.${f}`, 'must be an identifier');
      o[f] = e[f];
    }
    if (!o.target) fail(`${p}.${name}.target`, 'is required');
    if (name === 'crashed' && !o.multiplierField) fail(`${p}.crashed.multiplierField`, 'is required');
    out[name] = o;
  }
  return out;
}

function platform(v, p) {
  obj(v, p);
  if (!ADAPTERS[v.id]) fail(`${p}.id`, 'unknown platform adapter');
  const patterns = Array.isArray(v.pageUrlPatterns) ? v.pageUrlPatterns : fail(`${p}.pageUrlPatterns`, 'must be a list');
  if (patterns.length > 20) fail(`${p}.pageUrlPatterns`, 'at most 20 patterns');
  patterns.forEach((m, k) => (typeof m === 'string' && m.length <= 300 && MATCH_RE.test(m) ? 0 : fail(`${p}.pageUrlPatterns[${k}]`, 'must look like https://host/path*')));
  return {
    id: v.id,
    name: s(v.name, `${p}.name`, 60) || fail(`${p}.name`, 'is required'),
    enabled: b(v.enabled, `${p}.enabled`),
    verified: b(v.verified, `${p}.verified`),
    protocol: v.protocol === 'signalr-json' ? v.protocol : fail(`${p}.protocol`, 'only signalr-json is supported'),
    pageUrlPatterns: patterns,
    socketUrlContains: s(v.socketUrlContains ?? '', `${p}.socketUrlContains`, 120),
    events: eventMap(v.events ?? {}, `${p}.events`),
  };
}

export const VALIDATORS = {
  branding: (v) => ({
    productName: s(v.productName, 'productName', 60) || fail('productName', 'is required'),
    tagline: s(v.tagline ?? '', 'tagline', 140),
    supportEmail: s(v.supportEmail ?? '', 'supportEmail', 200, /^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    supportUrl: s(v.supportUrl ?? '', 'supportUrl', 300, URL_RE),
    responsibleGamblingUrl: s(v.responsibleGamblingUrl ?? '', 'responsibleGamblingUrl', 300, URL_RE),
  }),
  registration: (v) => ({ enabled: b(v.enabled, 'enabled') }),
  trial: (v) => ({
    enabled: b(v.enabled, 'enabled'),
    durationDays: i(v.durationDays, 'durationDays', 1, 90),
    deviceLimit: i(v.deviceLimit, 'deviceLimit', 1, 10),
    features: features(v.features ?? {}, 'features'),
  }),
  licensing: (v) => ({
    defaultDeviceLimit: i(v.defaultDeviceLimit, 'defaultDeviceLimit', 1, 20),
    allowSelfDeviceRemoval: b(v.allowSelfDeviceRemoval, 'allowSelfDeviceRemoval'),
    selfRemovalCooldownHours: i(v.selfRemovalCooldownHours, 'selfRemovalCooldownHours', 0, 24 * 30),
  }),
  usage: (v) => ({
    aiRequestsPerUserPerDay: i(v.aiRequestsPerUserPerDay, 'aiRequestsPerUserPerDay', 0, 1000),
    maxRoundsPerUpload: i(v.maxRoundsPerUpload, 'maxRoundsPerUpload', 1, 2000),
    maxStoredRoundsPerPlatform: i(v.maxStoredRoundsPerPlatform, 'maxStoredRoundsPerPlatform', 100, 200000),
  }),
  maintenance: (v) => ({ enabled: b(v.enabled, 'enabled'), message: s(v.message ?? '', 'message', 300) }),
  platforms: (v) => {
    if (!Array.isArray(v)) fail('platforms', 'must be a list');
    const out = v.map((x, k) => platform(x, `platforms[${k}]`));
    if (new Set(out.map((x) => x.id)).size !== out.length) fail('platforms', 'duplicate platform id');
    return out;
  },
  extension: (v) => ({
    latestVersion: s(v.latestVersion ?? '', 'latestVersion', 20, VERSION_RE),
    minimumVersion: s(v.minimumVersion ?? '', 'minimumVersion', 20, VERSION_RE),
    downloadUrl: s(v.downloadUrl ?? '', 'downloadUrl', 300, URL_RE),
  }),
};

export class Settings {
  constructor(db) {
    this.db = db;
  }

  get(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const def = DEFAULT_SETTINGS[key];
    if (!row) return structuredClone(def);
    const stored = JSON.parse(row.value);
    return Array.isArray(def) ? stored : { ...structuredClone(def), ...stored };
  }

  /** Validates and stores; returns { before, after }. */
  set(key, value, actorId) {
    let after = value;
    if (VALIDATORS[key]) after = VALIDATORS[key](key === 'platforms' ? value : obj(value, key));
    else if (!(key in DEFAULT_SETTINGS)) throw badRequest(`Unknown setting ${key}`);
    const before = this.get(key);
    this.db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(key, JSON.stringify(after), Date.now(), actorId ?? null);
    return { before, after };
  }

  all() {
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = this.get(key);
    return out;
  }
}
