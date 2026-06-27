import type { ILLMProvider, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo, ProviderConfig } from '../types';
import { LLMError } from '../../core/errors';

export class ClaudeProvider implements ILLMProvider {
  readonly id = 'claude';
  readonly displayName = 'Anthropic Claude';
  private config: ProviderConfig = { defaultModel: 'claude-sonnet-4-20250514' };

  private static MODELS: ModelInfo[] = [
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', contextWindow: 200000, inputPricePerMToken: 15, outputPricePerMToken: 75 },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000, inputPricePerMToken: 3, outputPricePerMToken: 15 },
    { id: 'claude-haiku-4-20250414', name: 'Claude Haiku 4', contextWindow: 200000, inputPricePerMToken: 0.8, outputPricePerMToken: 4 },
  ];

  configure(config: ProviderConfig): void {
    this.config = { ...this.config, ...config };
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    if (!this.config.apiKey) {
      return { valid: false, error: 'Claude API key is required' };
    }
    try {
      const available = await this.isAvailable();
      return available ? { valid: true } : { valid: false, error: 'Cannot reach Claude API' };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.apiKey) { return false; }
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return res.status !== 401;
    } catch {
      return false;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new LLMError('Claude API key not configured', this.id);
    }

    const model = request.model ?? this.config.defaultModel;
    const systemMessage = request.messages.find(m => m.role === 'system');
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.stopSequences) {
      body.stop_sequences = request.stopSequences;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new LLMError(`Claude API error ${res.status}: ${errText}`, this.id, res.status);
    }

    const data = await res.json() as {
      content: { type: string; text: string }[];
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    return {
      content: data.content.map(c => c.text).join(''),
      model: data.model,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
      },
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason === 'max_tokens' ? 'length' : 'stop',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    if (!this.config.apiKey) {
      throw new LLMError('Claude API key not configured', this.id);
    }

    const model = request.model ?? this.config.defaultModel;
    const systemMessage = request.messages.find(m => m.role === 'system');
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new LLMError(`Claude API error ${res.status}`, this.id, res.status);
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
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield { content: parsed.delta.text, done: false };
            }
            if (parsed.type === 'message_stop') {
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
    return ClaudeProvider.MODELS;
  }

  getTokenLimit(model: string): number {
    const info = ClaudeProvider.MODELS.find(m => m.id === model);
    return info?.contextWindow ?? 200000;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }
}
