import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe as stats, normalizeRounds, evaluateStreakRule, twoProportionTest, verdictText, buildSummary } from '../analysis.js';

test('describe handles empty input', () => {
  assert.deepEqual(stats([]), { n: 0 });
  assert.deepEqual(stats([0.5, NaN, -1]), { n: 0 });
});

test('describe computes quantiles, shares and runs', () => {
  const s = stats([1, 1.5, 2, 3, 10, 1.1, 1.2]);
  assert.equal(s.n, 7);
  assert.equal(s.min, 1);
  assert.equal(s.max, 10);
  assert.equal(s.median, 1.5);
  assert.equal(s.shareAtLeast[2], 3 / 7);
  assert.equal(s.shareAtLeast[10], 1 / 7);
  assert.equal(s.longestRunBelow2, 2);
  assert.equal(s.currentRunBelow2, 2);
  assert.equal(s.histogram.reduce((a, b) => a + b.count, 0), 7);
});

test('normalizeRounds de-duplicates, validates and orders numeric keys', () => {
  const r = normalizeRounds([
    { roundKey: '10', multiplier: 2, observedAt: 3000 },
    { roundKey: '9', multiplier: 1.5, observedAt: 5000 },
    { roundKey: '10', multiplier: 7, observedAt: 4000 },
    { roundKey: '', multiplier: 2, observedAt: 1 },
    { roundKey: '11', multiplier: 0.9, observedAt: 1 },
  ]);
  assert.deepEqual(r.rounds.map((x) => [x.roundKey, x.multiplier]), [['9', 1.5], ['10', 2]]);
  assert.equal(r.duplicates, 1);
  assert.equal(r.rejected, 2);
});

test('two-proportion test sanity', () => {
  assert.ok(twoProportionTest(50, 100, 50, 100).pValue > 0.99);
  assert.ok(twoProportionTest(90, 100, 10, 100).pValue < 1e-6);
  assert.equal(twoProportionTest(1, 0, 1, 1), null);
});

test('streak rule on independent data finds no significant difference', () => {
  // Deterministic pseudo-random crash sequence (inverse transform of 0.97/U).
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const values = Array.from({ length: 5000 }, () => Math.max(1, Math.floor((0.97 / (1 - rnd())) * 100) / 100));
  const e = evaluateStreakRule(values, { k: 3, below: 2, target: 2 });
  assert.ok(e.signal.n >= 30);
  assert.equal(e.verdict, 'no_significant_difference');
  assert.match(verdictText(e), /No significant difference/);
});

test('streak rule reports insufficient data on small samples', () => {
  const e = evaluateStreakRule([1.1, 1.2, 1.3, 5, 1.1]);
  assert.equal(e.verdict, 'insufficient_data');
  assert.match(verdictText(e), /Not enough data/);
});

test('buildSummary keeps only recent values and both evaluations', () => {
  const rounds = Array.from({ length: 40 }, (_, i) => ({ roundKey: String(i), multiplier: 1 + i / 10, observedAt: i }));
  const s = buildSummary(rounds);
  assert.equal(s.recent.length, 20);
  assert.equal(s.evaluations.length, 2);
  assert.equal(s.stats.n, 40);
});
