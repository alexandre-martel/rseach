import type { ISearchStrategy } from './types';
import type { ParamDefinition, Trial, TuningObjective, ParamConstraint } from '../../../core/types';

export class GridStrategy implements ISearchStrategy {
  private gridIndex = 0;

  async suggest(
    paramSpace: ParamDefinition[],
    history: Trial[],
    _objective: TuningObjective,
    _constraints: ParamConstraint[],
  ): Promise<Record<string, string | number | boolean>> {
    const grid = this.buildGrid(paramSpace);
    const idx = history.length % grid.length;
    return grid[idx];
  }

  private buildGrid(paramSpace: ParamDefinition[]): Record<string, string | number | boolean>[] {
    const axes: { name: string; values: (string | number | boolean)[] }[] = [];

    for (const param of paramSpace) {
      if (param.type === 'choice' && param.values) {
        axes.push({ name: param.name, values: param.values });
      } else if (param.type === 'bool') {
        axes.push({ name: param.name, values: [true, false] });
      } else if (param.type === 'float' || param.type === 'int') {
        const steps = 5;
        const min = param.min ?? 0;
        const max = param.max ?? 1;
        const values: number[] = [];
        for (let i = 0; i < steps; i++) {
          const t = i / (steps - 1);
          if (param.scale === 'log') {
            values.push(Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min))));
          } else {
            values.push(min + t * (max - min));
          }
          if (param.type === 'int') {
            values[values.length - 1] = Math.round(values[values.length - 1]);
          }
        }
        axes.push({ name: param.name, values: [...new Set(values)] });
      }
    }

    return this.cartesianProduct(axes);
  }

  private cartesianProduct(axes: { name: string; values: (string | number | boolean)[] }[]): Record<string, string | number | boolean>[] {
    if (axes.length === 0) { return [{}]; }

    const [first, ...rest] = axes;
    const restProduct = this.cartesianProduct(rest);

    const result: Record<string, string | number | boolean>[] = [];
    for (const value of first.values) {
      for (const combo of restProduct) {
        result.push({ [first.name]: value, ...combo });
      }
    }
    return result;
  }
}
