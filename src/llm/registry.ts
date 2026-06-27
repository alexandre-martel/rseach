import type { ILLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from './types';
import { LLMError } from '../core/errors';

export class LLMRegistry {
  private providers = new Map<string, ILLMProvider>();
  private activeProviderId: string | null = null;

  register(provider: ILLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): void {
    this.providers.delete(providerId);
    if (this.activeProviderId === providerId) {
      this.activeProviderId = null;
    }
  }

  setActive(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new LLMError(`Unknown provider: ${providerId}`, providerId);
    }
    this.activeProviderId = providerId;
  }

  getActive(): ILLMProvider {
    if (!this.activeProviderId) {
      throw new LLMError('No active LLM provider configured', 'none');
    }
    const provider = this.providers.get(this.activeProviderId);
    if (!provider) {
      throw new LLMError(`Provider not found: ${this.activeProviderId}`, this.activeProviderId);
    }
    return provider;
  }

  get(providerId: string): ILLMProvider | undefined {
    return this.providers.get(providerId);
  }

  getAll(): ILLMProvider[] {
    return Array.from(this.providers.values());
  }

  getActiveId(): string | null {
    return this.activeProviderId;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.getActive().complete(request);
  }

  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    return this.getActive().stream(request);
  }
}
