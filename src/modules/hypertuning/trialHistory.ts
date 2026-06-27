import type { Trial, TuningObjective } from '../../core/types';

export interface TrialStats {
  totalTrials: number;
  completedTrials: number;
  failedTrials: number;
  runningTrials: number;
  bestTrial: Trial | null;
  worstTrial: Trial | null;
  meanMetric: number | null;
  stdMetric: number | null;
  convergenceCurve: { trialNumber: number; bestSoFar: number }[];
  paramImportance: { param: string; correlation: number }[];
}

export class TrialHistoryAnalyzer {
  analyze(trials: Trial[], objective: TuningObjective): TrialStats {
    const completed = trials.filter(t => t.status === 'completed');
    const withMetric = completed.filter(t => t.metrics[objective.metric] !== undefined);

    const isMax = objective.direction === 'maximize';

    const sorted = [...withMetric].sort((a, b) => {
      const aVal = a.metrics[objective.metric];
      const bVal = b.metrics[objective.metric];
      return isMax ? bVal - aVal : aVal - bVal;
    });

    const metricValues = withMetric.map(t => t.metrics[objective.metric]);
    const mean = metricValues.length > 0
      ? metricValues.reduce((a, b) => a + b, 0) / metricValues.length
      : null;
    const std = mean !== null && metricValues.length > 1
      ? Math.sqrt(metricValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / metricValues.length)
      : null;

    // Convergence curve: best-so-far at each trial
    let bestSoFar = isMax ? -Infinity : Infinity;
    const convergenceCurve: { trialNumber: number; bestSoFar: number }[] = [];
    for (const trial of withMetric.sort((a, b) => a.number - b.number)) {
      const val = trial.metrics[objective.metric];
      if (isMax ? val > bestSoFar : val < bestSoFar) {
        bestSoFar = val;
      }
      convergenceCurve.push({ trialNumber: trial.number, bestSoFar });
    }

    // Simple correlation-based param importance
    const paramImportance = this.computeParamImportance(withMetric, objective);

    return {
      totalTrials: trials.length,
      completedTrials: completed.length,
      failedTrials: trials.filter(t => t.status === 'failed').length,
      runningTrials: trials.filter(t => t.status === 'running').length,
      bestTrial: sorted[0] ?? null,
      worstTrial: sorted[sorted.length - 1] ?? null,
      meanMetric: mean,
      stdMetric: std,
      convergenceCurve,
      paramImportance,
    };
  }

  private computeParamImportance(
    trials: Trial[],
    objective: TuningObjective,
  ): { param: string; correlation: number }[] {
    if (trials.length < 3) { return []; }

    const allParams = new Set<string>();
    for (const t of trials) {
      for (const key of Object.keys(t.params)) {
        allParams.add(key);
      }
    }

    const metricValues = trials.map(t => t.metrics[objective.metric]);
    const result: { param: string; correlation: number }[] = [];

    for (const param of allParams) {
      const paramValues = trials.map(t => {
        const val = t.params[param];
        return typeof val === 'number' ? val : typeof val === 'boolean' ? (val ? 1 : 0) : NaN;
      });

      if (paramValues.some(isNaN)) {
        result.push({ param, correlation: 0 });
        continue;
      }

      const corr = this.pearsonCorrelation(paramValues, metricValues);
      result.push({ param, correlation: Math.abs(corr) });
    }

    return result.sort((a, b) => b.correlation - a.correlation);
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 2) { return 0; }

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      num += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const denom = Math.sqrt(denomX * denomY);
    return denom === 0 ? 0 : num / denom;
  }
}
