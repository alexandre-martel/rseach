import type { ISearchStrategy } from './types';
import type { ParamDefinition, Trial, TuningObjective, ParamConstraint } from '../../../core/types';

export class RandomStrategy implements ISearchStrategy {
  async suggest(
    paramSpace: ParamDefinition[],
    _history: Trial[],
    _objective: TuningObjective,
    _constraints: ParamConstraint[],
  ): Promise<Record<string, string | number | boolean>> {
    const params: Record<string, string | number | boolean> = {};

    for (const param of paramSpace) {
      params[param.name] = this.sampleParam(param);
    }

    return params;
  }

  private sampleParam(param: ParamDefinition): string | number | boolean {
    switch (param.type) {
      case 'choice':
        if (!param.values || param.values.length === 0) {
          return '';
        }
        return param.values[Math.floor(Math.random() * param.values.length)];

      case 'bool':
        return Math.random() < 0.5;

      case 'float': {
        const min = param.min ?? 0;
        const max = param.max ?? 1;
        if (param.scale === 'log') {
          const logMin = Math.log(min);
          const logMax = Math.log(max);
          return Math.exp(logMin + Math.random() * (logMax - logMin));
        }
        return min + Math.random() * (max - min);
      }

      case 'int': {
        const min = Math.ceil(param.min ?? 0);
        const max = Math.floor(param.max ?? 100);
        if (param.scale === 'log') {
          const logMin = Math.log(min);
          const logMax = Math.log(max);
          return Math.round(Math.exp(logMin + Math.random() * (logMax - logMin)));
        }
        return Math.floor(min + Math.random() * (max - min + 1));
      }

      default:
        return '';
    }
  }
}
