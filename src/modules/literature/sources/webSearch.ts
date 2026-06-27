import { Paper } from '../../../core/types';
import { httpRequest } from '../../../utils/http';
import { RateLimiter } from '../../../utils/rate-limiter';
import {
  IAcademicSource,
  AcademicSearchQuery,
  AcademicSearchResult,
} from './types';

const DDG_URL = 'https://html.duckduckgo.com/html/';
const DDG_DOMAIN = 'duckduckgo';

/**
 * Web search source using DuckDuckGo — no API key required.
 *
 * Searches the public web for tutorials, blog posts, documentation,
 * and Stack Overflow answers that complement academic paper results.
 */
export class WebSearchSource implements IAcademicSource {
  readonly sourceId = 'web' as const;

  constructor(private readonly rateLimiter: RateLimiter) {
    this.rateLimiter.setDomainInterval(DDG_DOMAIN, 2_000);
  }

  async search(
    query: AcademicSearchQuery,
    signal?: AbortSignal,
  ): Promise<AcademicSearchResult> {
    const maxResults = query.maxResults ?? 5;

    await this.rateLimiter.acquire(DDG_DOMAIN, signal);

    const response = await httpRequest(DDG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(query.query)}&kl=us-en`,
      signal,
    });

    const papers = this.parseResults(response.body, maxResults);

    return {
      papers,
      totalResults: papers.length,
      source: 'web',
    };
  }

  async fetchPaperDetails(
    _id: string,
    _signal?: AbortSignal,
  ): Promise<Paper | null> {
    return null;
  }

  private parseResults(html: string, max: number): Paper[] {
    const papers: Paper[] = [];
    const now = Date.now();
    const year = new Date().getFullYear();

    // DuckDuckGo HTML results have this structure:
    //   <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL&...">Title</a>
    //   <a class="result__snippet" href="...">Snippet text</a>
    const resultBlocks = html.split(/class="result\s/g);

    for (const block of resultBlocks.slice(1)) {
      if (papers.length >= max) { break; }

      const titleMatch = block.match(
        /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
      );
      const snippetMatch = block.match(
        /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
      );

      if (!titleMatch) { continue; }

      const rawHref = titleMatch[1];
      const title = this.stripHtml(titleMatch[2]).trim();
      const snippet = snippetMatch
        ? this.stripHtml(snippetMatch[1]).trim()
        : '';

      if (!title) { continue; }

      const url = this.extractUrl(rawHref);
      if (!url) { continue; }

      const domain = this.extractDomain(url);

      papers.push({
        id: `web:${Buffer.from(url).toString('base64url').slice(0, 40)}`,
        externalIds: {},
        title,
        authors: [{ name: domain }],
        abstract: snippet,
        year,
        venue: domain,
        url,
        source: 'web',
        fetchedAt: now,
      });
    }

    return papers;
  }

  private extractUrl(ddgHref: string): string | null {
    // DDG wraps URLs: //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&...
    const uddgMatch = ddgHref.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        return decodeURIComponent(uddgMatch[1]);
      } catch {
        return null;
      }
    }
    // Direct URL (no redirect wrapper)
    if (ddgHref.startsWith('http')) { return ddgHref; }
    if (ddgHref.startsWith('//')) { return `https:${ddgHref}`; }
    return null;
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'web';
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
  }
}
