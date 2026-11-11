import { callProvider, withSystemMessage } from '@koiforge/aip-core';
import type { AppRegistries } from '../registries.js';
import { createCodexGenerator } from './codex-generator.js';

export interface GenerationStatus {
  backend: 'codex' | 'api';
  model: string;
  reasoningEffort: string;
  available: boolean;
  reason?: string;
}
export interface GenerationProvider {
  backend: 'codex' | 'api';
  model: string;
  reasoningEffort: string;
  status(): Promise<GenerationStatus>;
  generate(system: string, prompt: string, maxTokens?: number): Promise<string>;
}

// The OpenAI-compatible AIP endpoint is the default. Opt into the local Codex CLI
// explicitly with KOIFORGE_EXTENSION_BACKEND=codex; missing CLI/login never falls back to an API.
export async function generationProvider(registries: AppRegistries): Promise<GenerationProvider> {
  const backend = process.env.KOIFORGE_EXTENSION_BACKEND ?? 'api';
  if (backend === 'codex') return createCodexGenerator();
  if (backend !== 'api') throw new Error('Unknown KOIFORGE_EXTENSION_BACKEND. Expected codex or api.');
  const config = await registries.aip.getConfig();
  const metadata = { backend: 'api' as const, model: config?.model ?? '', reasoningEffort: config?.reasoningEffort ?? 'xhigh' };
  const available = !!(config?.model?.trim() && config.baseUrl?.trim() && config.provider !== 'anthropic'
    && (config.provider !== 'openai' || config.apiKey));
  return { ...metadata,
    async status() { return { ...metadata, available, ...(!available ? { reason: 'Kein API-Modell eingerichtet.' } : {}) }; },
    async generate(system, prompt, maxTokens = 4000) {
      if (process.env.KOIFORGE_GENERATION_DISABLED === '1') throw new Error('Generation is disabled; a verified reusable capability is required.');
      if (!config || !available) throw new Error('No AI provider configured for the missing capability.');
      const result = await callProvider({ ...config, reasoningEffort: metadata.reasoningEffort },
        withSystemMessage([{ role: 'user', content: prompt }], system), maxTokens);
      return result.message.content;
    },
  };
}
