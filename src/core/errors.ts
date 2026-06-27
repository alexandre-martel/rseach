export class ResearchLoopError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ResearchLoopError';
  }
}

export class LLMError extends ResearchLoopError {
  constructor(message: string, public readonly provider: string, public readonly statusCode?: number) {
    super(message, 'LLM_ERROR');
    this.name = 'LLMError';
  }
}

export class ApiError extends ResearchLoopError {
  constructor(message: string, public readonly source: string, public readonly statusCode?: number) {
    super(message, 'API_ERROR');
    this.name = 'ApiError';
  }
}

export class PipelineError extends ResearchLoopError {
  constructor(message: string, public readonly stepId?: string) {
    super(message, 'PIPELINE_ERROR');
    this.name = 'PipelineError';
  }
}

export class BudgetExceededError extends ResearchLoopError {
  constructor(public readonly usage: number, public readonly limit: number) {
    super(`Token budget exceeded: ${usage}/${limit}`, 'BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}

export class ConfigError extends ResearchLoopError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}
