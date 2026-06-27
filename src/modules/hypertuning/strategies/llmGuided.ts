import type { ISearchStrategy } from './types';
import type { ParamDefinition, Trial, TuningObjective, ParamConstraint } from '../../../core/types';
import type { ILLMService } from '../../types';

export class LLMGuidedStrategy implements ISearchStrategy {
  constructor(private llm: ILLMService) {}

  async suggest(
    paramSpace: ParamDefinition[],
    history: Trial[],
    objective: TuningObjective,
    constraints: ParamConstraint[],
  ): Promise<Record<string, string | number | boolean>> {
    if (history.length === 0) {
      return this.suggestInitial(paramSpace);
    }

    const completedTrials = history.filter(t => t.status === 'completed');

    const paramDesc = paramSpace.map(p => {
      if (p.type === 'choice') {
        return `- ${p.name} (${p.type}): values=[${p.values?.join(', ')}]`;
      }
      if (p.type === 'bool') {
        return `- ${p.name} (bool)`;
      }
      return `- ${p.name} (${p.type}): range=[${p.min}, ${p.max}], scale=${p.scale ?? 'linear'}`;
    }).join('\n');

    const constraintDesc = constraints.length > 0
      ? `\nConstraints:\n${constraints.map(c => `- ${c.rule} (${c.reason})`).join('\n')}`
      : '';

    const historyDesc = completedTrials
      .sort((a, b) => {
        const aVal = a.metrics[objective.metric] ?? 0;
        const bVal = b.metrics[objective.metric] ?? 0;
        return objective.direction === 'maximize' ? bVal - aVal : aVal - bVal;
      })
      .slice(0, 20)
      .map(t => {
        const params = Object.entries(t.params).map(([k, v]) => `${k}=${v}`).join(', ');
        const metricVal = t.metrics[objective.metric];
        return `Trial #${t.number}: {${params}} -> ${objective.metric}=${metricVal?.toFixed(6) ?? 'N/A'}`;
      })
      .join('\n');

    const response = await this.llm.complete([
      {
        role: 'system',
        content: `You are an expert ML researcher performing hyperparameter optimization.
Given the parameter space, past trial results, and an objective, suggest the NEXT set of hyperparameters to try.

Reason about:
1. Which parameter values led to the best results
2. Unexplored regions that might contain better configurations
3. Parameter interactions and correlations
4. The direction of improvement trends

Respond with ONLY a valid JSON object mapping parameter names to their values. No explanation.
Example: {"learning_rate": 0.001, "batch_size": 32, "dropout": 0.2}`,
      },
      {
        role: 'user',
        content: `Parameter space:
${paramDesc}
${constraintDesc}

Objective: ${objective.direction} ${objective.metric}

Trial history (${completedTrials.length} completed, sorted by ${objective.metric}):
${historyDesc}

Suggest the next set of hyperparameters:`,
      },
    ], { responseFormat: 'json', temperature: 0.4 });

    try {
      const suggested = JSON.parse(response.content);
      return this.validateAndClamp(suggested, paramSpace);
    } catch {
      return this.suggestInitial(paramSpace);
    }
  }

  private suggestInitial(paramSpace: ParamDefinition[]): Record<string, string | number | boolean> {
    const params: Record<string, string | number | boolean> = {};
    for (const p of paramSpace) {
      if (p.default !== undefined) {
        params[p.name] = p.default;
      } else if (p.type === 'choice' && p.values) {
        params[p.name] = p.values[Math.floor(p.values.length / 2)];
      } else if (p.type === 'bool') {
        params[p.name] = false;
      } else if (p.type === 'float' || p.type === 'int') {
        const min = p.min ?? 0;
        const max = p.max ?? 1;
        const mid = p.scale === 'log'
          ? Math.exp((Math.log(min) + Math.log(max)) / 2)
          : (min + max) / 2;
        params[p.name] = p.type === 'int' ? Math.round(mid) : mid;
      }
    }
    return params;
  }

  private validateAndClamp(
    suggested: Record<string, unknown>,
    paramSpace: ParamDefinition[],
  ): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};

    for (const p of paramSpace) {
      const val = suggested[p.name];

      if (val === undefined) {
        const initial = this.suggestInitial([p]);
        result[p.name] = initial[p.name];
        continue;
      }

      switch (p.type) {
        case 'float': {
          const num = Number(val);
          result[p.name] = Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, isNaN(num) ? (p.min ?? 0) : num));
          break;
        }
        case 'int': {
          const num = Math.round(Number(val));
          result[p.name] = Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, isNaN(num) ? (p.min ?? 0) : num));
          break;
        }
        case 'choice': {
          const strVal = String(val);
          result[p.name] = p.values?.includes(strVal) || p.values?.includes(Number(val))
            ? val as string | number
            : p.values?.[0] ?? '';
          break;
        }
        case 'bool':
          result[p.name] = Boolean(val);
          break;
        default:
          result[p.name] = String(val);
      }
    }

    return result;
  }
}
