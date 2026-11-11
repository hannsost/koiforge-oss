import type { AssetLineageState } from './types.js';

export function createDefaultAssetLineageState(): AssetLineageState {
  return {
    assets: {},
    edges: [],
    runs: [],
    events: [],
  };
}

