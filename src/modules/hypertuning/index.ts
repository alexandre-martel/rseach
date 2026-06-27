import type { IResearchModule, ModuleMetadata, ModuleCapability, StepDefinition, StepInput, StepOutput, ModuleContext } from '../types';
import { ParamSpaceGenerator } from './paramSpace';
import { GridStrategy, RandomStrategy, BayesianStrategy, LLMGuidedStrategy } from './strategies/index';
import type { ISearchStrategy } from './strategies/types';
import type { ParamDefinition, Trial, HyperTuningSession, TuningObjective, TuningBudget, ParamConstraint } from '../../core/types';

export class HyperTuningModule implements IResearchModule {
  readonly metadata: ModuleMetadata = {
    id: 'hypertuning',
    name: 'Hyperparameter Tuning',
    version: '0.1.0',
    description: 'Prompt-driven hyperparameter optimization with grid, random, Bayesian, and LLM-guided strategies',
    capabilities: ['execute' as ModuleCapability, 'analyze' as ModuleCapability, 'visualize' as ModuleCapability],
    dependencies: [],
    configSchema: {},
  };

  getAvailableSteps(): StepDefinition[] {
    return [
      {
        id: 'generate-param-space',
        name: 'Generate Parameter Space',
        description: 'Use LLM to generate a parameter space from a natural language description',
        inputs: ['prompt'],
        outputs: ['paramSpace', 'constraints', 'objective', 'command'],
      },
      {
        id: 'scan-project',
        name: 'Scan Project',
        description: 'Detect framework, training script, and existing hyperparameters',
        inputs: ['projectPath'],
        outputs: ['framework', 'trainScript', 'detectedParams'],
      },
      {
        id: 'run-trial',
        name: 'Run Trial',
        description: 'Execute a single trial with given hyperparameters',
        inputs: ['command', 'params'],
        outputs: ['metrics', 'logs'],
      },
      {
        id: 'tune-loop',
        name: 'Tuning Loop',
        description: 'Run the full hyperparameter tuning loop',
        inputs: ['paramSpace', 'command', 'strategy', 'budget'],
        outputs: ['trials', 'bestConfig', 'report'],
      },
      {
        id: 'analyze-results',
        name: 'Analyze Tuning Results',
        description: 'Generate summary and visualizations from trial history',
        inputs: ['trials', 'objective'],
        outputs: ['summary', 'charts', 'bestConfig'],
      },
    ];
  }

  async executeStep(stepId: string, input: StepInput, context: ModuleContext): Promise<StepOutput> {
    switch (stepId) {
      case 'generate-param-space':
        return this.generateParamSpace(input, context);
      case 'scan-project':
        return this.scanProject(input, context);
      case 'run-trial':
        return this.runTrial(input, context);
      case 'tune-loop':
        return this.tuneLoop(input, context);
      case 'analyze-results':
        return this.analyzeResults(input, context);
      default:
        throw new Error(`Unknown step: ${stepId}`);
    }
  }

  private async generateParamSpace(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const prompt = input.data.prompt as string;

    const response = await context.llm.complete([
      {
        role: 'system',
        content: `You are a machine learning expert. Given a natural language description of hyperparameter tuning needs, generate a structured JSON configuration.

Respond with ONLY a valid JSON object with this exact structure:
{
  "params": [{"name": "...", "type": "float|int|choice|bool", "min": ..., "max": ..., "scale": "linear|log", "values": [...]}],
  "constraints": [{"rule": "...", "reason": "..."}],
  "objective": {"metric": "...", "direction": "maximize|minimize"},
  "budget": {"maxTrials": ..., "maxTime": "..."},
  "command": "...",
  "strategy": "grid|random|bayesian|llm-guided"
}

For params:
- float/int: provide min, max, and optionally scale ("log" for learning rates)
- choice: provide values array
- bool: no min/max needed

Infer reasonable defaults for anything not specified. Prefer llm-guided strategy unless the user specifies otherwise.`,
      },
      { role: 'user', content: prompt },
    ], { responseFormat: 'json', temperature: 0.2 });

    const config = JSON.parse(response.content);

    return {
      data: {
        paramSpace: config.params,
        constraints: config.constraints ?? [],
        objective: config.objective,
        budget: config.budget,
        command: config.command ?? '',
        strategy: config.strategy ?? 'llm-guided',
      },
      artifacts: [],
      summary: `Generated parameter space with ${config.params.length} parameters, strategy: ${config.strategy}`,
    };
  }

  private async scanProject(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const projectPath = input.data.projectPath as string || '.';

    const response = await context.llm.complete([
      {
        role: 'system',
        content: `You are analyzing a project to detect its ML framework, training script, and hyperparameters.
Based on the project description, identify:
1. Framework (pytorch, tensorflow, jax, stable-baselines3, etc.)
2. Training entry point script
3. Existing hyperparameters that could be tuned

Respond with JSON: {"framework": "...", "trainScript": "...", "detectedParams": [{"name": "...", "currentValue": "...", "type": "..."}]}`,
      },
      { role: 'user', content: `Analyze project at: ${projectPath}` },
    ], { responseFormat: 'json' });

    const result = JSON.parse(response.content);

    return {
      data: result,
      artifacts: [],
      summary: `Detected framework: ${result.framework}, found ${result.detectedParams?.length ?? 0} tunable parameters`,
    };
  }

  private async runTrial(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const command = input.data.command as string;
    const params = input.data.params as Record<string, string | number | boolean>;

    let expandedCommand = command;
    for (const [key, value] of Object.entries(params)) {
      expandedCommand = expandedCommand.replace(`{${key}}`, String(value));
    }

    return {
      data: {
        command: expandedCommand,
        params,
        metrics: {},
        status: 'configured',
      },
      artifacts: [],
      summary: `Prepared trial command: ${expandedCommand}`,
    };
  }

  private async tuneLoop(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const paramSpace = input.data.paramSpace as ParamDefinition[];
    const command = input.data.command as string;
    const strategyName = (input.data.strategy as string) ?? 'llm-guided';
    const budget = input.data.budget as TuningBudget;
    const objective = input.data.objective as TuningObjective;
    const constraints = (input.data.constraints as ParamConstraint[]) ?? [];

    const strategy = this.createStrategy(strategyName, context);
    const trials: Trial[] = [];
    const maxTrials = budget?.maxTrials ?? 50;

    for (let i = 0; i < maxTrials; i++) {
      if (context.signal.aborted) { break; }

      const params = await strategy.suggest(paramSpace, trials, objective, constraints);

      const trial: Trial = {
        id: `trial-${i + 1}`,
        number: i + 1,
        params,
        metrics: {},
        status: 'pending',
      };

      trials.push(trial);
    }

    return {
      data: {
        trials,
        totalTrials: trials.length,
        strategy: strategyName,
      },
      artifacts: [],
      summary: `Generated ${trials.length} trial configurations using ${strategyName} strategy`,
    };
  }

  private async analyzeResults(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const trials = input.data.trials as Trial[];
    const objective = input.data.objective as TuningObjective;

    const completedTrials = trials.filter(t => t.status === 'completed');
    if (completedTrials.length === 0) {
      return {
        data: { summary: 'No completed trials to analyze' },
        artifacts: [],
        summary: 'No completed trials',
      };
    }

    const bestTrial = completedTrials.sort((a, b) => {
      const aVal = a.metrics[objective.metric] ?? 0;
      const bVal = b.metrics[objective.metric] ?? 0;
      return objective.direction === 'maximize' ? bVal - aVal : aVal - bVal;
    })[0];

    const response = await context.llm.complete([
      {
        role: 'system',
        content: 'You are analyzing hyperparameter tuning results. Provide insights about parameter importance, convergence behavior, and recommendations.',
      },
      {
        role: 'user',
        content: `Analyze these ${completedTrials.length} completed trials.
Objective: ${objective.direction} ${objective.metric}
Best trial #${bestTrial.number}: ${JSON.stringify(bestTrial.params)} -> ${objective.metric} = ${bestTrial.metrics[objective.metric]}

All trials:
${completedTrials.map(t => `#${t.number}: ${JSON.stringify(t.params)} -> ${objective.metric}=${t.metrics[objective.metric]}`).join('\n')}`,
      },
    ]);

    return {
      data: {
        bestConfig: bestTrial.params,
        bestMetrics: bestTrial.metrics,
        bestTrialNumber: bestTrial.number,
        analysis: response.content,
        totalTrials: trials.length,
        completedTrials: completedTrials.length,
      },
      artifacts: [],
      summary: `Best ${objective.metric}: ${bestTrial.metrics[objective.metric]?.toFixed(4)} (trial #${bestTrial.number})`,
    };
  }

  private createStrategy(name: string, context: ModuleContext): ISearchStrategy {
    switch (name) {
      case 'grid': return new GridStrategy();
      case 'random': return new RandomStrategy();
      case 'bayesian': return new BayesianStrategy();
      case 'llm-guided': return new LLMGuidedStrategy(context.llm);
      default: return new LLMGuidedStrategy(context.llm);
    }
  }
}
