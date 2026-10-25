// Turns normalized platform events into round records.
//
// Adapters emit events of these shapes:
//   { type: 'round_open', roundKey }
//   { type: 'betting' } | { type: 'running' }
//   { type: 'crashed', multiplier, roundKey? }
//   { type: 'snapshot', roundKey?, history?: [{ roundKey, multiplier }] }
//
// The tracker never invents a round identifier. A crash that cannot be tied to
// a known round is reported as a warning and not recorded, so the history only
// contains rounds whose identity was actually observed.

import { isValidMultiplier, isValidRoundKey } from './analysis.js';

export const PHASES = ['unknown', 'open', 'betting', 'running', 'ended'];

export class RoundTracker {
  constructor({ knownKeys = [], maxKnown = 5000, state = null } = {}) {
    this.maxKnown = maxKnown;
    this.known = new Set(knownKeys);
    this.phase = state?.phase ?? 'unknown';
    this.currentRoundKey = state?.currentRoundKey ?? null;
    this.lastResult = state?.lastResult ?? null;
  }

  snapshotState() {
    return { phase: this.phase, currentRoundKey: this.currentRoundKey, lastResult: this.lastResult };
  }

  remember(key) {
    this.known.add(key);
    if (this.known.size > this.maxKnown) this.known.delete(this.known.values().next().value);
  }

  record(roundKey, multiplier, now, source, out) {
    if (!isValidRoundKey(roundKey) || !isValidMultiplier(multiplier)) {
      out.warnings.push(`Rejected malformed round (${String(roundKey).slice(0, 20)}, ${multiplier})`);
      return;
    }
    if (this.known.has(roundKey)) {
      out.duplicates++;
      return;
    }
    this.remember(roundKey);
    out.recorded.push({ roundKey, multiplier: Math.round(multiplier * 100) / 100, observedAt: now, source });
  }

  /** Applies one event. Returns { recorded, duplicates, warnings, phaseChanged }. */
  apply(event, now = Date.now()) {
    const out = { recorded: [], duplicates: 0, warnings: [], phaseChanged: false };
    const setPhase = (p) => {
      if (this.phase !== p) out.phaseChanged = true;
      this.phase = p;
    };
    switch (event?.type) {
      case 'round_open':
        if (isValidRoundKey(event.roundKey)) {
          if (this.known.has(event.roundKey)) out.warnings.push(`Round ${event.roundKey} reopened after it was recorded (stale event ignored)`);
          else this.currentRoundKey = event.roundKey;
        }
        setPhase('open');
        break;
      case 'betting':
        setPhase('betting');
        break;
      case 'running':
        setPhase('running');
        break;
      case 'crashed': {
        const key = isValidRoundKey(event.roundKey) ? event.roundKey : this.currentRoundKey;
        if (!key) {
          out.warnings.push('Crash received without a known round id — not recorded');
        } else {
          this.record(key, event.multiplier, now, 'live', out);
          if (isValidMultiplier(event.multiplier)) this.lastResult = { roundKey: key, multiplier: event.multiplier, at: now };
        }
        if (key === this.currentRoundKey) this.currentRoundKey = null;
        setPhase('ended');
        break;
      }
      case 'snapshot':
        if (isValidRoundKey(event.roundKey) && !this.known.has(event.roundKey)) this.currentRoundKey = event.roundKey;
        for (const h of event.history || []) this.record(h.roundKey, h.multiplier, now, 'snapshot', out);
        break;
      default:
        out.warnings.push('Unknown event ignored');
    }
    return out;
  }
}
