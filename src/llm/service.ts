import type { ILLMService } from '../modules/types';
import type { LLMRegistry } from './registry';

/**
 * Adapts the LLMRegistry to the ILLMService interface expected by modules.
 */
export class LLMServiceAdapter implements ILLMService {
  constructor(private readonly registry: LLMRegistry) {}

  async complete(
    messages: { role: string; content: string }[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: 'text' | 'json';
    },
  ): Promise<{
    content: string;
    usage: { promptTokens: number; completionTokens: number };
  }> {
    const response = await this.registry.complete({
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      responseFormat: options?.responseFormat,
    });

    return {
      content: response.content,
      usage: response.usage,
    };
  }
}
