export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: 'text' | 'json';
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  finishReason: 'stop' | 'length' | 'error';
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  inputPricePerMToken?: number;
  outputPricePerMToken?: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface ILLMProvider {
  readonly id: string;
  readonly displayName: string;

  configure(config: ProviderConfig): void;
  validateConfig(): Promise<{ valid: boolean; error?: string }>;
  isAvailable(): Promise<boolean>;

  complete(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;

  listModels(): Promise<ModelInfo[]>;
  getTokenLimit(model: string): number;
  countTokens(text: string): number;
}
