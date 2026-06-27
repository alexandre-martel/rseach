import type { Trial, TuningObjective } from '../../core/types';

export interface ConvergenceResult {
  converged: boolean;
  reason?: string;
  bestValue: number;
  improvementRate: number;
  plateauLength: number;
}

export class ConvergenceDetector {
  constructor(
    private patience: number = 10,
    private minImprovement: number = 0.001,
  ) {}

  check(trials: Trial[], objective: TuningObjective): ConvergenceResult {
    const completedTrials = trials
      .filter(t => t.status === 'completed' && t.metrics[objective.metric] !== undefined)
      .sort((a, b) => a.number - b.number);

    if (completedTrials.length < 3) {
      return {
        converged: false,
        bestValue: 0,
        improvementRate: 0,
        plateauLength: 0,
      };
    }

    // Track running best
    const isMaximize = objective.direction === 'maximize';
    let best = isMaximize ? -Infinity : Infinity;
    let lastImprovedAt = 0;
    const bestHistory: number[] = [];

    for (const trial of completedTrials) {
      const val = trial.metrics[objective.metric];
      const improved = isMaximize ? val > best : val < best;
      if (improved) {
        best = val;
        lastImprovedAt = trial.number;
      }
      bestHistory.push(best);
    }

    const plateauLength = completedTrials.length > 0
      ? completedTrials[completedTrials.length - 1].number - lastImprovedAt
      : 0;

    // Improvement rate: how much did we improve in the last N trials
    const recentWindow = Math.min(5, bestHistory.length);
    const recentBests = bestHistory.slice(-recentWindow);
    const improvementRate = recentBests.length > 1
      ? Math.abs(recentBests[recentBests.length - 1] - recentBests[0]) / recentWindow
      : 0;

    const converged = plateauLength >= this.patience;

    return {
      converged,
      reason: converged
        ? `No improvement in ${plateauLength} trials (patience: ${this.patience})`
        : undefined,
      bestValue: best,
      improvementRate,
      plateauLength,
    };
  }
}
