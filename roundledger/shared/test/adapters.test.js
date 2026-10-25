import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSignalRFrame, mapInvocations } from '../adapters/signalr.js';
import * as melbet from '../adapters/melbet.js';
import * as onexbet from '../adapters/onexbet.js';
import { createAdapters, DEFAULT_PLATFORM_CONFIGS } from '../adapters/index.js';
import { RoundTracker } from '../round-tracker.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/melbet-synthetic-frames.json', import.meta.url)));

test('SignalR parser handles multiple records, pings and garbage', () => {
  const r = parseSignalRFrame('{"type":6}\u001e{"type":1,"target":"A","arguments":[{"x":1}]}\u001ejunk\u001e');
  assert.equal(r.invocations.length, 1);
  assert.equal(r.errors, 1);
  assert.equal(parseSignalRFrame(new ArrayBuffer(4)).unsupported, true);
  assert.equal(parseSignalRFrame('x'.repeat(300 * 1024)).errors, 1);
});

test('mapInvocations ignores unmapped targets and coerces numeric strings', () => {
  const ev = mapInvocations([{ target: 'OnCrash', args: [{ f: '1.5' }] }, { target: 'Other', args: [] }], { crashed: { target: 'OnCrash', multiplierField: 'f' } });
  assert.deepEqual(ev, [{ type: 'crashed', multiplier: 1.5 }]);
});

test('MelBet adapter: page and socket matching', () => {
  const a = melbet.createAdapter();
  assert.ok(a.matchesPage('https://melbet-srilanka.com/games-frame/games/371?x=1'));
  assert.ok(!a.matchesPage('https://evil.example/melbet-srilanka.com/games-frame/games/371'));
  assert.ok(a.matchesSocket(fixture.socketUrl));
  assert.ok(!a.matchesSocket('wss://example.invalid/chat'));
  assert.equal(a.config.verified, false);
});

test('MelBet adapter + tracker on the synthetic fixture: records each round once', () => {
  const a = melbet.createAdapter();
  const t = new RoundTracker();
  const recorded = [];
  const warnings = [];
  let dups = 0;
  for (const f of fixture.frames) {
    for (const ev of a.parseFrame(f).events) {
      const out = t.apply(ev, 1000);
      recorded.push(...out.recorded);
      warnings.push(...out.warnings);
      dups += out.duplicates;
    }
  }
  // OnRegistration history has no round ids → not imported. Round 5002 crashes at 2.47 (duplicate crash
  // frame ignored), round 5003 crashes at 1.03.
  assert.deepEqual(recorded.map((r) => [r.roundKey, r.multiplier]), [['5002', 2.47], ['5003', 1.03]]);
  assert.ok(warnings.some((w) => /without a known round id/.test(w)), 'second crash with no open round is not recorded');
  assert.equal(dups, 0);
});

test('tracker ignores stale reopen and duplicate keyed crashes', () => {
  const t = new RoundTracker({ knownKeys: ['7'] });
  assert.equal(t.apply({ type: 'crashed', roundKey: '7', multiplier: 3 }).duplicates, 1);
  const out = t.apply({ type: 'round_open', roundKey: '7' });
  assert.match(out.warnings[0], /stale/);
  assert.equal(t.currentRoundKey, null);
  assert.equal(t.apply({ type: 'crashed', roundKey: 'bad key!', multiplier: 2 }).recorded.length, 0);
  assert.equal(t.apply({ type: 'round_open', roundKey: '8' }).warnings.length, 0);
  assert.equal(t.apply({ type: 'crashed', multiplier: 0 }).recorded.length, 0, 'invalid multiplier rejected');
  assert.equal(t.apply({ type: 'whatever' }).warnings[0], 'Unknown event ignored');
});

test('tracker imports snapshot history only when rows carry ids', () => {
  const t = new RoundTracker();
  const out = t.apply({ type: 'snapshot', history: [{ roundKey: '1', multiplier: 2 }, { roundKey: null, multiplier: 3 }] });
  assert.deepEqual(out.recorded.map((r) => r.roundKey), ['1']);
});

test('1xBet adapter is unconfigured and refuses to parse', () => {
  const a = onexbet.createAdapter();
  assert.equal(a.configured, false);
  assert.equal(a.matchesSocket('wss://anything/sockets/crash'), false);
  assert.equal(a.parseFrame(fixture.frames[2]).unsupported, true);
  assert.equal(onexbet.DEFAULT_CONFIG.enabled, false);
});

test('only enabled adapters are created', () => {
  assert.deepEqual(createAdapters(DEFAULT_PLATFORM_CONFIGS).map((a) => a.id), ['melbet']);
  assert.deepEqual(createAdapters([{ id: 'unknown', enabled: true }]), []);
});
