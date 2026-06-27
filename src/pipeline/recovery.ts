import type { RetryPolicy, StepState } from './types';
import { DEFAULT_RETRY_POLICY, StepStatus } from './types';
import { PipelineStateMachine } from './state';

// ---------------------------------------------------------------------------
// Recovery manager
// ---------------------------------------------------------------------------

/**
 * Handles per-step retry logic with exponential backoff, and provides
 * helpers for manual retry / skip of failed steps.
 */
export class RecoveryManager {
  private readonly retryPolicies: Map<string, RetryPolicy>;

  constructor(policies: Map<string, RetryPolicy>) {
    this.retryPolicies = policies;
  }

  // -- Retry eligibility ----------------------------------------------------

  /** Get the effective retry policy for a step. */
  getPolicy(stepId: string): RetryPolicy {
    return this.retryPolicies.get(stepId) ?? DEFAULT_RETRY_POLICY;
  }

  /**
   * Determine whether a failed step is eligible for an automatic retry
   * based on its attempt count and the applicable policy.
   */
  canRetry(step: Readonly<StepState>, errorCode?: string): boolean {
    const policy = this.getPolicy(step.stepId);

    if (step.status !== StepStatus.Failed) {
      return false;
    }

    if (step.attempts >= policy.maxAttempts) {
      return false;
    }

    if (
      policy.retryableErrorCodes &&
      policy.retryableErrorCodes.length > 0 &&
      errorCode &&
      !policy.retryableErrorCodes.includes(errorCode)
    ) {
      return false;
    }

    return true;
  }

  // -- Delay computation ----------------------------------------------------

  /**
   * Compute the delay (in ms) before the next retry attempt using
   * exponential backoff with jitter.
   */
  getRetryDelay(step: Readonly<StepState>): number {
    const policy = this.getPolicy(step.stepId);
    const attempt = step.attempts; // 0-based: first retry = attempt 1, so delay = base * mult^0

    const exponential = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
    const capped = Math.min(exponential, policy.maxDelayMs);

    // Add +-25 % jitter to avoid thundering herd
    const jitter = capped * (0.75 + Math.random() * 0.5);
    return Math.round(jitter);
  }

  // -- State mutations via the state machine --------------------------------

  /**
   * Schedule a failed step for retry: transition it back to Queued and bump
   * the attempt counter.  Returns the computed delay before execution should
   * start.
   *
   * Throws if the step is not in Failed status or has exhausted retries.
   */
  scheduleRetry(machine: PipelineStateMachine, stepId: string): number {
    const step = machine.getStepOrThrow(stepId);

    if (!this.canRetry(step)) {
      throw new Error(
        `Step "${stepId}" is not eligible for retry ` +
        `(status=${step.status}, attempts=${step.attempts}/${this.getPolicy(stepId).maxAttempts})`,
      );
    }

    const delay = this.getRetryDelay(step);

    // Transition failed -> queued
    machine.transitionStep(stepId, StepStatus.Queued);
    step.attempts += 1;
    step.error = undefined;

    return delay;
  }

  /**
   * Manually retry a failed step (user-initiated).  Resets attempts to 0
   * so the full retry budget is available again.
   */
  manualRetry(machine: PipelineStateMachine, stepId: string): void {
    const step = machine.getStepOrThrow(stepId);

    if (step.status !== StepStatus.Failed) {
      throw new Error(
        `Cannot manually retry step "${stepId}" — current status is "${step.status}"`,
      );
    }

    step.attempts = 0;
    step.error = undefined;
    machine.transitionStep(stepId, StepStatus.Queued);
  }

  /**
   * Skip a failed step (user-initiated).  Downstream steps whose deps are
   * met will become eligible for scheduling.
   */
  skipStep(machine: PipelineStateMachine, stepId: string): void {
    const step = machine.getStepOrThrow(stepId);

    if (step.status !== StepStatus.Failed && step.status !== StepStatus.Pending) {
      throw new Error(
        `Cannot skip step "${stepId}" — current status is "${step.status}"`,
      );
    }

    machine.transitionStep(stepId, StepStatus.Skipped);
  }

  // -- Bulk operations ------------------------------------------------------

  /**
   * After an unrecoverable pipeline failure, mark all non-terminal pending /
   * queued steps as skipped so the state snapshot is clean.
   */
  skipRemainingSteps(machine: PipelineStateMachine): void {
    const pendingSteps = [
      ...machine.stepsByStatus(StepStatus.Pending),
      ...machine.stepsByStatus(StepStatus.Queued),
    ];

    for (const step of pendingSteps) {
      machine.transitionStep(step.stepId, StepStatus.Skipped);
    }
  }

  /**
   * Collect outputs from all completed steps, preserving partial results
   * even when the pipeline has failed overall.
   */
  collectCompletedOutputs(
    machine: PipelineStateMachine,
  ): Map<string, StepState> {
    const completed = machine.stepsByStatus(StepStatus.Completed);
    const result = new Map<string, StepState>();
    for (const step of completed) {
      result.set(step.stepId, { ...step });
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a RecoveryManager from step definitions, using each step's
 * retryPolicy override (or falling back to the pipeline default).
 */
export function createRecoveryManager(
  steps: Array<{ id: string; retryPolicy?: RetryPolicy }>,
  defaultPolicy: RetryPolicy,
): RecoveryManager {
  const policies = new Map<string, RetryPolicy>();
  for (const step of steps) {
    policies.set(step.id, step.retryPolicy ?? defaultPolicy);
  }
  return new RecoveryManager(policies);
}
