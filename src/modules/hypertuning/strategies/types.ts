import type { ParamDefinition, Trial, TuningObjective, ParamConstraint } from '../../../core/types';

export interface ISearchStrategy {
  suggest(
    paramSpace: ParamDefinition[],
    history: Trial[],
    objective: TuningObjective,
    constraints: ParamConstraint[],
  ): Promise<Record<string, string | number | boolean>>;
}
