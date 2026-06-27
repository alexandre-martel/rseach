import { Paper, ExtractedMethod, ExtractedHyperparameter } from '../../core/types';
import { ILLMService } from '../types';

/**
 * Result of analysing a single paper with the LLM.
 */
export interface PaperAnalysis {
  summary: string;
  methods: ExtractedMethod[];
  hyperparameters: ExtractedHyperparameter[];
  keyFindings: string[];
  relevanceScore: number;
}

/**
 * Analyses academic papers using an LLM via the ILLMService interface.
 *
 * Capabilities:
 * - Summarise a paper's abstract / key contributions.
 * - Extract methods and hyperparameters mentioned in the abstract.
 * - Score relevance to the user's research question.
 */
export class PaperAnalyzer {
  constructor(private readonly llm: ILLMService) {}

  /**
   * Run a full analysis of a paper against a research question.
   */
  async analyze(
    paper: Paper,
    researchQuestion: string,
    signal?: AbortSignal,
  ): Promise<PaperAnalysis> {
    const prompt = this.buildAnalysisPrompt(paper, researchQuestion);

    const response = await this.llm.complete(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, responseFormat: 'json' },
    );

    return this.parseAnalysisResponse(response.content);
  }

  /**
   * Summarise a single paper (lighter-weight than full analysis).
   */
  async summarize(paper: Paper): Promise<string> {
    const prompt = [
      'Provide a concise 2-3 sentence summary of the following paper.',
      '',
      `Title: ${paper.title}`,
      `Authors: ${paper.authors.map((a) => a.name).join(', ')}`,
      `Year: ${paper.year}`,
      `Abstract: ${paper.abstract}`,
    ].join('\n');

    const response = await this.llm.complete(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, maxTokens: 300 },
    );

    return response.content.trim();
  }

  /**
   * Score how relevant a paper is to a research question (0-1).
   */
  async scoreRelevance(
    paper: Paper,
    researchQuestion: string,
  ): Promise<number> {
    const prompt = [
      'Rate the relevance of the following paper to the research question on a scale from 0.0 to 1.0.',
      'Respond with ONLY a number between 0.0 and 1.0.',
      '',
      `Research question: ${researchQuestion}`,
      '',
      `Paper title: ${paper.title}`,
      `Abstract: ${paper.abstract}`,
    ].join('\n');

    const response = await this.llm.complete(
      [{ role: 'user', content: prompt }],
      { temperature: 0, maxTokens: 10 },
    );

    const score = parseFloat(response.content.trim());
    if (isNaN(score)) {
      return 0;
    }
    return Math.max(0, Math.min(1, score));
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildAnalysisPrompt(
    paper: Paper,
    researchQuestion: string,
  ): string {
    return [
      'Analyze the following academic paper in the context of a research question.',
      'Return your analysis as a JSON object with these fields:',
      '  - summary (string): A concise 2-3 sentence summary of the paper.',
      '  - methods (array of {name, description, category, paperSection}): Methods described in the paper.',
      '  - hyperparameters (array of {name, value, context, paperSection}): Hyperparameters or key numerical settings.',
      '  - keyFindings (array of strings): The main findings or contributions.',
      '  - relevanceScore (number 0.0-1.0): How relevant this paper is to the research question.',
      '',
      `Research question: ${researchQuestion}`,
      '',
      `Title: ${paper.title}`,
      `Authors: ${paper.authors.map((a) => a.name).join(', ')}`,
      `Year: ${paper.year}`,
      `Venue: ${paper.venue}`,
      `Abstract: ${paper.abstract}`,
      '',
      'Respond with ONLY the JSON object, no other text.',
    ].join('\n');
  }

  private parseAnalysisResponse(raw: string): PaperAnalysis {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        methods: Array.isArray(parsed.methods)
          ? (parsed.methods as ExtractedMethod[])
          : [],
        hyperparameters: Array.isArray(parsed.hyperparameters)
          ? (parsed.hyperparameters as ExtractedHyperparameter[])
          : [],
        keyFindings: Array.isArray(parsed.keyFindings)
          ? (parsed.keyFindings as string[])
          : [],
        relevanceScore:
          typeof parsed.relevanceScore === 'number'
            ? Math.max(0, Math.min(1, parsed.relevanceScore))
            : 0,
      };
    } catch {
      // If the LLM returned non-JSON, fall back to a minimal analysis
      return {
        summary: cleaned.slice(0, 500),
        methods: [],
        hyperparameters: [],
        keyFindings: [],
        relevanceScore: 0,
      };
    }
  }
}
