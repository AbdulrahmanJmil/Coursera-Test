// Descriptive statistics and rule evaluation for recorded crash-game rounds.
//
// Everything here describes rounds that have already happened. Nothing in this
// module predicts the next round: crash outcomes on provably-fair games are
// generated independently, and the evaluation helpers exist to measure (and
// usually show the absence of) any relationship between history and outcome.

export const MAX_MULTIPLIER = 1_000_000;
export const THRESHOLDS = [1.5, 2, 5, 10];
export const HISTOGRAM_BUCKETS = [
  { label: '1–1.2', min: 1, max: 1.2 },
  { label: '1.2–1.5', min: 1.2, max: 1.5 },
  { label: '1.5–2', min: 1.5, max: 2 },
  { label: '2–3', min: 2, max: 3 },
  { label: '3–5', min: 3, max: 5 },
  { label: '5–10', min: 5, max: 10 },
  { label: '10+', min: 10, max: Infinity },
];

export function isValidMultiplier(m) {
  return typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= MAX_MULTIPLIER;
}

export function isValidRoundKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 64 && /^[\w.:-]+$/.test(k);
}

const round2 = (x) => Math.round(x * 100) / 100;
const isNumericKey = (k) => /^\d{1,30}$/.test(k);
const cmpNumericKey = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Validates, de-duplicates and orders round records.
 * Duplicate round keys keep the earliest observation. When every key is a
 * plain integer the platform's own round order is used, otherwise observation
 * time — so events that arrive late or out of order still sort correctly.
 */
export function normalizeRounds(rounds) {
  const byKey = new Map();
  let rejected = 0;
  let duplicates = 0;
  for (const r of rounds || []) {
    const t = typeof r?.observedAt === 'number' ? r.observedAt : Date.parse(r?.observedAt);
    if (!r || !isValidRoundKey(r.roundKey) || !isValidMultiplier(r.multiplier) || !Number.isFinite(t)) {
      rejected++;
      continue;
    }
    const prev = byKey.get(r.roundKey);
    if (prev) {
      duplicates++;
      if (t >= prev.observedAt) continue;
    }
    byKey.set(r.roundKey, { ...r, roundKey: r.roundKey, multiplier: round2(r.multiplier), observedAt: t });
  }
  const list = [...byKey.values()];
  if (list.every((r) => isNumericKey(r.roundKey))) list.sort((a, b) => cmpNumericKey(a.roundKey, b.roundKey));
  else list.sort((a, b) => a.observedAt - b.observedAt || (a.roundKey < b.roundKey ? -1 : 1));
  return { rounds: list, rejected, duplicates };
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return round2(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function longestRun(values, pred) {
  let best = 0;
  let cur = 0;
  for (const v of values) {
    cur = pred(v) ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

function trailingRun(values, pred) {
  let n = 0;
  for (let i = values.length - 1; i >= 0 && pred(values[i]); i--) n++;
  return n;
}

/** Descriptive statistics for multipliers given in chronological order. */
export function describe(values) {
  const v = (values || []).filter(isValidMultiplier);
  const n = v.length;
  if (!n) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const shareAtLeast = {};
  for (const t of THRESHOLDS) shareAtLeast[t] = v.filter((x) => x >= t).length / n;
  return {
    n,
    min: s[0],
    max: s[n - 1],
    median: quantile(s, 0.5),
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    shareAtLeast,
    longestRunBelow2: longestRun(v, (x) => x < 2),
    currentRunBelow2: trailingRun(v, (x) => x < 2),
    histogram: HISTOGRAM_BUCKETS.map((b) => ({
      label: b.label,
      count: v.filter((x) => x >= b.min && x < b.max).length,
    })),
  };
}

// Abramowitz–Stegun 7.1.26 approximation, accurate to ~1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Two-sided two-proportion z-test. Returns null when it cannot be computed. */
export function twoProportionTest(h1, n1, h2, n2) {
  if (!n1 || !n2) return null;
  const p1 = h1 / n1;
  const p2 = h2 / n2;
  const pooled = (h1 + h2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  return { z, pValue: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

export const MIN_GROUP_SAMPLE = 30;

/**
 * Evaluates the common "it's due" belief: after `k` or more consecutive
 * rounds below `below`, does the next round reach `target` more often than
 * rounds that did not follow such a streak?
 */
export function evaluateStreakRule(values, { k = 3, below = 2, target = 2 } = {}) {
  const v = (values || []).filter(isValidMultiplier);
  let run = 0;
  const signal = { n: 0, hits: 0 };
  const rest = { n: 0, hits: 0 };
  for (let i = 0; i < v.length; i++) {
    if (i > 0) {
      const g = run >= k ? signal : rest;
      g.n++;
      if (v[i] >= target) g.hits++;
    }
    run = v[i] < below ? run + 1 : 0;
  }
  signal.rate = signal.n ? signal.hits / signal.n : null;
  rest.rate = rest.n ? rest.hits / rest.n : null;
  const test = twoProportionTest(signal.hits, signal.n, rest.hits, rest.n);
  let verdict = 'insufficient_data';
  if (test && signal.n >= MIN_GROUP_SAMPLE && rest.n >= MIN_GROUP_SAMPLE) {
    verdict = test.pValue < 0.01 ? 'difference_detected' : 'no_significant_difference';
  }
  return { rule: { k, below, target }, signal, rest, z: test?.z ?? null, pValue: test?.pValue ?? null, verdict };
}

export function verdictText(e) {
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
  const head = `After ${e.rule.k}+ rounds below ${e.rule.below.toFixed(2)}x, next ≥ ${e.rule.target.toFixed(2)}x: ` +
    `${pct(e.signal.rate)} (n=${e.signal.n}) vs ${pct(e.rest.rate)} otherwise (n=${e.rest.n}).`;
  if (e.verdict === 'insufficient_data') return `${head} Not enough data to compare (need ${MIN_GROUP_SAMPLE}+ in each group).`;
  if (e.verdict === 'no_significant_difference') return `${head} No significant difference (p=${e.pValue.toFixed(2)}): past rounds did not change the odds.`;
  return `${head} Difference at p=${e.pValue.toFixed(3)}. Treat with caution: one test on a finite sample can still be chance, and it is not evidence of a future edge.`;
}

/** Compact, model-friendly summary used for AI explanations. */
export function buildSummary(rounds) {
  const values = rounds.map((r) => r.multiplier);
  const stats = describe(values);
  const evaluations = [
    evaluateStreakRule(values, { k: 3, below: 2, target: 2 }),
    evaluateStreakRule(values, { k: 5, below: 2, target: 2 }),
  ];
  return { stats, evaluations, recent: values.slice(-20) };
}
