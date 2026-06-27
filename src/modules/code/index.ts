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
  id: 'code',
  name: 'Code Extraction',
  version: '0.1.0',
  description: 'Find and extract relevant code repositories and snippets from analyzed papers.',
  capabilities: [ModuleCapability.SEARCH, ModuleCapability.EXTRACT],
  dependencies: ['literature'],
  configSchema: {},
};

const EXTRACT_STEP: StepDefinition = {
  id: 'extract',
  name: 'Extract Code References',
  description: 'Use LLM to identify code repositories, snippets, and implementation details from papers.',
  inputs: ['analyzedPapers'],
  outputs: ['codeReferences'],
};

export class CodeModule implements IResearchModule {
  readonly metadata: ModuleMetadata = METADATA;

  getAvailableSteps(): StepDefinition[] {
    return [EXTRACT_STEP];
  }

  async executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    switch (stepId) {
      case 'extract':
        return this.extractCode(input, context);
      default:
        throw new PipelineError(`Unknown step "${stepId}" in code module`, stepId);
    }
  }

  private async extractCode(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const papers = (input.data.analyzedPapers as Paper[]) ?? (input.data.papers as Paper[]) ?? [];

    if (papers.length === 0) {
      return {
        data: { codeReferences: [] },
        artifacts: [],
        summary: 'No papers to extract code from',
        metrics: { extracted: 0 },
      };
    }

    const paperSummaries = papers
      .slice(0, 10)
      .map((p, i) => `${i + 1}. "${p.title}" - ${p.summary ?? p.abstract ?? 'No summary'}`)
      .join('\n');

    const response = await context.llm.complete(
      [
        {
          role: 'user',
          content: `Given these research papers, identify any referenced code repositories (GitHub links, code snippets, frameworks used, implementation details). For each paper, extract:\n- Repository URLs (if mentioned)\n- Key libraries/frameworks\n- Implementation language\n- Notable algorithms or techniques\n\nPapers:\n${paperSummaries}\n\nRespond in JSON: { "codeReferences": [{ "paperTitle": string, "repos": string[], "libraries": string[], "language": string, "techniques": string[] }] }`,
        },
      ],
      { temperature: 0.3, responseFormat: 'json' },
    );

    let codeReferences: unknown[] = [];
    try {
      const parsed = JSON.parse(response.content);
      codeReferences = parsed.codeReferences ?? [];
    } catch {
      codeReferences = [];
    }

    return {
      data: { codeReferences },
      artifacts: [],
      summary: `Extracted code references from ${papers.length} papers`,
      metrics: { extracted: codeReferences.length, papersProcessed: papers.length },
    };
  }
}
