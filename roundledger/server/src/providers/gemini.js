// Google Gemini API (Generative Language API, v1beta REST).
// Auth uses the x-goog-api-key header so the key never appears in URLs or logs.
// Model ids are not hard-coded: administrators pick one from models.list.

import { ProviderError } from './errors.js';

export const id = 'gemini';
export const displayName = 'Google Gemini';
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-]{1,80}$/;

async function call(url, { apiKey, timeoutMs, method = 'GET', body, fetchImpl = fetch }) {
  if (!apiKey) throw new ProviderError('MISSING_CREDENTIALS', 'No Gemini API key is configured.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { 'x-goog-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ProviderError('TIMEOUT', `Gemini did not respond within ${timeoutMs} ms.`, { retryable: true });
    throw new ProviderError('NETWORK_ERROR', `Could not reach Gemini: ${err.cause?.code || err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  const text = await res.text().catch(() => '');
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw mapError(res.status, json, text);
  if (!json) throw new ProviderError('BAD_RESPONSE', 'Gemini returned an empty or non-JSON response.', { status: res.status });
  return json;
}

export function mapError(status, json, text) {
  const err = json?.error || {};
  const msg = err.message || String(text || '').slice(0, 200) || `HTTP ${status}`;
  const reasons = (err.details || []).map((d) => d.reason).filter(Boolean);
  if (reasons.includes('API_KEY_INVALID') || /API key not valid/i.test(msg)) return new ProviderError('INVALID_CREDENTIALS', 'Gemini rejected the API key.', { status });
  if (status === 401 || status === 403) return new ProviderError('PERMISSION_DENIED', msg, { status });
  if (status === 404) return new ProviderError('MODEL_NOT_FOUND', msg, { status });
  if (status === 429) return new ProviderError('RATE_LIMITED', msg, { status, retryable: true });
  if (status >= 500) return new ProviderError('PROVIDER_ERROR', msg, { status, retryable: true });
  return new ProviderError('PROVIDER_ERROR', msg, { status });
}

/** Lists models that support generateContent. Listing does not generate tokens. */
export async function listModels({ apiKey, baseUrl, timeoutMs = 15000, fetchImpl }) {
  const models = [];
  let pageToken = '';
  for (let pageNo = 0; pageNo < 5; pageNo++) {
    const q = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) q.set('pageToken', pageToken);
    const json = await call(`${baseUrl}/v1beta/models?${q}`, { apiKey, timeoutMs, fetchImpl });
    for (const m of json.models || []) {
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      const mid = String(m.name || '').replace(/^models\//, '');
      if (!MODEL_ID_RE.test(mid)) continue;
      models.push({ id: mid, displayName: m.displayName || mid, inputTokenLimit: m.inputTokenLimit ?? null, outputTokenLimit: m.outputTokenLimit ?? null });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return models;
}

/** Single-turn text generation. Thought parts are excluded from the returned text. */
export async function generate({ apiKey, baseUrl, model, system, prompt, temperature, maxOutputTokens, timeoutMs = 20000, fetchImpl }) {
  if (!MODEL_ID_RE.test(model || '')) throw new ProviderError('MODEL_NOT_FOUND', 'No valid Gemini model is selected.');
  const started = Date.now();
  const json = await call(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    apiKey, timeoutMs, method: 'POST', fetchImpl,
    body: {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    },
  });
  if (json.promptFeedback?.blockReason) throw new ProviderError('BLOCKED', `Request blocked by Gemini (${json.promptFeedback.blockReason}).`);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  const u = json.usageMetadata || {};
  const usage = {
    promptTokens: u.promptTokenCount ?? null,
    outputTokens: u.candidatesTokenCount != null || u.thoughtsTokenCount != null ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : null,
    totalTokens: u.totalTokenCount ?? null,
  };
  if (!text) {
    const reason = cand?.finishReason || 'NO_CANDIDATE';
    throw Object.assign(new ProviderError(reason === 'SAFETY' ? 'BLOCKED' : 'BAD_RESPONSE', `Gemini returned no text (finishReason: ${reason}).`), { usage });
  }
  return { text, finishReason: cand.finishReason || null, usage, latencyMs: Date.now() - started, modelVersion: json.modelVersion || model };
}
