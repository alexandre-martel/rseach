import { Paper, Author } from '../../../core/types';
import { ApiError } from '../../../core/errors';
import { httpRequest } from '../../../utils/http';
import { parseAtomFeed, AtomEntry, AtomLink } from '../../../utils/xml';
import { RateLimiter } from '../../../utils/rate-limiter';
import {
  IAcademicSource,
  AcademicSearchQuery,
  AcademicSearchResult,
} from './types';

const ARXIV_API_URL = 'http://export.arxiv.org/api/query';
const ARXIV_DOMAIN = 'arxiv';
const DEFAULT_MAX_RESULTS = 5;

/**
 * arXiv API client.
 *
 * - Uses the arXiv Atom feed API (http://export.arxiv.org/api/query).
 * - Parses Atom XML responses via fast-xml-parser.
 * - Supports category filtering (cs.LG, cs.RO, etc.).
 * - Rate-limited: 1 request per 3 seconds.
 * - Constructs PDF URLs from arXiv IDs.
 */
export class ArxivSource implements IAcademicSource {
  readonly sourceId = 'arxiv' as const;

  constructor(private readonly rateLimiter: RateLimiter) {
    // Ensure arXiv rate limit is at least 3 seconds
    this.rateLimiter.setDomainInterval(ARXIV_DOMAIN, 3_000);
  }

  async search(
    query: AcademicSearchQuery,
    signal?: AbortSignal,
  ): Promise<AcademicSearchResult> {
    const searchQuery = this.buildSearchQuery(query);
    const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS;
    const offset = query.offset ?? 0;

    const params = new URLSearchParams({
      search_query: searchQuery,
      start: String(offset),
      max_results: String(maxResults),
      sortBy: query.sortBy === 'date' ? 'submittedDate' : 'relevance',
      sortOrder: 'descending',
    });

    const url = `${ARXIV_API_URL}?${params.toString()}`;

    await this.rateLimiter.acquire(ARXIV_DOMAIN, signal);

    const response = await httpRequest(url, { signal });
    const feed = parseAtomFeed(response.body);

    const totalResults = parseInt(
      feed['opensearch:totalResults'] ?? '0',
      10,
    );

    const entries = feed.entry ?? [];
    const papers = entries.map((entry) => this.entryToPaper(entry));

    return {
      papers,
      totalResults,
      source: 'arxiv',
    };
  }

  async fetchPaperDetails(
    arxivId: string,
    signal?: AbortSignal,
  ): Promise<Paper | null> {
    const url = `${ARXIV_API_URL}?id_list=${encodeURIComponent(arxivId)}`;

    await this.rateLimiter.acquire(ARXIV_DOMAIN, signal);

    const response = await httpRequest(url, { signal });
    const feed = parseAtomFeed(response.body);

    const entries = feed.entry ?? [];
    if (entries.length === 0) {
      return null;
    }

    return this.entryToPaper(entries[0]);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build an arXiv search_query string from structured query parameters.
   *
   * Examples of the resulting query:
   *   all:reinforcement+learning+AND+(cat:cs.LG+OR+cat:cs.RO)
   */
  private buildSearchQuery(query: AcademicSearchQuery): string {
    const parts: string[] = [];

    // Replace spaces with + so the all: prefix applies to every term,
    // not just the first word. Without this, arXiv parses
    // "all:random forest" as (all:random) AND (forest) — matching physics.
    const sanitized = query.query.replace(/\s+/g, '+');
    parts.push(`all:${sanitized}`);

    // Category filters
    if (query.categories && query.categories.length > 0) {
      const catClauses = query.categories.map((cat) => `cat:${cat}`);
      if (catClauses.length === 1) {
        parts.push(`AND+${catClauses[0]}`);
      } else {
        parts.push(`AND+(${catClauses.join('+OR+')})`);
      }
    }

    return parts.join('+');
  }

  /**
   * Convert an Atom feed entry to the Paper type used across the codebase.
   */
  private entryToPaper(entry: AtomEntry): Paper {
    const arxivId = this.extractArxivId(entry.id);
    const pdfUrl = this.buildPdfUrl(arxivId);
    const absUrl = `https://arxiv.org/abs/${arxivId}`;
    const doi = entry['arxiv:doi'] ?? undefined;

    const rawAuthors = entry.author ?? [];
    const authors: Author[] = rawAuthors.slice(0, 10).map((a) => ({
      name: a.name,
      affiliations: a['arxiv:affiliation']
        ? [a['arxiv:affiliation']]
        : undefined,
    }));

    const year = new Date(entry.published).getFullYear();

    // Determine venue from journal ref or primary category
    const venue =
      entry['arxiv:journal_ref'] ??
      entry['arxiv:primary_category']?.['@_term'] ??
      'arXiv';

    return {
      id: `arxiv:${arxivId}`,
      externalIds: {
        arxivId,
        doi,
      },
      title: this.cleanText(entry.title),
      authors,
      abstract: this.cleanText(entry.summary).slice(0, 1000),
      year,
      venue,
      url: absUrl,
      pdfUrl,
      source: 'arxiv',
      fetchedAt: Date.now(),
    };
  }

  /**
   * Extract the arXiv ID from a full Atom entry ID URL.
   * Example: "http://arxiv.org/abs/2301.12345v2" -> "2301.12345v2"
   */
  private extractArxivId(entryId: string): string {
    const match = entryId.match(/abs\/(.+)$/);
    return match ? match[1] : entryId;
  }

  /**
   * Build the PDF URL from an arXiv ID.
   * Example: "2301.12345v2" -> "https://arxiv.org/pdf/2301.12345v2"
   */
  private buildPdfUrl(arxivId: string): string {
    return `https://arxiv.org/pdf/${arxivId}`;
  }

  /**
   * Clean up text from Atom entries: collapse whitespace, trim.
   */
  private cleanText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
}
