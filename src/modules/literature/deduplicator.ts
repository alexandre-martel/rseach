import { Paper } from '../../core/types';

/**
 * Cross-source paper deduplicator.
 *
 * Deduplication strategy (in priority order):
 * 1. Exact DOI match -- highest confidence.
 * 2. Title similarity -- case-insensitive, punctuation-stripped comparison.
 *
 * When duplicates are found the paper with more metadata (citation count,
 * abstract length, external IDs) is kept.
 */
export class PaperDeduplicator {
  /**
   * Deduplicate an array of papers from potentially multiple sources.
   *
   * @returns A new array with duplicates removed.
   */
  deduplicate(papers: Paper[]): Paper[] {
    // Maps for fast duplicate lookup
    const byDoi = new Map<string, number>(); // DOI -> index in result
    const byNormTitle = new Map<string, number>(); // normalised title -> index in result
    const result: Paper[] = [];

    for (const paper of papers) {
      const doi = paper.externalIds.doi?.toLowerCase();
      const normTitle = this.normalizeTitle(paper.title);

      // 1. Check DOI match
      if (doi) {
        const existingIdx = byDoi.get(doi);
        if (existingIdx !== undefined) {
          // Keep the richer record
          if (this.preferNew(result[existingIdx], paper)) {
            result[existingIdx] = this.merge(result[existingIdx], paper);
          }
          continue;
        }
      }

      // 2. Check normalised title match
      if (normTitle) {
        const existingIdx = byNormTitle.get(normTitle);
        if (existingIdx !== undefined) {
          if (this.preferNew(result[existingIdx], paper)) {
            result[existingIdx] = this.merge(result[existingIdx], paper);
          }
          continue;
        }
      }

      // No duplicate found -- add to results
      const idx = result.length;
      result.push(paper);

      if (doi) {
        byDoi.set(doi, idx);
      }
      if (normTitle) {
        byNormTitle.set(normTitle, idx);
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Normalise a title for comparison: lowercase, strip punctuation, collapse whitespace.
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Determine whether `candidate` has richer metadata than `existing`.
   */
  private preferNew(existing: Paper, candidate: Paper): boolean {
    return this.richness(candidate) > this.richness(existing);
  }

  /**
   * Heuristic score for how much metadata a paper record contains.
   */
  private richness(paper: Paper): number {
    let score = 0;
    if (paper.abstract.length > 0) score += 1;
    if (paper.citationCount !== undefined) score += 1;
    if (paper.externalIds.doi) score += 1;
    if (paper.externalIds.arxivId) score += 1;
    if (paper.externalIds.semanticScholarId) score += 1;
    if (paper.pdfUrl) score += 1;
    if (paper.authors.length > 0) score += 1;
    return score;
  }

  /**
   * Merge external IDs and optional fields from `source` into `target`,
   * returning a new Paper object.
   */
  private merge(target: Paper, source: Paper): Paper {
    return {
      ...source,
      externalIds: {
        doi: source.externalIds.doi ?? target.externalIds.doi,
        arxivId: source.externalIds.arxivId ?? target.externalIds.arxivId,
        pmid: source.externalIds.pmid ?? target.externalIds.pmid,
        semanticScholarId:
          source.externalIds.semanticScholarId ??
          target.externalIds.semanticScholarId,
      },
      citationCount: source.citationCount ?? target.citationCount,
      pdfUrl: source.pdfUrl ?? target.pdfUrl,
      codeRepos: [
        ...new Set([
          ...(source.codeRepos ?? []),
          ...(target.codeRepos ?? []),
        ]),
      ],
    };
  }
}
