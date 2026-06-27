import { Paper } from '../../core/types';
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
import { RateLimiter } from '../../utils/rate-limiter';
import { IAcademicSource, AcademicSearchQuery } from './sources/types';
import { ArxivSource } from './sources/arxiv';
import { SemanticScholarSource } from './sources/semanticScholar';
import { WebSearchSource } from './sources/webSearch';
import { PaperAnalyzer } from './analyzer';
import { PaperDeduplicator } from './deduplicator';

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

const SEARCH_STEP: StepDefinition = {
  id: 'search',
  name: 'Search Academic Sources',
  description:
    'Search across configured academic sources (arXiv, Semantic Scholar) for papers matching the research question.',
  inputs: ['query', 'categories', 'maxResults'],
  outputs: ['papers', 'totalResults'],
};

const ANALYZE_STEP: StepDefinition = {
  id: 'analyze-papers',
  name: 'Analyze Papers',
  description:
    'Analyze found papers with an LLM to extract summaries, methods, hyperparameters, and relevance scores.',
  inputs: ['papers', 'researchQuestion'],
  outputs: ['analyzedPapers'],
};

// ---------------------------------------------------------------------------
// Module metadata
// ---------------------------------------------------------------------------

const METADATA: ModuleMetadata = {
  id: 'literature',
  name: 'Literature Research',
  version: '0.1.0',
  description:
    'Search academic sources, deduplicate results, and analyze papers using an LLM.',
  capabilities: [
    ModuleCapability.SEARCH,
    ModuleCapability.ANALYZE,
    ModuleCapability.EXTRACT,
  ],
  dependencies: [],
  configSchema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['arxiv', 'semanticScholar', 'webSearch'] },
        default: ['arxiv', 'semanticScholar', 'webSearch'],
      },
      maxPapers: { type: 'number', default: 5 },
      categories: {
        type: 'array',
        items: { type: 'string' },
        default: ['cs.LG', 'cs.RO', 'cs.AI', 'stat.ML'],
      },
      semanticScholarApiKey: { type: 'string', default: '' },
    },
  },
};

// ---------------------------------------------------------------------------
// LiteratureModule
// ---------------------------------------------------------------------------

/**
 * Literature research module implementing IResearchModule.
 *
 * Steps:
 * - "search" : Search across configured academic sources.
 * - "analyze-papers" : Analyze found papers with an LLM.
 */
export class LiteratureModule implements IResearchModule {
  readonly metadata: ModuleMetadata = METADATA;

  private readonly rateLimiter = new RateLimiter();
  private readonly deduplicator = new PaperDeduplicator();

  getAvailableSteps(): StepDefinition[] {
    return [SEARCH_STEP, ANALYZE_STEP];
  }

  async executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    switch (stepId) {
      case 'search':
        return this.executeSearch(input, context);
      case 'analyze-papers':
        return this.executeAnalyze(input, context);
      default:
        throw new PipelineError(
          `Unknown step "${stepId}" in literature module`,
          stepId,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Step: search
  // -----------------------------------------------------------------------

  private async executeSearch(
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    const query = (input.data.query as string) ?? '';
    const categories = (input.data.categories as string[]) ?? [];
    const maxResults = (input.data.maxResults as number) ?? 5;

    if (!query) {
      throw new PipelineError('Search query is required', 'search');
    }

    const sources = this.buildSources(context.config);

    // Split maxResults: half for academic archives, half for web
    const archiveSources = sources.filter((s) => s.sourceId !== 'web');
    const webSources = sources.filter((s) => s.sourceId === 'web');
    const archiveMax = webSources.length > 0
      ? Math.ceil(maxResults / 2)
      : maxResults;
    const webMax = webSources.length > 0
      ? Math.floor(maxResults / 2)
      : 0;

    // Search all sources in parallel
    const searchPromises = sources.map(async (source) => {
      const perSourceMax = source.sourceId === 'web' ? webMax : archiveMax;
      const searchQuery: AcademicSearchQuery = {
        query,
        maxResults: perSourceMax,
        categories: source.sourceId === 'web'
          ? undefined
          : categories.length > 0 ? categories : undefined,
      };
      try {
        return await source.search(searchQuery, context.signal);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        console.warn(
          `[literature] ${source.sourceId} search failed: ${message}`,
        );
        return { papers: [], totalResults: 0, source: source.sourceId };
      }
    });

    const results = await Promise.all(searchPromises);

    // Flatten and deduplicate
    const allPapers = results.flatMap((r) => r.papers);
    const deduplicated = this.deduplicator.deduplicate(allPapers);
    const totalResults = results.reduce(
      (sum, r) => sum + r.totalResults,
      0,
    );

    return {
      data: {
        papers: deduplicated,
        totalResults,
        sourcesSearched: sources.map((s) => s.sourceId),
      },
      artifacts: [],
      summary: `Found ${deduplicated.length} unique papers (${totalResults} total across ${sources.length} sources)`,
      metrics: {
        papersFound: deduplicated.length,
        totalResults,
        sourcesSearched: sources.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Step: analyze-papers
  // -----------------------------------------------------------------------

  private async executeAnalyze(
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    const papers = (input.data.papers as Paper[]) ?? [];
    const researchQuestion =
      (input.data.researchQuestion as string) ?? '';

    if (papers.length === 0) {
      return {
        data: { analyzedPapers: [] },
        artifacts: [],
        summary: 'No papers to analyze',
        metrics: { analyzed: 0 },
      };
    }

    if (!researchQuestion) {
      throw new PipelineError(
        'Research question is required for paper analysis',
        'analyze-papers',
      );
    }

    const analyzer = new PaperAnalyzer(context.llm);
    const analyzed: Paper[] = [];

    for (const paper of papers) {
      // Check for cancellation between each analysis
      if (context.signal.aborted) {
        break;
      }

      try {
        const analysis = await analyzer.analyze(
          paper,
          researchQuestion,
          context.signal,
        );

        analyzed.push({
          ...paper,
          summary: analysis.summary,
          methods: analysis.methods,
          hyperparameters: analysis.hyperparameters,
          keyFindings: analysis.keyFindings,
          relevanceScore: analysis.relevanceScore,
          analyzedAt: Date.now(),
        });
      } catch (err: unknown) {
        // If analysis fails for one paper, keep the original unanalyzed
        const message =
          err instanceof Error ? err.message : String(err);
        console.warn(
          `[literature] Analysis failed for "${paper.title}": ${message}`,
        );
        analyzed.push(paper);
      }
    }

    // Sort by relevance score (highest first)
    analyzed.sort(
      (a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0),
    );

    const analyzedCount = analyzed.filter((p) => p.analyzedAt).length;

    return {
      data: { analyzedPapers: analyzed },
      artifacts: [],
      summary: `Analyzed ${analyzedCount}/${papers.length} papers`,
      metrics: {
        analyzed: analyzedCount,
        total: papers.length,
        averageRelevance:
          analyzedCount > 0
            ? analyzed.reduce(
                (sum, p) => sum + (p.relevanceScore ?? 0),
                0,
              ) / analyzedCount
            : 0,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Source construction
  // -----------------------------------------------------------------------

  /**
   * Build the list of academic sources from the module configuration.
   */
  private buildSources(config: Record<string, unknown>): IAcademicSource[] {
    const enabledSources = (config.sources as string[]) ?? [
      'arxiv',
      'semanticScholar',
    ];
    const s2ApiKey = (config.semanticScholarApiKey as string) || undefined;

    const sources: IAcademicSource[] = [];

    for (const sourceId of enabledSources) {
      switch (sourceId) {
        case 'arxiv':
          sources.push(new ArxivSource(this.rateLimiter));
          break;
        case 'semanticScholar':
          sources.push(
            new SemanticScholarSource(this.rateLimiter, s2ApiKey),
          );
          break;
        case 'webSearch':
          sources.push(new WebSearchSource(this.rateLimiter));
          break;
        default:
          console.warn(
            `[literature] Unknown source "${sourceId}", skipping`,
          );
      }
    }

    return sources;
  }
}
