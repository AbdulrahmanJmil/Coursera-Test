// Minimal reader for the SignalR JSON hub protocol (records separated by 0x1E,
// invocations have `type: 1`, a `target` and an `arguments` array). This is the
// publicly documented ASP.NET Core SignalR wire format; only text frames are
// supported. MessagePack (binary) hubs are reported as unsupported.

export const RECORD_SEPARATOR = '\u001e';
export const MAX_FRAME_CHARS = 256 * 1024;

export function parseSignalRFrame(raw) {
  const result = { invocations: [], errors: 0, unsupported: false };
  if (typeof raw !== 'string') {
    result.unsupported = true;
    return result;
  }
  if (raw.length > MAX_FRAME_CHARS) {
    result.errors++;
    return result;
  }
  for (const part of raw.split(RECORD_SEPARATOR)) {
    if (!part.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(part);
    } catch {
      result.errors++;
      continue;
    }
    if (msg && msg.type === 1 && typeof msg.target === 'string') {
      result.invocations.push({ target: msg.target, args: Array.isArray(msg.arguments) ? msg.arguments : [] });
    }
  }
  return result;
}

const toNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const toKey = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v : null);

/**
 * Maps SignalR invocations to tracker events using an event map such as:
 *   { roundOpen: { target, roundKeyField }, betting: { target }, running: { target },
 *     crashed: { target, multiplierField, roundKeyField? },
 *     snapshot: { target, roundKeyField?, historyField?, historyMultiplierField?, historyRoundKeyField? } }
 * Any entry may be omitted. Unmapped targets are ignored.
 */
export function mapInvocations(invocations, events = {}) {
  const out = [];
  for (const { target, args } of invocations) {
    const d = args[0] && typeof args[0] === 'object' ? args[0] : {};
    if (events.roundOpen?.target === target) {
      out.push({ type: 'round_open', roundKey: toKey(d[events.roundOpen.roundKeyField]) });
    } else if (events.betting?.target === target) {
      out.push({ type: 'betting' });
    } else if (events.running?.target === target) {
      out.push({ type: 'running' });
    } else if (events.crashed?.target === target) {
      const e = { type: 'crashed', multiplier: toNumber(d[events.crashed.multiplierField]) };
      if (events.crashed.roundKeyField) e.roundKey = toKey(d[events.crashed.roundKeyField]);
      out.push(e);
    } else if (events.snapshot?.target === target) {
      const s = events.snapshot;
      const e = { type: 'snapshot', roundKey: s.roundKeyField ? toKey(d[s.roundKeyField]) : null, history: [] };
      // History rows are only usable when they carry their own round id.
      if (s.historyField && s.historyRoundKeyField && Array.isArray(d[s.historyField])) {
        for (const h of d[s.historyField].slice(0, 200)) {
          if (!h || typeof h !== 'object') continue;
          e.history.push({ roundKey: toKey(h[s.historyRoundKeyField]), multiplier: toNumber(h[s.historyMultiplierField]) });
        }
      }
      out.push(e);
    }
  }
  return out;
}

export function compilePatterns(patterns) {
  return (patterns || []).map((p) => {
    const esc = String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + esc + '$');
  });
}
