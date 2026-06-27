import { Paper } from '../../../core/types';

/**
 * Query parameters for searching academic sources.
 */
export interface AcademicSearchQuery {
  /** Free-text search query (title, abstract, keywords). */
  query: string;

  /** Maximum number of results to return. */
  maxResults?: number;

  /** Pagination offset (0-based). */
  offset?: number;

  /** arXiv category filters (e.g. "cs.LG", "cs.RO"). */
  categories?: string[];

  /** Filter papers published on or after this year. */
  yearFrom?: number;

  /** Filter papers published on or before this year. */
  yearTo?: number;

  /** Sort order for results. */
  sortBy?: 'relevance' | 'date' | 'citations';
}

/**
 * A page of search results from an academic source.
 */
export interface AcademicSearchResult {
  /** Papers matching the query on this page. */
  papers: Paper[];

  /** Total number of results available (may exceed papers.length). */
  totalResults: number;

  /** The source that produced these results. */
  source: Paper['source'];
}

/**
 * Interface for academic paper sources (arXiv, Semantic Scholar, etc.).
 */
export interface IAcademicSource {
  /** Unique identifier for this source (matches Paper.source). */
  readonly sourceId: Paper['source'];

  /**
   * Search for papers matching the given query.
   */
  search(
    query: AcademicSearchQuery,
    signal?: AbortSignal,
  ): Promise<AcademicSearchResult>;

  /**
   * Fetch full details for a single paper by its source-specific ID.
   *
   * @param id - The source-specific identifier (e.g. arXiv ID, S2 paper ID).
   * @returns The paper, or null if not found.
   */
  fetchPaperDetails(
    id: string,
    signal?: AbortSignal,
  ): Promise<Paper | null>;
}
