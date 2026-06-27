import type { PipelineDefinition } from './types';
import { DEFAULT_RETRY_POLICY } from './types';

export const DEFAULT_RESEARCH_PIPELINE: PipelineDefinition = {
  id: 'default-research-loop',
  name: 'Full Research Loop',
  steps: [
    {
      id: 'perf-check',
      name: 'Machine Check',
      moduleId: 'perfcheck',
      dependsOn: [],
      config: { moduleStepId: 'check' },
    },
    {
      id: 'literature-search',
      name: 'Literature Search',
      moduleId: 'literature',
      dependsOn: ['perf-check'],
      config: { moduleStepId: 'search' },
    },
    {
      id: 'literature-analyze',
      name: 'Analyze Papers',
      moduleId: 'literature',
      dependsOn: ['literature-search'],
      config: { moduleStepId: 'analyze-papers' },
    },
    {
      id: 'code-extraction',
      name: 'Code Extraction',
      moduleId: 'code',
      dependsOn: ['literature-analyze'],
      config: { moduleStepId: 'extract' },
      optional: true,
    },
    {
      id: 'experiment-design',
      name: 'Experiment Design',
      moduleId: 'experiment',
      dependsOn: ['literature-analyze'],
      config: { moduleStepId: 'design' },
    },
    {
      id: 'experiment-codegen',
      name: 'Generate Code',
      moduleId: 'experiment',
      dependsOn: ['experiment-design', 'code-extraction'],
      config: { moduleStepId: 'generate-code' },
    },
    {
      id: 'experiment-run',
      name: 'Run Experiments',
      moduleId: 'experiment',
      dependsOn: ['experiment-design', 'experiment-codegen', 'literature-analyze'],
      config: { moduleStepId: 'run' },
    },
    {
      id: 'analysis',
      name: 'Analyze Results',
      moduleId: 'analysis',
      dependsOn: ['experiment-run'],
      config: { moduleStepId: 'analyze' },
    },
    {
      id: 'report',
      name: 'Generate Report',
      moduleId: 'report',
      dependsOn: ['analysis', 'literature-analyze'],
      config: { moduleStepId: 'generate' },
    },
  ],
  defaultRetryPolicy: DEFAULT_RETRY_POLICY,
};
