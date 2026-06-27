import { Paper, Author } from '../../../core/types';
import { ApiError } from '../../../core/errors';
import { httpRequest } from '../../../utils/http';
import { RateLimiter } from '../../../utils/rate-limiter';
import {
  IAcademicSource,
  AcademicSearchQuery,
  AcademicSearchResult,
} from './types';

const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1';
const S2_DOMAIN = 'semanticscholar';
const DEFAULT_MAX_RESULTS = 5;

/** Fields requested from the Semantic Scholar API. */
const PAPER_FIELDS = [
  'paperId',
  'externalIds',
  'title',
  'abstract',
  'year',
  'venue',
  'authors',
  'citationCount',
  'url',
  'openAccessPdf',
].join(',');

/**
 * Raw paper shape returned by the Semantic Scholar API.
 */
interface S2Paper {
  paperId: string;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    PMID?: string;
  };
  title: string;
  abstract?: string;
  year?: number;
  venue?: string;
  authors?: { authorId?: string; name: string }[];
  citationCount?: number;
  url?: string;
  openAccessPdf?: { url: string } | null;
}

interface S2SearchResponse {
  total: number;
  offset: number;
  next?: number;
  data: S2Paper[];
}

/**
 * Semantic Scholar API client.
 *
 * - Uses the Semantic Scholar Graph API v1 (paper/search endpoint).
 * - Supports field selection, pagination (offset/limit), and optional API key.
 * - Rate-limited per domain.
 */
export class SemanticScholarSource implements IAcademicSource {
  readonly sourceId = 'semantic_scholar' as const;

  /**
   * @param rateLimiter  Shared rate limiter instance.
   * @param apiKey       Optional Semantic Scholar API key for higher rate limits.
   */
  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly apiKey?: string,
  ) {
    // Default: ~1 req/sec for unauthenticated, but we use a safe default
    this.rateLimiter.setDomainInterval(S2_DOMAIN, 1_000);
  }

  async search(
    query: AcademicSearchQuery,
    signal?: AbortSignal,
  ): Promise<AcademicSearchResult> {
    const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS;
    const offset = query.offset ?? 0;

    const params = new URLSearchParams({
      query: query.query,
      offset: String(offset),
      limit: String(maxResults),
      fields: PAPER_FIELDS,
    });

    // Year filtering
    if (query.yearFrom !== undefined || query.yearTo !== undefined) {
      const from = query.yearFrom ?? '';
      const to = query.yearTo ?? '';
      params.set('year', `${from}-${to}`);
    }

    const url = `${S2_API_BASE}/paper/search?${params.toString()}`;

    await this.rateLimiter.acquire(S2_DOMAIN, signal);

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    const response = await httpRequest(url, { headers, signal });

    let parsed: S2SearchResponse;
    try {
      parsed = JSON.parse(response.body) as S2SearchResponse;
    } catch {
      throw new ApiError(
        'Failed to parse Semantic Scholar response',
        'semantic_scholar',
      );
    }

    const papers = (parsed.data ?? []).map((p) => this.toPaper(p));

    return {
      papers,
      totalResults: parsed.total,
      source: 'semantic_scholar',
    };
  }

  async fetchPaperDetails(
    paperId: string,
    signal?: AbortSignal,
  ): Promise<Paper | null> {
    const url = `${S2_API_BASE}/paper/${encodeURIComponent(paperId)}?fields=${PAPER_FIELDS}`;

    await this.rateLimiter.acquire(S2_DOMAIN, signal);

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    try {
      const response = await httpRequest(url, { headers, signal });

      let parsed: S2Paper;
      try {
        parsed = JSON.parse(response.body) as S2Paper;
      } catch {
        throw new ApiError(
          'Failed to parse Semantic Scholar response',
          'semantic_scholar',
        );
      }

      return this.toPaper(parsed);
    } catch (err: unknown) {
      // S2 returns 404 for unknown papers
      if (err instanceof ApiError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Convert a Semantic Scholar API paper object to the core Paper type.
   */
  private toPaper(s2: S2Paper): Paper {
    const rawAuthors = s2.authors ?? [];
    const authors: Author[] = rawAuthors.slice(0, 10).map((a) => ({
      name: a.name,
      authorId: a.authorId ?? undefined,
    }));

    const pdfUrl = s2.openAccessPdf?.url ?? undefined;

    return {
      id: `s2:${s2.paperId}`,
      externalIds: {
        semanticScholarId: s2.paperId,
        doi: s2.externalIds?.DOI ?? undefined,
        arxivId: s2.externalIds?.ArXiv ?? undefined,
        pmid: s2.externalIds?.PMID ?? undefined,
      },
      title: s2.title,
      authors,
      abstract: (s2.abstract ?? '').slice(0, 1000),
      year: s2.year ?? 0,
      venue: s2.venue ?? '',
      url: s2.url ?? `https://www.semanticscholar.org/paper/${s2.paperId}`,
      pdfUrl,
      source: 'semantic_scholar',
      citationCount: s2.citationCount,
      fetchedAt: Date.now(),
    };
  }
}
