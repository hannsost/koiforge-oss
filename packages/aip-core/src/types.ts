export type AipRole = 'system' | 'user' | 'assistant';

export interface AipMessage {
  role: AipRole;
  content: string;
}

export interface AipContext {
  /** Dataset rows to inject as context */
  datasetRows?: Array<Record<string, unknown>>;
  datasetName?: string;
  /** Object attributes to inject as context */
  objectAttributes?: Record<string, unknown>;
  objectType?: string;
  objectId?: string;
  /** Arbitrary extra context */
  extra?: string;
}

export interface AipRequest {
  messages: AipMessage[];
  context?: AipContext;
  maxTokens?: number;
}

export interface AipResponse {
  message: AipMessage;
  usage?: { promptTokens: number; completionTokens: number };
  model: string;
  provider: string;
}

export type AipReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AipProviderConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
  baseUrl: string;
  apiKey?: string;
  model: string;
  reasoningEffort?: AipReasoningEffort;
  systemPrompt?: string;
}

export type AipConfigState = AipProviderConfig;

export interface ChatSession {
  userId?: string;
  tenantId?: string;
  id: string;
  title: string;
  messages: AipMessage[];
  context?: AipContext;
  createdAt: string;
  updatedAt: string;
}

export interface AipRegistryState {
  config: AipProviderConfig | null;
  sessions: Record<string, ChatSession>;
}
