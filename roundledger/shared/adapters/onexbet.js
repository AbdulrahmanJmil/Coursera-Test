// 1xBet crash-game adapter.
//
// Status: NOT CONFIGURED. No verified observation of 1xBet's crash-game
// traffic is available to this project, so no event map is shipped and the
// adapter is disabled. An administrator who has verified the protocol in an
// authorized environment can supply page patterns, socket filter and event
// map from the dashboard. Until then the extension reports the platform as
// unsupported instead of guessing.

import { parseSignalRFrame, mapInvocations, compilePatterns } from './signalr.js';

export const PLATFORM_ID = 'onexbet';

export const DEFAULT_CONFIG = {
  id: PLATFORM_ID,
  name: '1xBet',
  enabled: false,
  verified: false,
  protocol: 'signalr-json',
  pageUrlPatterns: [],
  socketUrlContains: '',
  events: {},
};

export function createAdapter(config = DEFAULT_CONFIG) {
  const pages = compilePatterns(config.pageUrlPatterns);
  const configured = !!config.socketUrlContains && !!config.events?.crashed?.target;
  return {
    id: PLATFORM_ID,
    config,
    configured,
    matchesPage: (url) => typeof url === 'string' && pages.some((re) => re.test(url)),
    matchesSocket: (url) => configured && typeof url === 'string' && url.includes(config.socketUrlContains),
    parseFrame(raw) {
      if (!configured || config.protocol !== 'signalr-json') return { events: [], errors: 0, unsupported: true };
      const parsed = parseSignalRFrame(raw);
      return { events: mapInvocations(parsed.invocations, config.events), errors: parsed.errors, unsupported: parsed.unsupported };
    },
  };
}
