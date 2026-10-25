// MelBet crash-game adapter.
//
// Status: UNVERIFIED. The default event map reflects third-party observations
// of the MelBet crash game (game 371) published in a userscript — SignalR JSON
// over a socket whose URL contains "sockets/crash", with OnStage(l = round id),
// OnBetting, OnStart and OnCrash(f = multiplier). It has not been confirmed
// against live traffic by this project. Administrators can correct the map
// from the dashboard without shipping a new extension build.

import { parseSignalRFrame, mapInvocations, compilePatterns } from './signalr.js';

export const PLATFORM_ID = 'melbet';

export const DEFAULT_CONFIG = {
  id: PLATFORM_ID,
  name: 'MelBet',
  enabled: true,
  verified: false,
  protocol: 'signalr-json',
  pageUrlPatterns: ['https://melbet-srilanka.com/games-frame/games/371*'],
  socketUrlContains: 'sockets/crash',
  events: {
    roundOpen: { target: 'OnStage', roundKeyField: 'l' },
    betting: { target: 'OnBetting' },
    running: { target: 'OnStart' },
    crashed: { target: 'OnCrash', multiplierField: 'f' },
    snapshot: { target: 'OnRegistration', roundKeyField: 'l' },
  },
};

export function createAdapter(config = DEFAULT_CONFIG) {
  const pages = compilePatterns(config.pageUrlPatterns);
  return {
    id: PLATFORM_ID,
    config,
    matchesPage: (url) => typeof url === 'string' && pages.some((re) => re.test(url)),
    matchesSocket: (url) => typeof url === 'string' && !!config.socketUrlContains && url.includes(config.socketUrlContains),
    parseFrame(raw) {
      if (config.protocol !== 'signalr-json') return { events: [], errors: 0, unsupported: true };
      const parsed = parseSignalRFrame(raw);
      return { events: mapInvocations(parsed.invocations, config.events), errors: parsed.errors, unsupported: parsed.unsupported };
    },
  };
}
