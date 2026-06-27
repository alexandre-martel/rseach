import { PipelineError } from '../core/errors';
import {
  PipelineState,
  PipelineStatus,
  StepState,
  StepStatus,
} from './types';

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

/** Allowed pipeline-level transitions: current status -> set of reachable statuses. */
const PIPELINE_TRANSITIONS: Record<PipelineStatus, ReadonlySet<PipelineStatus>> = {
  idle: new Set<PipelineStatus>(['running']),
  running: new Set<PipelineStatus>(['paused', 'completed', 'failed', 'idle']),
  paused: new Set<PipelineStatus>(['running', 'idle']),
  completed: new Set<PipelineStatus>(),
  failed: new Set<PipelineStatus>(),
};

/** Allowed step-level transitions: current status -> set of reachable statuses. */
const STEP_TRANSITIONS: Record<StepStatus, ReadonlySet<StepStatus>> = {
  [StepStatus.Pending]: new Set<StepStatus>([StepStatus.Queued, StepStatus.Skipped]),
  [StepStatus.Queued]: new Set<StepStatus>([StepStatus.Running, StepStatus.Skipped]),
  [StepStatus.Running]: new Set<StepStatus>([
    StepStatus.Completed,
    StepStatus.Failed,
    StepStatus.Paused,
  ]),
  [StepStatus.Completed]: new Set<StepStatus>(),
  [StepStatus.Failed]: new Set<StepStatus>([StepStatus.Queued, StepStatus.Skipped]),
  [StepStatus.Skipped]: new Set<StepStatus>(),
  [StepStatus.Paused]: new Set<StepStatus>([StepStatus.Queued]),
};

// ---------------------------------------------------------------------------
// Pipeline state machine
// ---------------------------------------------------------------------------

export class PipelineStateMachine {
  private _state: PipelineState;

  constructor(state: PipelineState) {
    this._state = state;
  }

  /** Return a read-only snapshot of the current state. */
  get state(): Readonly<PipelineState> {
    return this._state;
  }

  // -- Pipeline-level transitions -------------------------------------------

  /** Transition the pipeline to a new status. Throws on invalid transition. */
  transitionPipeline(to: PipelineStatus): void {
    const from = this._state.status;
    if (!PIPELINE_TRANSITIONS[from].has(to)) {
      throw new PipelineError(
        `Invalid pipeline transition: ${from} -> ${to}`,
      );
    }
    this._state.status = to;
    this._state.updatedAt = Date.now();
  }

  /** Convenience: idle -> running */
  start(): void {
    this.transitionPipeline('running');
    this._state.startedAt = Date.now();
  }

  /** Convenience: running -> paused */
  pause(): void {
    this.transitionPipeline('paused');
  }

  /** Convenience: paused -> running */
  resume(): void {
    this.transitionPipeline('running');
  }

  /** Convenience: running -> completed */
  complete(): void {
    this.transitionPipeline('completed');
  }

  /** Convenience: running -> failed */
  fail(): void {
    this.transitionPipeline('failed');
  }

  /** Convenience: running | paused -> idle (cancel) */
  cancel(): void {
    this.transitionPipeline('idle');
  }

  // -- Step-level transitions ------------------------------------------------

  /** Transition a step to a new status. Throws on invalid transition. */
  transitionStep(stepId: string, to: StepStatus): void {
    const step = this.getStepOrThrow(stepId);
    const from = step.status;
    if (!STEP_TRANSITIONS[from].has(to)) {
      throw new PipelineError(
        `Invalid step transition for "${stepId}": ${from} -> ${to}`,
        stepId,
      );
    }
    step.status = to;

    if (to === StepStatus.Running) {
      step.startedAt = Date.now();
    }
    if (
      to === StepStatus.Completed ||
      to === StepStatus.Failed ||
      to === StepStatus.Skipped
    ) {
      step.finishedAt = Date.now();
    }
  }

  /** Get a mutable reference to a step's state. */
  getStep(stepId: string): StepState | undefined {
    return this._state.steps[stepId];
  }

  /** Get a step or throw if it doesn't exist. */
  getStepOrThrow(stepId: string): StepState {
    const step = this._state.steps[stepId];
    if (!step) {
      throw new PipelineError(`Step "${stepId}" not found in pipeline state`, stepId);
    }
    return step;
  }

  /** Return all steps that currently have the given status. */
  stepsByStatus(status: StepStatus): StepState[] {
    return Object.values(this._state.steps).filter((s) => s.status === status);
  }

  /** Check whether every step has reached a terminal state (completed/failed/skipped). */
  allStepsTerminal(): boolean {
    return Object.values(this._state.steps).every(
      (s) =>
        s.status === StepStatus.Completed ||
        s.status === StepStatus.Failed ||
        s.status === StepStatus.Skipped,
    );
  }

  /** Check whether any non-optional step has failed (caller decides optionality). */
  hasFailedRequired(optionalStepIds: ReadonlySet<string>): boolean {
    return Object.values(this._state.steps).some(
      (s) => s.status === StepStatus.Failed && !optionalStepIds.has(s.stepId),
    );
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Build an initial PipelineState from a set of step IDs. */
export function createInitialState(
  pipelineId: string,
  sessionId: string,
  stepIds: string[],
): PipelineState {
  const steps: Record<string, StepState> = {};
  for (const id of stepIds) {
    steps[id] = {
      stepId: id,
      status: StepStatus.Pending,
      attempts: 0,
    };
  }
  return {
    pipelineId,
    sessionId,
    status: 'idle',
    steps,
  };
}

/** Validate that a transition is legal without performing it. */
export function canTransitionPipeline(from: PipelineStatus, to: PipelineStatus): boolean {
  return PIPELINE_TRANSITIONS[from].has(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].has(to);
}
