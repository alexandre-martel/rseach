import { PipelineError } from '../../core/errors';
import {
  IResearchModule,
  ModuleMetadata,
  ModuleCapability,
  ModuleContext,
  StepDefinition,
  StepInput,
  StepOutput,
} from '../types';

const METADATA: ModuleMetadata = {
  id: 'analysis',
  name: 'Results Analysis',
  version: '0.1.0',
  description: 'Analyze experiment results, compute statistics, and identify patterns.',
  capabilities: [ModuleCapability.ANALYZE, ModuleCapability.VISUALIZE],
  dependencies: ['experiment'],
  configSchema: {},
};

const ANALYZE_STEP: StepDefinition = {
  id: 'analyze',
  name: 'Analyze Results',
  description: 'Use LLM to analyze experiment results and extract insights.',
  inputs: ['experimentResults', 'experimentDesigns', 'analyzedPapers'],
  outputs: ['analysisResults', 'insights'],
};

export class AnalysisModule implements IResearchModule {
  readonly metadata: ModuleMetadata = METADATA;

  getAvailableSteps(): StepDefinition[] {
    return [ANALYZE_STEP];
  }

  async executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    switch (stepId) {
      case 'analyze':
        return this.analyze(input, context);
      default:
        throw new PipelineError(`Unknown step "${stepId}" in analysis module`, stepId);
    }
  }

  private async analyze(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const experimentResults = (input.data.experimentResults as unknown[]) ?? [];
    const experimentDesigns = (input.data.experimentDesigns as unknown[]) ?? [];
    const papers = (input.data.analyzedPapers as unknown[]) ?? [];

    const response = await context.llm.complete(
      [
        {
          role: 'user',
          content: `Analyze the following research results and provide insights. This is part of an iterative research loop — experiments may have been run with limited literature, and that's expected. Focus on what was learned and what to explore next.\n\nExperiment designs: ${JSON.stringify(experimentDesigns, null, 2)}\n\nExperiment results: ${JSON.stringify(experimentResults, null, 2)}\n\nNumber of papers analyzed: ${papers.length}\n\nProvide:\n1. A summary of key findings from the experiments\n2. Patterns identified across experiments\n3. Comparison with existing literature (if papers were available)\n4. Limitations and potential issues\n5. Recommendations for next steps\n6. Suggested new literature searches based on what the experiments revealed (specific topics, methods, or phenomena worth investigating further)\n\nRespond in JSON: { "summary": string, "keyFindings": string[], "patterns": string[], "limitations": string[], "recommendations": string[], "suggestedSearches": string[] }`,
        },
      ],
      { temperature: 0.4, responseFormat: 'json' },
    );

    let analysisResults: Record<string, unknown> = {};
    try {
      analysisResults = JSON.parse(response.content);
    } catch {
      analysisResults = {
        summary: response.content,
        keyFindings: [],
        patterns: [],
        limitations: [],
        recommendations: [],
      };
    }

    const insights = [
      ...((analysisResults.keyFindings as string[]) ?? []),
      ...((analysisResults.patterns as string[]) ?? []),
    ];

    return {
      data: {
        analysisResults,
        insights,
        analyzedPapers: papers,
      },
      artifacts: [],
      summary: `Analysis complete: ${insights.length} insights found`,
      metrics: {
        insightsFound: insights.length,
        experimentsAnalyzed: experimentResults.length,
      },
    };
  }
}
