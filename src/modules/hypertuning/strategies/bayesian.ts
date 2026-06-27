import type { ISearchStrategy } from './types';
import type { ParamDefinition, Trial, TuningObjective, ParamConstraint } from '../../../core/types';

export class BayesianStrategy implements ISearchStrategy {
  async suggest(
    paramSpace: ParamDefinition[],
    history: Trial[],
    objective: TuningObjective,
    _constraints: ParamConstraint[],
  ): Promise<Record<string, string | number | boolean>> {
    if (history.length < 5) {
      return this.randomSample(paramSpace);
    }

    const completedTrials = history.filter(t => t.status === 'completed' && t.metrics[objective.metric] !== undefined);
    if (completedTrials.length < 3) {
      return this.randomSample(paramSpace);
    }

    // Simple TPE-inspired: split trials into good/bad, sample from good region
    const sorted = [...completedTrials].sort((a, b) => {
      const aVal = a.metrics[objective.metric];
      const bVal = b.metrics[objective.metric];
      return objective.direction === 'maximize' ? bVal - aVal : aVal - bVal;
    });

    const gamma = 0.25;
    const splitIdx = Math.max(1, Math.floor(sorted.length * gamma));
    const goodTrials = sorted.slice(0, splitIdx);

    const params: Record<string, string | number | boolean> = {};
    for (const param of paramSpace) {
      params[param.name] = this.sampleFromGoodRegion(param, goodTrials);
    }

    return params;
  }

  private sampleFromGoodRegion(param: ParamDefinition, goodTrials: Trial[]): string | number | boolean {
    const goodValues = goodTrials
      .map(t => t.params[param.name])
      .filter(v => v !== undefined);

    if (goodValues.length === 0) {
      return this.sampleRandom(param);
    }

    switch (param.type) {
      case 'choice':
      case 'bool': {
        // Mode of good values
        const counts = new Map<string, number>();
        for (const v of goodValues) {
          const key = String(v);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let bestKey = String(goodValues[0]);
        let bestCount = 0;
        for (const [key, count] of counts) {
          if (count > bestCount) { bestKey = key; bestCount = count; }
        }
        if (param.type === 'bool') { return bestKey === 'true'; }
        const origVal = param.values?.find(v => String(v) === bestKey);
        return origVal ?? bestKey;
      }

      case 'float':
      case 'int': {
        const numValues = goodValues.map(Number).filter(n => !isNaN(n));
        if (numValues.length === 0) { return this.sampleRandom(param); }

        const mean = numValues.reduce((a, b) => a + b, 0) / numValues.length;
        const stddev = Math.sqrt(
          numValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / numValues.length
        ) || (mean * 0.1);

        // Sample from truncated normal around the mean of good trials
        let value: number;
        const min = param.min ?? 0;
        const max = param.max ?? 1;
        do {
          const u1 = Math.random();
          const u2 = Math.random();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          value = mean + z * stddev;
        } while (value < min || value > max);

        return param.type === 'int' ? Math.round(value) : value;
      }

      default:
        return this.sampleRandom(param);
    }
  }

  private randomSample(paramSpace: ParamDefinition[]): Record<string, string | number | boolean> {
    const params: Record<string, string | number | boolean> = {};
    for (const param of paramSpace) {
      params[param.name] = this.sampleRandom(param);
    }
    return params;
  }

  private sampleRandom(param: ParamDefinition): string | number | boolean {
    switch (param.type) {
      case 'choice':
        return param.values?.[Math.floor(Math.random() * (param.values?.length ?? 1))] ?? '';
      case 'bool':
        return Math.random() < 0.5;
      case 'float': {
        const min = param.min ?? 0;
        const max = param.max ?? 1;
        if (param.scale === 'log') {
          return Math.exp(Math.log(min) + Math.random() * (Math.log(max) - Math.log(min)));
        }
        return min + Math.random() * (max - min);
      }
      case 'int': {
        const min = Math.ceil(param.min ?? 0);
        const max = Math.floor(param.max ?? 100);
        return Math.floor(min + Math.random() * (max - min + 1));
      }
      default:
        return '';
    }
  }
}
