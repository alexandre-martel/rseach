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

export interface CustomSourceConfig {
  id: string;
  name: string;
  url: string;
}

export class CustomSource implements IAcademicSource {
  readonly sourceId = 'web' as const;
  private readonly domain: string;

  constructor(
    private readonly config: CustomSourceConfig,
    private readonly rateLimiter: RateLimiter,
  ) {
    this.domain = this.extractDomain(config.url);
    this.rateLimiter.setDomainInterval(DDG_DOMAIN, 2_000);
  }

  async search(
    query: AcademicSearchQuery,
    signal?: AbortSignal,
  ): Promise<AcademicSearchResult> {
    const maxResults = query.maxResults ?? 5;
    const scopedQuery = `site:${this.domain} ${query.query}`;

    await this.rateLimiter.acquire(DDG_DOMAIN, signal);

    const response = await httpRequest(DDG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(scopedQuery)}&kl=us-en`,
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

      papers.push({
        id: `custom:${this.config.id}:${Buffer.from(url).toString('base64url').slice(0, 40)}`,
        externalIds: {},
        title,
        authors: [{ name: this.config.name }],
        abstract: snippet,
        year,
        venue: this.config.name,
        url,
        source: 'web',
        fetchedAt: now,
      });
    }

    return papers;
  }

  private extractUrl(ddgHref: string): string | null {
    const uddgMatch = ddgHref.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        return decodeURIComponent(uddgMatch[1]);
      } catch {
        return null;
      }
    }
    if (ddgHref.startsWith('http')) { return ddgHref; }
    if (ddgHref.startsWith('//')) { return `https:${ddgHref}`; }
    return null;
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
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
