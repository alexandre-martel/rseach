import { PipelineError } from '../core/errors';
import type { PipelineStepDefinition, StepInput, StepOutput, StepState } from './types';
import { StepStatus } from './types';

// ---------------------------------------------------------------------------
// DAG representation
// ---------------------------------------------------------------------------

interface DagNode {
  stepId: string;
  /** IDs of steps this node depends on. */
  dependencies: ReadonlySet<string>;
  /** IDs of steps that depend on this node. */
  dependents: Set<string>;
}

// ---------------------------------------------------------------------------
// DAGScheduler
// ---------------------------------------------------------------------------

/**
 * Parses the `dependsOn` edges of a PipelineDefinition's steps into a DAG,
 * validates acyclicity, and computes execution "waves" — groups of steps
 * whose dependencies have all been satisfied.
 */
export class DAGScheduler {
  private readonly nodes: Map<string, DagNode>;
  private readonly stepDefs: Map<string, PipelineStepDefinition>;

  constructor(steps: PipelineStepDefinition[]) {
    this.stepDefs = new Map(steps.map((s) => [s.id, s]));
    this.nodes = this.buildGraph(steps);
    this.validateAcyclic();
  }

  // -- Graph construction ---------------------------------------------------

  private buildGraph(steps: PipelineStepDefinition[]): Map<string, DagNode> {
    const nodes = new Map<string, DagNode>();

    // Create nodes
    for (const step of steps) {
      nodes.set(step.id, {
        stepId: step.id,
        dependencies: new Set(step.dependsOn),
        dependents: new Set(),
      });
    }

    // Validate edges and populate dependents
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!nodes.has(dep)) {
          throw new PipelineError(
            `Step "${step.id}" depends on unknown step "${dep}"`,
            step.id,
          );
        }
        nodes.get(dep)!.dependents.add(step.id);
      }
    }

    return nodes;
  }

  // -- Cycle detection (Kahn's algorithm) ------------------------------------

  private validateAcyclic(): void {
    // In-degree map
    const inDegree = new Map<string, number>();
    for (const [id, node] of this.nodes) {
      inDegree.set(id, node.dependencies.size);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      visited++;
      const node = this.nodes.get(current)!;
      for (const dep of node.dependents) {
        const newDeg = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) {
          queue.push(dep);
        }
      }
    }

    if (visited !== this.nodes.size) {
      // Find nodes still with non-zero in-degree to report them
      const cycleNodes = [...inDegree.entries()]
        .filter(([, d]) => d > 0)
        .map(([id]) => id);
      throw new PipelineError(
        `Pipeline DAG contains a cycle involving steps: ${cycleNodes.join(', ')}`,
      );
    }
  }

  // -- Topological waves ----------------------------------------------------

  /**
   * Return the full topological ordering as successive "waves".
   * Each wave contains step IDs whose dependencies all fall in earlier waves,
   * so every step in a wave can run in parallel.
   */
  computeWaves(): string[][] {
    const inDegree = new Map<string, number>();
    for (const [id, node] of this.nodes) {
      inDegree.set(id, node.dependencies.size);
    }

    const waves: string[][] = [];
    const remaining = new Set(this.nodes.keys());

    while (remaining.size > 0) {
      const wave: string[] = [];
      for (const id of remaining) {
        if (inDegree.get(id) === 0) {
          wave.push(id);
        }
      }

      if (wave.length === 0) {
        // Should never happen after cycle validation, but guard anyway
        throw new PipelineError('Deadlock detected while computing execution waves');
      }

      for (const id of wave) {
        remaining.delete(id);
        const node = this.nodes.get(id)!;
        for (const dep of node.dependents) {
          inDegree.set(dep, inDegree.get(dep)! - 1);
        }
      }

      waves.push(wave);
    }

    return waves;
  }

  // -- Runtime scheduling ---------------------------------------------------

  /**
   * Given the current step states, return the set of step IDs that are ready
   * to execute right now — i.e. all their dependencies are completed.
   *
   * Steps that are already queued, running, completed, failed, or skipped are
   * excluded from the result.
   */
  getReadySteps(stepStates: Readonly<Record<string, StepState>>): string[] {
    const ready: string[] = [];

    for (const [id, node] of this.nodes) {
      const state = stepStates[id];
      if (!state || state.status !== StepStatus.Pending) {
        continue;
      }

      const allDepsMet = [...node.dependencies].every((depId) => {
        const depState = stepStates[depId];
        return (
          depState &&
          (depState.status === StepStatus.Completed ||
            depState.status === StepStatus.Skipped)
        );
      });

      if (allDepsMet) {
        ready.push(id);
      }
    }

    return ready;
  }

  /**
   * Return step IDs that should be skipped because a required (non-optional)
   * upstream dependency has failed.
   */
  getStepsToSkip(
    stepStates: Readonly<Record<string, StepState>>,
    optionalStepIds: ReadonlySet<string>,
  ): string[] {
    const toSkip: string[] = [];

    for (const [id, node] of this.nodes) {
      const state = stepStates[id];
      if (!state || state.status !== StepStatus.Pending) {
        continue;
      }

      const hasFailedRequiredDep = [...node.dependencies].some((depId) => {
        const depState = stepStates[depId];
        return (
          depState &&
          depState.status === StepStatus.Failed &&
          !optionalStepIds.has(depId)
        );
      });

      const hasSkippedDep = [...node.dependencies].some((depId) => {
        const depState = stepStates[depId];
        return depState && depState.status === StepStatus.Skipped;
      });

      if (hasFailedRequiredDep || hasSkippedDep) {
        toSkip.push(id);
      }
    }

    return toSkip;
  }

  // -- Data plumbing --------------------------------------------------------

  /**
   * Assemble the input for a step by merging the outputs of its dependencies.
   * Later dependencies overwrite earlier ones when keys collide.
   */
  buildStepInput(
    stepId: string,
    stepStates: Readonly<Record<string, StepState>>,
  ): StepInput {
    const node = this.nodes.get(stepId);
    if (!node) {
      throw new PipelineError(`Unknown step "${stepId}"`, stepId);
    }

    const merged: StepInput = { data: {}, artifacts: [] };
    const stepDef = this.stepDefs.get(stepId)!;

    // Merge config from the step definition
    Object.assign(merged.data, stepDef.config);

    // Merge outputs from completed dependencies
    for (const depId of node.dependencies) {
      const depState = stepStates[depId];
      if (depState?.output) {
        Object.assign(merged.data, depState.output.data);
        merged.artifacts.push(...depState.output.artifacts);
      }
    }

    return merged;
  }

  // -- Introspection --------------------------------------------------------

  /** Return the direct dependency IDs for a step. */
  getDependencies(stepId: string): string[] {
    const node = this.nodes.get(stepId);
    return node ? [...node.dependencies] : [];
  }

  /** Return the IDs of steps that directly depend on the given step. */
  getDependents(stepId: string): string[] {
    const node = this.nodes.get(stepId);
    return node ? [...node.dependents] : [];
  }

  /** Total number of steps. */
  get size(): number {
    return this.nodes.size;
  }
}
