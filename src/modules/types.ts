import { Artifact } from '../core/types';

export enum ModuleCapability {
  SEARCH = 'search',
  ANALYZE = 'analyze',
  EXTRACT = 'extract',
  EXECUTE = 'execute',
  VISUALIZE = 'visualize',
  GENERATE = 'generate',
}

export interface ModuleMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: ModuleCapability[];
  dependencies: string[];
  configSchema: object;
}

export interface ModuleContext {
  sessionId: string;
  llm: ILLMService;
  config: Record<string, unknown>;
  signal: AbortSignal;
  workspacePath: string;
  projectRoot: string;
  progress?: (pct: number, message?: string) => void;
}

export interface ILLMService {
  complete(
    messages: { role: string; content: string }[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: 'text' | 'json';
    },
  ): Promise<{
    content: string;
    usage: { promptTokens: number; completionTokens: number };
  }>;
}

export interface StepInput {
  data: Record<string, unknown>;
  artifacts: Artifact[];
}

export interface StepOutput {
  data: Record<string, unknown>;
  artifacts: Artifact[];
  summary: string;
  metrics?: Record<string, number>;
}

export interface StepDefinition {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  outputs: string[];
}

export interface IResearchModule {
  readonly metadata: ModuleMetadata;
  getAvailableSteps(): StepDefinition[];
  executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput>;
}
