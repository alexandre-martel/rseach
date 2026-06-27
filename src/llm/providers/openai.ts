import type { ILLMProvider, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo, ProviderConfig } from '../types';
import { LLMError } from '../../core/errors';

export class OpenAIProvider implements ILLMProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';
  private config: ProviderConfig = { defaultModel: 'o3-mini' };

  private static MODELS: ModelInfo[] = [
    { id: 'o3-mini', name: 'o3-mini', contextWindow: 200000, inputPricePerMToken: 1.1, outputPricePerMToken: 4.4 },
    { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576, inputPricePerMToken: 2.0, outputPricePerMToken: 8.0 },
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, inputPricePerMToken: 2.5, outputPricePerMToken: 10 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, inputPricePerMToken: 0.15, outputPricePerMToken: 0.6 },
  ];

  configure(config: ProviderConfig): void {
    this.config = { ...this.config, ...config };
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    if (!this.config.apiKey) {
      return { valid: false, error: 'OpenAI API key is required' };
    }
    try {
      const available = await this.isAvailable();
      return available ? { valid: true } : { valid: false, error: 'Cannot reach OpenAI API' };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.apiKey) { return false; }
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new LLMError('OpenAI API key not configured', this.id);
    }

    const model = request.model ?? this.config.defaultModel;
    const isReasoningModel = model.startsWith('o1') || model.startsWith('o3');
    const messages = request.messages.map(m => ({
      role: isReasoningModel && m.role === 'system' ? 'developer' : m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = { model, messages };

    if (isReasoningModel) {
      body.max_completion_tokens = request.maxTokens ?? 16384;
    } else {
      body.max_tokens = request.maxTokens ?? 4096;
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
    }
    if (request.stopSequences && !isReasoningModel) {
      body.stop = request.stopSequences;
    }
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new LLMError(`OpenAI API error ${res.status}: ${errText}`, this.id, res.status);
    }

    const data = await res.json() as {
      choices: { message: { content: string }; finish_reason: string }[];
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content ?? '',
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      },
      finishReason: data.choices[0]?.finish_reason === 'stop' ? 'stop' : 'length',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    if (!this.config.apiKey) {
      throw new LLMError('OpenAI API key not configured', this.id);
    }

    const model = request.model ?? this.config.defaultModel;
    const isReasoningModel = model.startsWith('o1') || model.startsWith('o3');
    const messages = request.messages.map(m => ({
      role: isReasoningModel && m.role === 'system' ? 'developer' : m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = { model, messages, stream: true };

    if (isReasoningModel) {
      body.max_completion_tokens = request.maxTokens ?? 16384;
    } else {
      body.max_tokens = request.maxTokens ?? 4096;
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new LLMError(`OpenAI API error ${res.status}`, this.id, res.status);
    }

    const reader = res.body?.getReader();
    if (!reader) { return; }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              yield { content: delta, done: false };
            }
            if (parsed.choices?.[0]?.finish_reason) {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // skip malformed events
          }
        }
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return OpenAIProvider.MODELS;
  }

  getTokenLimit(model: string): number {
    const info = OpenAIProvider.MODELS.find(m => m.id === model);
    return info?.contextWindow ?? 128000;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.config.organization) {
      h['OpenAI-Organization'] = this.config.organization;
    }
    return h;
  }
}
