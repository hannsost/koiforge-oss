import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface GenerationAudit {
  attempts: number;
  calls: number;
  denied: number;
}

export function emptyGenerationAudit(): GenerationAudit {
  return { attempts: 0, calls: 0, denied: 0 };
}

// Every generation entrance calls this before the provider, even when disabled.
// The durable journal makes attempts observable if the operation subsequently fails.
export async function auditGeneration(
  path: string, operationId: string, audit: GenerationAudit, providerAvailable = true,
  source?: { backend: string; model: string; reasoningEffort: string },
): Promise<void> {
  audit.attempts += 1;
  const denied = process.env.KOIFORGE_GENERATION_DISABLED === '1';
  if (denied) audit.denied += 1;
  else if (providerAvailable) audit.calls += 1;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ operationId, at: new Date().toISOString(),
    ...(source ? { backend: source.backend, model: source.model, reasoningEffort: source.reasoningEffort } : {}),
    event: denied ? 'generation_denied' : providerAvailable ? 'provider_call' : 'provider_unavailable', ...audit }) + '\n');
  if (denied) throw new Error('Generation is disabled; a verified reusable capability is required.');
}
