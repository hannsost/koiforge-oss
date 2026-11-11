import type { AipMessage, AipProviderConfig, AipResponse } from './types.js';

function supportsReasoningEffort(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.startsWith('gpt-5')
    || normalizedModel.startsWith('o1')
    || normalizedModel.startsWith('o3')
    || normalizedModel.startsWith('o4');
}

function usesMaxCompletionTokens(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.startsWith('gpt-5')
    || normalizedModel.startsWith('o1')
    || normalizedModel.startsWith('o3')
    || normalizedModel.startsWith('o4');
}

/**
 * Calls an OpenAI-compatible chat completions endpoint.
 * Works with: OpenAI, Ollama (baseUrl=http://localhost:11434/v1),
 *             Anthropic (via openai-compat layer), LM Studio, vLLM, etc.
 */
export async function callProvider(
  config: AipProviderConfig,
  messages: AipMessage[],
  maxTokens = 2048,
): Promise<AipResponse> {
  const url = config.baseUrl.replace(/\/$/, '') + '/chat/completions';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };

  if (usesMaxCompletionTokens(config.model)) {
    payload.max_completion_tokens = maxTokens;
  } else {
    payload.max_tokens = maxTokens;
  }

  if (
    config.reasoningEffort
    && (config.provider === 'openai' || config.provider === 'custom')
    && supportsReasoningEffort(config.model)
  ) {
    payload.reasoning_effort = config.reasoningEffort;
  }

  const body = JSON.stringify(payload);

  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Provider error ${res.status}`);
  }

  if (!res.body) throw new Error('Empty provider response');
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Provider response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    choices: Array<{ message: { role: string; content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
    model?: string;
  };

  const choice = data.choices?.[0];
  if (!choice || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('Provider returned no answer.');

  return {
    message: {
      role: 'assistant',
      content: choice.message.content,
    },
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined,
    model: data.model ?? config.model,
    provider: config.provider,
  };
}
