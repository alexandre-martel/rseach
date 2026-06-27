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
import type { Paper } from '../../core/types';

const METADATA: ModuleMetadata = {
  id: 'report',
  name: 'Report Generation',
  version: '0.1.0',
  description: 'Generate a structured research report from all pipeline outputs.',
  capabilities: [ModuleCapability.GENERATE],
  dependencies: ['analysis', 'literature'],
  configSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['markdown', 'latex'], default: 'markdown' },
    },
  },
};

const GENERATE_STEP: StepDefinition = {
  id: 'generate',
  name: 'Generate Report',
  description: 'Generate a structured research report from analysis results and literature.',
  inputs: ['analysisResults', 'analyzedPapers', 'experimentResults', 'insights'],
  outputs: ['report'],
};

interface ExperimentResult {
  name?: string;
  hyperparameters?: Record<string, unknown>;
  metrics?: Record<string, number>;
  observations?: string;
  status?: string;
}

export class ReportModule implements IResearchModule {
  readonly metadata: ModuleMetadata = METADATA;

  getAvailableSteps(): StepDefinition[] {
    return [GENERATE_STEP];
  }

  async executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    switch (stepId) {
      case 'generate':
        return this.generateReport(input, context);
      default:
        throw new PipelineError(`Unknown step "${stepId}" in report module`, stepId);
    }
  }

  private async generateReport(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const analysis = (input.data.analysisResults as Record<string, unknown>) ?? {};
    const papers = (input.data.analyzedPapers as Paper[]) ?? [];
    const experimentResults = (input.data.experimentResults as ExperimentResult[]) ?? [];
    const researchQuestion = (input.data.researchQuestion as string) ?? '';

    const paperCitations = papers
      .slice(0, 10)
      .map((p) => `- "${p.title}" (${p.year ?? 'n.d.'})`)
      .join('\n');

    // Build experiment summary with clear improvement markers
    let bestMetric = '';
    let bestValue = -Infinity;
    if (experimentResults.length > 0) {
      const firstMetrics = experimentResults[0]?.metrics ?? {};
      bestMetric = Object.keys(firstMetrics)[0] ?? '';
    }
    const experimentSummary = experimentResults.map((exp, i) => {
      const val = exp.metrics?.[bestMetric] ?? 0;
      const prevVal = i > 0 ? (experimentResults[i - 1].metrics?.[bestMetric] ?? 0) : 0;
      const improved = i === 0 || val > prevVal;
      const isBest = val > bestValue;
      if (isBest) { bestValue = val; }
      const marker = isBest ? '★ NEW BEST' : improved ? '✓ improved' : '✗ no improvement';
      const params = Object.entries(exp.hyperparameters ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
      const metrics = Object.entries(exp.metrics ?? {}).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`).join(', ');
      return `#${i + 1} "${exp.name}" [${marker}] — params: {${params}} — results: {${metrics}}`;
    }).join('\n');

    const response = await context.llm.complete(
      [
        {
          role: 'user',
          content: `Generate a SHORT, focused research report in Markdown. Only answer what was asked. No filler, no generic introductions, no padding.

Research question: ${researchQuestion}

Key findings: ${(analysis.keyFindings as string[] ?? []).join('; ') || 'none'}
Recommendations: ${(analysis.recommendations as string[] ?? []).join('; ') || 'none'}

Experiments (★ = best result, ✓ = improved, ✗ = no improvement):
${experimentSummary || 'No experiments conducted'}

References: ${paperCitations || 'none'}

Generate ONLY these 3 sections:

## Answer
Direct answer to the research question based on results. 2-3 sentences max.

## Experiments
A clear table or list of ALL experiments tried. For each one:
- Its name and number
- What hyperparameters were changed
- The metric results
- **Clearly mark with ★ which experiments IMPROVED the results** and which did not (✗)
- Make it visually obvious which experiment was the best overall

## References
Short list of papers consulted.

Keep it under 500 words total. No methodology section, no introduction, no future work unless specifically asked.`,
        },
      ],
      { temperature: 0.3 },
    );

    return {
      data: {
        report: {
          content: response.content,
          format: 'markdown',
          generatedAt: Date.now(),
          paperCount: papers.length,
          experimentCount: experimentResults.length,
        },
      },
      artifacts: [
        {
          id: `report-${Date.now()}`,
          type: 'file',
          name: 'research-report.md',
          path: '',
          mimeType: 'text/markdown',
          size: response.content.length,
          createdAt: Date.now(),
        },
      ],
      summary: `Generated research report (${papers.length} papers, ${experimentResults.length} experiments)`,
      metrics: {
        reportLength: response.content.length,
        papersReferenced: papers.length,
        experimentsIncluded: experimentResults.length,
      },
    };
  }
}
