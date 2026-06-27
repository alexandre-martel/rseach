import type { ILLMProvider, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo, ProviderConfig } from '../types';
import { LLMError } from '../../core/errors';

export class OllamaProvider implements ILLMProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama (Local)';
  private config: ProviderConfig = {
    defaultModel: 'llama3.1',
    baseUrl: 'http://localhost:11434',
  };

  configure(config: ProviderConfig): void {
    this.config = { ...this.config, ...config };
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    try {
      const available = await this.isAvailable();
      return available ? { valid: true } : { valid: false, error: `Cannot reach Ollama at ${this.config.baseUrl}` };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.config.defaultModel;
    const messages = request.messages.map(m => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    if (request.temperature !== undefined) {
      body.options = { ...(body.options as Record<string, unknown> ?? {}), temperature: request.temperature };
    }
    if (request.maxTokens !== undefined) {
      body.options = { ...(body.options as Record<string, unknown> ?? {}), num_predict: request.maxTokens };
    }
    if (request.responseFormat === 'json') {
      body.format = 'json';
    }

    const res = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new LLMError(`Ollama error ${res.status}: ${errText}`, this.id, res.status);
    }

    const data = await res.json() as {
      message: { content: string };
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
      done: boolean;
    };

    return {
      content: data.message.content,
      model: data.model,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
      },
      finishReason: data.done ? 'stop' : 'length',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const model = request.model ?? this.config.defaultModel;
    const messages = request.messages.map(m => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    if (request.temperature !== undefined) {
      body.options = { temperature: request.temperature };
    }
    if (request.maxTokens !== undefined) {
      body.options = { ...(body.options as Record<string, unknown> ?? {}), num_predict: request.maxTokens };
    }

    const res = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new LLMError(`Ollama error ${res.status}`, this.id, res.status);
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
        if (!line.trim()) { continue; }
        try {
          const parsed = JSON.parse(line);
          if (parsed.done) {
            yield { content: '', done: true };
            return;
          }
          if (parsed.message?.content) {
            yield { content: parsed.message.content, done: false };
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`);
      if (!res.ok) { return []; }
      const data = await res.json() as { models: { name: string; size: number; details?: { parameter_size?: string } }[] };
      return data.models.map(m => ({
        id: m.name,
        name: m.name,
        contextWindow: 8192,
      }));
    } catch {
      return [];
    }
  }

  getTokenLimit(_model: string): number {
    return 8192;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
