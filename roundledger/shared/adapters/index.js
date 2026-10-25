import * as melbet from './melbet.js';
import * as onexbet from './onexbet.js';

export const ADAPTERS = { [melbet.PLATFORM_ID]: melbet, [onexbet.PLATFORM_ID]: onexbet };
export const DEFAULT_PLATFORM_CONFIGS = [melbet.DEFAULT_CONFIG, onexbet.DEFAULT_CONFIG];

export function createAdapters(configs) {
  return (configs || [])
    .filter((c) => c && ADAPTERS[c.id] && c.enabled)
    .map((c) => ADAPTERS[c.id].createAdapter(c));
}
