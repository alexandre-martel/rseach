import type { Artifact } from '../core/types';

// ---------------------------------------------------------------------------
// Step I/O (matches the ModuleRegistry contract)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module abstractions (referenced, not owned by this package)
// ---------------------------------------------------------------------------

export interface ModuleContext {
  sessionId: string;
  stepId: string;
  abortSignal: AbortSignal;
  progress: (pct: number, message?: string) => void;
}

export interface IResearchModule {
  executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput>;
}

export interface ModuleRegistry {
  get(moduleId: string): IResearchModule | undefined;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Maximum number of retry attempts (0 = no retries). */
  maxAttempts: number;
  /** Base delay in milliseconds before the first retry. */
  baseDelayMs: number;
  /** Multiplier applied to the delay after each attempt (exponential backoff). */
  backoffMultiplier: number;
  /** Upper bound on the computed delay in milliseconds. */
  maxDelayMs: number;
  /** If provided, only these error codes trigger a retry. */
  retryableErrorCodes?: string[];
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
};

// ---------------------------------------------------------------------------
// Pipeline & step definitions (the static "blueprint")
// ---------------------------------------------------------------------------

export interface PipelineStepDefinition {
  /** Unique identifier for this step within the pipeline. */
  id: string;
  /** Human-readable label. */
  name: string;
  /** The module that executes this step (key in ModuleRegistry). */
  moduleId: string;
  /** IDs of steps that must complete before this step can run. */
  dependsOn: string[];
  /** Static configuration passed into the step. */
  config: Record<string, unknown>;
  /** Per-step retry policy override. Falls back to PipelineDefinition default. */
  retryPolicy?: RetryPolicy;
  /** When true the pipeline will continue even if this step fails. */
  optional?: boolean;
}

export interface PipelineDefinition {
  /** Unique identifier for this pipeline template. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Ordered list of step definitions (order is informational; DAG drives execution). */
  steps: PipelineStepDefinition[];
  /** Default retry policy applied to steps that don't specify their own. */
  defaultRetryPolicy: RetryPolicy;
}

// ---------------------------------------------------------------------------
// Step runtime status
// ---------------------------------------------------------------------------

export enum StepStatus {
  /** Not yet evaluated for execution. */
  Pending = 'pending',
  /** Dependencies satisfied; waiting for an execution slot. */
  Queued = 'queued',
  /** Currently executing. */
  Running = 'running',
  /** Finished successfully. */
  Completed = 'completed',
  /** Finished with an error (may be retried). */
  Failed = 'failed',
  /** Skipped by user or because a non-optional upstream failed. */
  Skipped = 'skipped',
  /** Paused by the user while running. */
  Paused = 'paused',
}

// ---------------------------------------------------------------------------
// Pipeline-level status
// ---------------------------------------------------------------------------

export type PipelineStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

// ---------------------------------------------------------------------------
// Runtime state snapshots (serialisable for persistence / recovery)
// ---------------------------------------------------------------------------

export interface StepState {
  stepId: string;
  status: StepStatus;
  /** Number of attempts so far (starts at 0). */
  attempts: number;
  /** Timestamp when the step last started running. */
  startedAt?: number;
  /** Timestamp when the step reached a terminal state. */
  finishedAt?: number;
  /** Output produced by a successful execution. */
  output?: StepOutput;
  /** Error message from the most recent failed attempt. */
  error?: string;
}

export interface PipelineState {
  pipelineId: string;
  sessionId: string;
  status: PipelineStatus;
  /** Per-step state keyed by stepId. */
  steps: Record<string, StepState>;
  /** Timestamp when the pipeline was started. */
  startedAt?: number;
  /** Timestamp when the pipeline reached a terminal or paused state. */
  updatedAt?: number;
}
