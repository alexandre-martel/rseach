import type { TokenUsage } from '../core/types';
import type { EventBus } from '../core/events';

export class BudgetManager {
  private usage: TokenUsage = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    byProvider: {},
    byStep: {},
  };

  constructor(
    private eventBus: EventBus,
    private limits: { maxTokens: number; maxCostUsd: number },
  ) {}

  recordUsage(provider: string, step: string, promptTokens: number, completionTokens: number, costUsd: number): void {
    this.usage.totalPromptTokens += promptTokens;
    this.usage.totalCompletionTokens += completionTokens;
    this.usage.totalCost += costUsd;

    if (!this.usage.byProvider[provider]) {
      this.usage.byProvider[provider] = { prompt: 0, completion: 0, cost: 0 };
    }
    this.usage.byProvider[provider].prompt += promptTokens;
    this.usage.byProvider[provider].completion += completionTokens;
    this.usage.byProvider[provider].cost += costUsd;

    if (!this.usage.byStep[step]) {
      this.usage.byStep[step] = { prompt: 0, completion: 0, cost: 0 };
    }
    this.usage.byStep[step].prompt += promptTokens;
    this.usage.byStep[step].completion += completionTokens;
    this.usage.byStep[step].cost += costUsd;

    this.checkBudget();
  }

  private checkBudget(): void {
    const totalTokens = this.usage.totalPromptTokens + this.usage.totalCompletionTokens;

    if (this.limits.maxTokens > 0) {
      const ratio = totalTokens / this.limits.maxTokens;
      if (ratio >= 1) {
        this.eventBus.emit('llm:budgetExceeded', { usage: totalTokens, limit: this.limits.maxTokens });
      } else if (ratio >= 0.8) {
        this.eventBus.emit('llm:budgetWarning', { usage: totalTokens, limit: this.limits.maxTokens });
      }
    }

    if (this.limits.maxCostUsd > 0 && this.usage.totalCost >= this.limits.maxCostUsd) {
      this.eventBus.emit('llm:budgetExceeded', { usage: this.usage.totalCost, limit: this.limits.maxCostUsd });
    }
  }

  isWithinBudget(): boolean {
    const totalTokens = this.usage.totalPromptTokens + this.usage.totalCompletionTokens;
    if (this.limits.maxTokens > 0 && totalTokens >= this.limits.maxTokens) {
      return false;
    }
    if (this.limits.maxCostUsd > 0 && this.usage.totalCost >= this.limits.maxCostUsd) {
      return false;
    }
    return true;
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  reset(): void {
    this.usage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCost: 0,
      byProvider: {},
      byStep: {},
    };
  }

  setLimits(limits: { maxTokens: number; maxCostUsd: number }): void {
    this.limits = limits;
  }
}
