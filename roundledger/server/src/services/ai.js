import { PROVIDERS } from '../providers/index.js';
import { ProviderError } from '../providers/errors.js';
import { HttpError, badRequest, notFound } from '../http.js';
import { buildSummary, normalizeRounds } from '../../../shared/analysis.js';
import { computeEntitlement, requireFeature } from './entitlements.js';
import { DEFAULT_SETTINGS } from '../settings.js';

export const MIN_ROUNDS_FOR_ANALYSIS = 30;
const DAY = 86400_000;
const secretName = (provider) => `ai.${provider}.apiKey`;
const startOfUtcDay = (now) => now - (now % DAY);

export const SYSTEM_INSTRUCTION = `You are the explanation assistant inside RoundLedger, a round-history tracker for crash games.
You receive descriptive statistics computed from rounds this user observed, plus a statistical test of a common "streak" belief.
Explain in plain language, in at most 180 words, what the numbers show.
Rules you must follow:
- Crash outcomes are generated independently by the operator's random number generator. Past rounds do not change the odds of future rounds.
- Never predict a future multiplier or the outcome of any upcoming round.
- Never recommend whether, when or how much to bet, or any cash-out target.
- Never describe a pattern as an edge, signal or opportunity. If the test shows no significant difference, say so plainly; if it shows one, explain that a single test on a finite sample can be chance.
- Mention the sample size and that small samples are noisy.
- If the data or the user asks for a prediction, decline briefly and explain why.
- You may note that the game has a built-in house edge and encourage time and spending limits.`;

function requireProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw notFound('AI provider');
  return p;
}

export class AiService {
  constructor({ db, settings, secrets, config }) {
    this.db = db;
    this.settings = settings;
    this.secrets = secrets;
    this.baseUrls = { gemini: config.geminiBaseUrl };
    this.inFlight = new Set();
  }

  providerConfig(name) {
    const ai = this.settings.get('ai');
    return { ...DEFAULT_SETTINGS.ai.providers[name], ...(ai.providers?.[name] || {}) };
  }

  /** Admin view: configuration with masked credential state. Never includes the key. */
  describe() {
    const ai = this.settings.get('ai');
    const providers = {};
    for (const [name, p] of Object.entries(PROVIDERS)) {
      providers[name] = {
        displayName: p.displayName,
        ...this.providerConfig(name),
        credential: this.secrets.describe(secretName(name)),
        usage: this.usageSummary(name),
        recentErrors: this.db.prepare(`SELECT created_at, purpose, error_code, error_message, model FROM ai_usage
          WHERE provider = ? AND outcome = 'error' ORDER BY id DESC LIMIT 10`).all(name),
      };
    }
    return { activeProvider: ai.activeProvider, encryptionAvailable: this.secrets.available, providers };
  }

  usageSummary(name, now = Date.now()) {
    const q = (since) => this.db.prepare(`SELECT COUNT(*) AS requests, SUM(outcome = 'ok') AS ok, SUM(outcome = 'error') AS errors,
      SUM(COALESCE(prompt_tokens, 0)) AS promptTokens, SUM(COALESCE(output_tokens, 0)) AS outputTokens, SUM(COALESCE(total_tokens, 0)) AS totalTokens
      FROM ai_usage WHERE provider = ? AND created_at >= ?`).get(name, since);
    return { today: q(startOfUtcDay(now)), last7Days: q(now - 7 * DAY) };
  }

  /** Public status used by the extension: no configuration detail beyond availability. */
  publicStatus() {
    const ai = this.settings.get('ai');
    const name = ai.activeProvider;
    if (!name || !PROVIDERS[name]) return { available: false, reason: 'not_configured' };
    const cfg = this.providerConfig(name);
    if (!cfg.enabled) return { available: false, reason: 'disabled' };
    if (!cfg.model || !this.secrets.describe(secretName(name)).configured) return { available: false, reason: 'not_configured' };
    return { available: true, provider: PROVIDERS[name].displayName };
  }

  updateProviderConfig(name, body, actorId) {
    requireProvider(name);
    const cur = this.providerConfig(name);
    const next = { ...cur };
    const check = (key, ok, msg) => {
      if (body[key] === undefined) return;
      if (!ok(body[key])) throw badRequest(`${key} ${msg}`, { field: key });
      next[key] = body[key];
    };
    check('enabled', (v) => typeof v === 'boolean', 'must be true or false');
    check('model', (v) => typeof v === 'string' && (v === '' || PROVIDERS[name].MODEL_ID_RE.test(v)), 'is not a valid model id');
    check('temperature', (v) => typeof v === 'number' && v >= 0 && v <= 2, 'must be between 0 and 2');
    check('maxOutputTokens', (v) => Number.isInteger(v) && v >= 64 && v <= 8192, 'must be an integer 64–8192');
    check('timeoutMs', (v) => Number.isInteger(v) && v >= 2000 && v <= 120000, 'must be an integer 2000–120000');
    check('globalDailyRequestLimit', (v) => Number.isInteger(v) && v >= 0 && v <= 100000, 'must be an integer 0–100000');
    if (next.enabled) {
      if (!next.model) throw badRequest('Select a model before enabling the provider.', { field: 'model' });
      if (!this.secrets.describe(secretName(name)).configured) throw badRequest('Add an API key before enabling the provider.', { field: 'enabled' });
    }
    const ai = this.settings.get('ai');
    ai.providers = { ...ai.providers, [name]: next };
    if (body.makeActive === true) ai.activeProvider = name;
    this.settings.set('ai', ai, actorId);
    return { before: cur, after: next };
  }

  setApiKey(name, apiKey, actorId) {
    requireProvider(name);
    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 300 || /\s/.test(apiKey)) {
      throw badRequest('API key must be 10–300 characters with no spaces.', { field: 'apiKey' });
    }
    this.secrets.set(secretName(name), apiKey, actorId);
    return this.secrets.describe(secretName(name));
  }

  deleteApiKey(name, actorId) {
    requireProvider(name);
    const removed = this.secrets.delete(secretName(name));
    const cfg = this.providerConfig(name);
    if (cfg.enabled) this.updateProviderConfig(name, { enabled: false }, actorId);
    return removed;
  }

  record(name, { userId, model, purpose, outcome, error, usage, latencyMs }) {
    this.db.prepare(`INSERT INTO ai_usage (user_id, provider, model, purpose, outcome, error_code, error_message, prompt_tokens,
      output_tokens, total_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId ?? null, name, model ?? null, purpose, outcome, error?.code ?? null, error ? String(error.message).slice(0, 500) : null,
      usage?.promptTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null, latencyMs ?? null, Date.now());
  }

  async withProvider(name, purpose, userId, fn) {
    const provider = requireProvider(name);
    const cfg = this.providerConfig(name);
    const apiKey = this.secrets.reveal(secretName(name));
    const started = Date.now();
    try {
      if (!apiKey) throw new ProviderError('MISSING_CREDENTIALS', 'No API key is configured for this provider.');
      const result = await fn(provider, { apiKey, baseUrl: this.baseUrls[name], timeoutMs: cfg.timeoutMs }, cfg);
      this.record(name, { userId, model: result.model ?? null, purpose, outcome: 'ok', usage: result.usage, latencyMs: Date.now() - started });
      return result;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      this.record(name, { userId, model: cfg.model, purpose, outcome: 'error', error: err, usage: err.usage, latencyMs: Date.now() - started });
      throw err;
    }
  }

  /** models.list — does not generate tokens. */
  async listModels(name, actorId) {
    const r = await this.withProvider(name, 'list_models', actorId, async (p, conn) => ({ models: await p.listModels(conn) }));
    return r.models;
  }

  /**
   * Connection test. mode "models" only lists models (no generation).
   * mode "generate" sends a tiny prompt and may be billed, so it requires
   * an explicit confirmCharges flag from the administrator.
   */
  async testConnection(name, { mode, confirmCharges, model }, actorId) {
    if (mode === 'models') {
      const models = await this.listModels(name, actorId);
      return { ok: true, mode, executedAt: Date.now(), modelCount: models.length };
    }
    if (mode !== 'generate') throw badRequest('mode must be "models" or "generate"');
    if (confirmCharges !== true) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'This test calls the model and may incur charges. Confirm to proceed.');
    const r = await this.withProvider(name, 'test_generate', actorId, async (p, conn, cfg) => {
      const useModel = model || cfg.model;
      const out = await p.generate({ ...conn, model: useModel, prompt: 'Reply with the single word OK.', temperature: 0, maxOutputTokens: 256 });
      return { ...out, model: useModel };
    });
    return { ok: true, mode, executedAt: Date.now(), model: r.model, reply: r.text.slice(0, 200), usage: r.usage, latencyMs: r.latencyMs };
  }

  async analyze(user, platform, now = Date.now()) {
    const ent = computeEntitlement(this.db, this.settings, user.id, now);
    if (!requireFeature(ent, 'aiAnalysis')) throw new HttpError(403, 'FEATURE_NOT_INCLUDED', 'AI explanations are not included in your current plan.');
    const status = this.publicStatus();
    if (!status.available) throw new HttpError(503, 'AI_UNAVAILABLE', 'AI explanations are not available right now.', { reason: status.reason });
    const name = this.settings.get('ai').activeProvider;
    const cfg = this.providerConfig(name);
    const perUser = this.settings.get('usage').aiRequestsPerUserPerDay;
    const dayStart = startOfUtcDay(now);
    const usedByUser = this.db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND purpose = 'analysis' AND created_at >= ?").get(user.id, dayStart).n;
    if (usedByUser >= perUser) throw new HttpError(429, 'AI_DAILY_LIMIT', `Daily limit of ${perUser} AI explanations reached.`, { limit: perUser });
    const usedGlobal = this.db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE provider = ? AND purpose = 'analysis' AND created_at >= ?").get(name, dayStart).n;
    if (usedGlobal >= cfg.globalDailyRequestLimit) throw new HttpError(503, 'AI_CAPACITY', 'AI explanations are temporarily unavailable (daily capacity reached).');

    const rows = this.db.prepare(`SELECT round_key AS roundKey, multiplier, observed_at AS observedAt FROM rounds
      WHERE user_id = ? AND platform = ? ORDER BY observed_at DESC LIMIT 5000`).all(user.id, platform);
    const { rounds } = normalizeRounds(rows);
    if (rounds.length < MIN_ROUNDS_FOR_ANALYSIS) {
      throw new HttpError(409, 'NOT_ENOUGH_DATA', `At least ${MIN_ROUNDS_FOR_ANALYSIS} synced rounds are needed (have ${rounds.length}).`);
    }
    if (this.inFlight.has(user.id)) throw new HttpError(429, 'AI_BUSY', 'An explanation is already being generated.');
    this.inFlight.add(user.id);
    try {
      const summary = buildSummary(rounds);
      const prompt = `Platform: ${platform}\nStatistics (JSON):\n${JSON.stringify(summary)}`;
      const r = await this.withProvider(name, 'analysis', user.id, async (p, conn, c) => {
        const out = await p.generate({ ...conn, model: c.model, system: SYSTEM_INSTRUCTION, prompt, temperature: c.temperature, maxOutputTokens: c.maxOutputTokens });
        return { ...out, model: c.model };
      });
      return { text: r.text, provider: PROVIDERS[name].displayName, model: r.model, basedOnRounds: rounds.length, generatedAt: Date.now() };
    } catch (err) {
      if (err instanceof ProviderError) throw new HttpError(502, 'AI_PROVIDER_ERROR', 'The AI provider could not complete the request. Try again later.', { providerCode: err.code });
      throw err;
    } finally {
      this.inFlight.delete(user.id);
    }
  }
}
