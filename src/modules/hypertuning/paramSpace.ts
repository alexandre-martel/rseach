import type { ParamDefinition } from '../../core/types';

export class ParamSpaceGenerator {
  static createFromTemplate(framework: string): ParamDefinition[] {
    switch (framework.toLowerCase()) {
      case 'pytorch':
      case 'tensorflow':
      case 'jax':
        return this.deepLearningDefaults();
      case 'stable-baselines3':
      case 'sb3':
        return this.reinforcementLearningDefaults();
      case 'sklearn':
      case 'scikit-learn':
        return this.sklearnDefaults();
      default:
        return this.deepLearningDefaults();
    }
  }

  private static deepLearningDefaults(): ParamDefinition[] {
    return [
      { name: 'learning_rate', type: 'float', min: 1e-5, max: 1e-1, scale: 'log' },
      { name: 'batch_size', type: 'choice', values: [8, 16, 32, 64, 128, 256] },
      { name: 'weight_decay', type: 'float', min: 0, max: 0.1, scale: 'linear' },
      { name: 'dropout', type: 'float', min: 0, max: 0.5, scale: 'linear' },
      { name: 'num_epochs', type: 'int', min: 5, max: 100 },
      { name: 'optimizer', type: 'choice', values: ['adam', 'adamw', 'sgd', 'rmsprop'] },
    ];
  }

  private static reinforcementLearningDefaults(): ParamDefinition[] {
    return [
      { name: 'learning_rate', type: 'float', min: 1e-5, max: 1e-2, scale: 'log' },
      { name: 'gamma', type: 'float', min: 0.9, max: 0.999, scale: 'linear' },
      { name: 'batch_size', type: 'choice', values: [32, 64, 128, 256, 512] },
      { name: 'n_steps', type: 'choice', values: [128, 256, 512, 1024, 2048] },
      { name: 'ent_coef', type: 'float', min: 0.0, max: 0.1, scale: 'log' },
      { name: 'clip_range', type: 'float', min: 0.1, max: 0.4, scale: 'linear' },
      { name: 'gae_lambda', type: 'float', min: 0.9, max: 1.0, scale: 'linear' },
      { name: 'n_epochs', type: 'int', min: 3, max: 30 },
    ];
  }

  private static sklearnDefaults(): ParamDefinition[] {
    return [
      { name: 'n_estimators', type: 'int', min: 50, max: 500 },
      { name: 'max_depth', type: 'int', min: 3, max: 20 },
      { name: 'min_samples_split', type: 'int', min: 2, max: 20 },
      { name: 'min_samples_leaf', type: 'int', min: 1, max: 10 },
      { name: 'max_features', type: 'choice', values: ['sqrt', 'log2', 'auto'] },
    ];
  }

  static validate(params: ParamDefinition[]): string[] {
    const errors: string[] = [];

    for (const p of params) {
      if (!p.name) {
        errors.push('Parameter name is required');
      }
      if (p.type === 'float' || p.type === 'int') {
        if (p.min !== undefined && p.max !== undefined && p.min >= p.max) {
          errors.push(`${p.name}: min (${p.min}) must be less than max (${p.max})`);
        }
        if (p.scale === 'log' && p.min !== undefined && p.min <= 0) {
          errors.push(`${p.name}: log scale requires min > 0`);
        }
      }
      if (p.type === 'choice' && (!p.values || p.values.length === 0)) {
        errors.push(`${p.name}: choice type requires at least one value`);
      }
    }

    const names = params.map(p => p.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    if (duplicates.length > 0) {
      errors.push(`Duplicate parameter names: ${[...new Set(duplicates)].join(', ')}`);
    }

    return errors;
  }

  static estimateGridSize(params: ParamDefinition[], stepsPerContinuous = 5): number {
    let total = 1;
    for (const p of params) {
      if (p.type === 'choice') {
        total *= p.values?.length ?? 1;
      } else if (p.type === 'bool') {
        total *= 2;
      } else {
        total *= stepsPerContinuous;
      }
    }
    return total;
  }
}
