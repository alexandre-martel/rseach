import type { ResearchSession } from '../core/types';
import type { EventBus } from '../core/events';
import { PipelineError } from '../core/errors';
import {
  PipelineDefinition,
  StepStatus,
  ModuleRegistry,
  ModuleContext,
} from './types';
import type { PipelineState } from './types';
import { PipelineStateMachine, createInitialState } from './state';
import { DAGScheduler } from './scheduler';
import { RecoveryManager, createRecoveryManager } from './recovery';

// ---------------------------------------------------------------------------
// Persistence interface (implemented by StorageManager or similar)
// ---------------------------------------------------------------------------

export interface PipelineStore {
  loadState(sessionId: string): Promise<PipelineState | undefined>;
  saveState(state: PipelineState): Promise<void>;
}

// ---------------------------------------------------------------------------
// PipelineEngine
// ---------------------------------------------------------------------------

/**
 * The main executor that ties together the DAG scheduler, state machine,
 * recovery manager, module registry, and event bus to drive a research
 * pipeline to completion.
 */
export class PipelineEngine {
  private readonly definition: PipelineDefinition;
  private readonly modules: ModuleRegistry;
  private readonly store: PipelineStore;
  private readonly events: EventBus;

  private scheduler!: DAGScheduler;
  private machine!: PipelineStateMachine;
  private recovery!: RecoveryManager;

  /** Set of step IDs marked as optional in the definition. */
  private readonly optionalSteps: ReadonlySet<string>;

  /** Master AbortController — aborted on cancel(). */
  private abortController: AbortController | null = null;

  /** Per-step AbortControllers keyed by stepId. */
  private readonly stepAbortControllers = new Map<string, AbortController>();

  /** Pending retry timers so they can be cleared on cancel. */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Tracks whether the scheduling loop is active. */
  private scheduling = false;

  constructor(
    definition: PipelineDefinition,
    modules: ModuleRegistry,
    store: PipelineStore,
    events: EventBus,
  ) {
    this.definition = definition;
    this.modules = modules;
    this.store = store;
    this.events = events;

    this.optionalSteps = new Set(
      definition.steps.filter((s) => s.optional).map((s) => s.id),
    );
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Start (or restart) the pipeline for a given session.
   * If persisted state exists it is loaded for recovery; otherwise a fresh
   * state is created.
   */
  async start(session: ResearchSession): Promise<void> {
    // Build DAG (validates acyclicity)
    this.scheduler = new DAGScheduler(this.definition.steps);

    // Recovery manager with per-step retry policies
    this.recovery = createRecoveryManager(
      this.definition.steps,
      this.definition.defaultRetryPolicy,
    );

    // Try to restore persisted state, otherwise create fresh
    const persisted = await this.store.loadState(session.id);
    if (persisted && persisted.status !== 'completed' && persisted.status !== 'idle') {
      this.machine = new PipelineStateMachine(persisted);
      // If the persisted state was "running" (e.g. process crashed), we need
      // to reset any running steps back to queued so they get re-executed.
      for (const step of this.machine.stepsByStatus(StepStatus.Running)) {
        // Running -> Failed (crash), then Failed -> Queued (retry)
        this.machine.transitionStep(step.stepId, StepStatus.Failed);
        step.error = 'Recovered after unexpected shutdown';
        if (this.recovery.canRetry(step)) {
          this.recovery.scheduleRetry(this.machine, step.stepId);
        }
      }
      // If it was paused, resume; if running, it's already running
      if (this.machine.state.status === 'paused') {
        this.machine.resume();
      } else if (this.machine.state.status !== 'running') {
        this.machine.start();
      }
    } else {
      const stepIds = this.definition.steps.map((s) => s.id);
      const initial = createInitialState(this.definition.id, session.id, stepIds);
      this.machine = new PipelineStateMachine(initial);
      this.machine.start();
    }

    this.abortController = new AbortController();

    this.events.emit('pipeline:started', { sessionId: session.id });
    await this.persist();
    this.scheduleNext();
  }

  /** Pause the pipeline. Running steps finish, but no new steps are picked up. */
  async pause(): Promise<void> {
    this.machine.pause();

    // Mark running steps as paused
    for (const step of this.machine.stepsByStatus(StepStatus.Running)) {
      this.abortStep(step.stepId);
      this.machine.transitionStep(step.stepId, StepStatus.Paused);
    }

    this.clearAllRetryTimers();

    this.events.emit('pipeline:paused', { sessionId: this.machine.state.sessionId });
    await this.persist();
  }

  /** Resume a paused pipeline. */
  async resume(): Promise<void> {
    this.machine.resume();

    // Move paused steps back to queued
    for (const step of this.machine.stepsByStatus(StepStatus.Paused)) {
      this.machine.transitionStep(step.stepId, StepStatus.Queued);
    }

    // Refresh the master abort controller
    this.abortController = new AbortController();

    this.events.emit('pipeline:resumed', { sessionId: this.machine.state.sessionId });
    await this.persist();
    this.scheduleNext();
  }

  /** Cancel the pipeline entirely. Aborts all running steps. */
  async cancel(): Promise<void> {
    // Abort everything
    this.abortController?.abort();
    for (const [, ctrl] of this.stepAbortControllers) {
      ctrl.abort();
    }
    this.stepAbortControllers.clear();
    this.clearAllRetryTimers();

    // Mark in-flight steps
    for (const step of this.machine.stepsByStatus(StepStatus.Running)) {
      this.machine.transitionStep(step.stepId, StepStatus.Failed);
      step.error = 'Cancelled by user';
    }
    for (const step of this.machine.stepsByStatus(StepStatus.Paused)) {
      this.machine.transitionStep(step.stepId, StepStatus.Queued);
      this.machine.transitionStep(step.stepId, StepStatus.Skipped);
    }

    this.recovery.skipRemainingSteps(this.machine);
    this.machine.cancel();

    this.events.emit('pipeline:cancelled', { sessionId: this.machine.state.sessionId });
    await this.persist();
  }

  /** Manually retry a specific failed step. */
  async retryStep(stepId: string): Promise<void> {
    this.recovery.manualRetry(this.machine, stepId);
    await this.persist();

    // Kick scheduling if the pipeline is running
    if (this.machine.state.status === 'running') {
      this.scheduleNext();
    }
  }

  /** Manually skip a specific failed step. */
  async skipStep(stepId: string): Promise<void> {
    this.recovery.skipStep(this.machine, stepId);
    await this.persist();

    if (this.machine.state.status === 'running') {
      this.scheduleNext();
    }
  }

  /** Return a read-only snapshot of the current pipeline state. */
  getState(): Readonly<PipelineState> {
    return this.machine.state;
  }

  // =========================================================================
  // Scheduling loop
  // =========================================================================

  /**
   * Core scheduling loop.  Determines which steps are ready, launches them
   * in parallel, and re-invokes itself when any step completes.
   */
  private scheduleNext(): void {
    if (this.scheduling) {
      return; // prevent re-entrant calls
    }
    this.scheduling = true;

    try {
      if (
        this.machine.state.status !== 'running' ||
        this.abortController?.signal.aborted
      ) {
        return;
      }

      // 1. Skip steps whose required dependencies have failed
      const toSkip = this.scheduler.getStepsToSkip(
        this.machine.state.steps,
        this.optionalSteps,
      );
      for (const id of toSkip) {
        this.machine.transitionStep(id, StepStatus.Skipped);
        this.events.emit('pipeline:stepCompleted', {
          sessionId: this.machine.state.sessionId,
          stepId: id,
        });
      }

      // 2. Find steps ready to run
      const ready = this.scheduler.getReadySteps(this.machine.state.steps);
      for (const id of ready) {
        this.machine.transitionStep(id, StepStatus.Queued);
      }

      // 3. Launch all queued steps
      const queued = this.machine.stepsByStatus(StepStatus.Queued);
      for (const step of queued) {
        this.launchStep(step.stepId);
      }

      // 4. Check for terminal state
      if (this.machine.allStepsTerminal()) {
        this.finalizePipeline();
      }
    } finally {
      this.scheduling = false;
    }
  }

  // =========================================================================
  // Step execution
  // =========================================================================

  private launchStep(stepId: string): void {
    const stepDef = this.definition.steps.find((s) => s.id === stepId);
    if (!stepDef) {
      throw new PipelineError(`Step definition not found: "${stepId}"`, stepId);
    }

    const mod = this.modules.get(stepDef.moduleId);
    if (!mod) {
      throw new PipelineError(
        `Module "${stepDef.moduleId}" not found for step "${stepId}"`,
        stepId,
      );
    }

    // Per-step abort controller, chained to the master controller
    const stepAbort = new AbortController();
    this.stepAbortControllers.set(stepId, stepAbort);

    // If master aborts, also abort this step
    const onMasterAbort = () => stepAbort.abort();
    this.abortController?.signal.addEventListener('abort', onMasterAbort, { once: true });

    // Transition: queued -> running
    this.machine.transitionStep(stepId, StepStatus.Running);
    this.events.emit('pipeline:stepStarted', {
      sessionId: this.machine.state.sessionId,
      stepId,
    });

    // Build input from upstream outputs
    const input = this.scheduler.buildStepInput(stepId, this.machine.state.steps);

    const context: ModuleContext = {
      sessionId: this.machine.state.sessionId,
      stepId,
      abortSignal: stepAbort.signal,
      progress: (pct, message) => {
        this.events.emit('pipeline:stepProgress', {
          sessionId: this.machine.state.sessionId,
          stepId,
          progress: pct,
          message,
        });
      },
    };

    // Execute asynchronously
    mod
      .executeStep(stepId, input, context)
      .then((output) => {
        if (stepAbort.signal.aborted) {
          return; // step was cancelled while running
        }

        const step = this.machine.getStepOrThrow(stepId);
        step.output = output;
        this.machine.transitionStep(stepId, StepStatus.Completed);

        this.events.emit('pipeline:stepCompleted', {
          sessionId: this.machine.state.sessionId,
          stepId,
        });

        this.cleanupStep(stepId, onMasterAbort);
        this.persist().then(() => this.scheduleNext());
      })
      .catch((err: Error) => {
        if (stepAbort.signal.aborted) {
          return; // step was cancelled
        }

        this.handleStepFailure(stepId, err, onMasterAbort);
      });

    // Persist the "running" state (fire-and-forget)
    this.persist();
  }

  // =========================================================================
  // Error handling
  // =========================================================================

  private handleStepFailure(
    stepId: string,
    error: Error,
    onMasterAbort: () => void,
  ): void {
    const step = this.machine.getStepOrThrow(stepId);
    step.error = error.message;
    this.machine.transitionStep(stepId, StepStatus.Failed);

    this.events.emit('pipeline:stepFailed', {
      sessionId: this.machine.state.sessionId,
      stepId,
      error: error.message,
    });

    this.cleanupStep(stepId, onMasterAbort);

    // Determine error code for retry eligibility
    const errorCode = error instanceof PipelineError ? error.code : undefined;

    if (this.recovery.canRetry(step, errorCode)) {
      const delay = this.recovery.scheduleRetry(this.machine, stepId);

      const timer = setTimeout(() => {
        this.retryTimers.delete(stepId);
        if (this.machine.state.status === 'running') {
          this.launchStep(stepId);
        }
      }, delay);

      this.retryTimers.set(stepId, timer);
      this.persist();
    } else {
      // No more retries — check if this is fatal for the pipeline
      if (!this.optionalSteps.has(stepId)) {
        // Non-optional step exhausted retries: fail the pipeline
        this.persist().then(() => this.scheduleNext());
      } else {
        // Optional step failed — continue scheduling
        this.persist().then(() => this.scheduleNext());
      }
    }
  }

  // =========================================================================
  // Pipeline finalization
  // =========================================================================

  private finalizePipeline(): void {
    if (this.machine.hasFailedRequired(this.optionalSteps)) {
      this.machine.fail();
      const failedSteps = Object.values(this.machine.state.steps)
        .filter(s => s.status === StepStatus.Failed && !this.optionalSteps.has(s.stepId))
        .map(s => {
          const def = this.definition.steps.find(d => d.id === s.stepId);
          return `${def?.name ?? s.stepId}: ${s.error ?? 'unknown error'}`;
        });
      this.events.emit('pipeline:failed', {
        sessionId: this.machine.state.sessionId,
        error: failedSteps.length > 0
          ? `Failed steps:\n${failedSteps.join('\n')}`
          : 'One or more required steps failed',
      });
    } else {
      this.machine.complete();
      this.events.emit('pipeline:completed', {
        sessionId: this.machine.state.sessionId,
      });
    }

    this.persist();
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async persist(): Promise<void> {
    try {
      await this.store.saveState(
        // Deep-copy to avoid races with in-flight mutations
        JSON.parse(JSON.stringify(this.machine.state)) as PipelineState,
      );
    } catch {
      // Persistence failures are non-fatal; the engine continues.
    }
  }

  private abortStep(stepId: string): void {
    const ctrl = this.stepAbortControllers.get(stepId);
    if (ctrl) {
      ctrl.abort();
      this.stepAbortControllers.delete(stepId);
    }
  }

  private cleanupStep(stepId: string, onMasterAbort: () => void): void {
    this.stepAbortControllers.delete(stepId);
    this.abortController?.signal.removeEventListener('abort', onMasterAbort);
  }

  private clearAllRetryTimers(): void {
    for (const [, timer] of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }
}
