import { XMLParser } from 'fast-xml-parser';

/**
 * Pre-configured XML parser for Atom feeds (used by the arXiv API).
 *
 * Configuration:
 * - Preserves attribute names with an `@_` prefix.
 * - Trims whitespace from text nodes.
 * - Parses tag values (numbers, booleans) as strings to avoid accidental coercion.
 * - Handles array-ambiguous elements via `isArray` so that single-item results
 *   still return an array for `entry`, `author`, and `link`.
 */
const atomParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  isArray: (_name: string, jpath: string) => {
    // Ensure these paths always produce arrays even when there is only one element
    const arrayPaths = [
      'feed.entry',
      'feed.entry.author',
      'feed.entry.link',
      'feed.entry.category',
    ];
    return arrayPaths.includes(jpath);
  },
});

/**
 * Parse an Atom XML string (e.g. from the arXiv API) into a JavaScript object.
 *
 * @param xml - Raw XML string.
 * @returns Parsed object with the Atom feed structure.
 */
export function parseAtomFeed(xml: string): AtomFeed {
  const parsed = atomParser.parse(xml);
  return parsed.feed as AtomFeed;
}

// ---------------------------------------------------------------------------
// Atom feed type definitions (tailored to arXiv responses)
// ---------------------------------------------------------------------------

export interface AtomFeed {
  title: string;
  id: string;
  updated: string;
  link?: AtomLink | AtomLink[];
  'opensearch:totalResults'?: string;
  'opensearch:startIndex'?: string;
  'opensearch:itemsPerPage'?: string;
  entry?: AtomEntry[];
}

export interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  author: AtomAuthor[];
  link: AtomLink[];
  category?: AtomCategory[];
  'arxiv:comment'?: string;
  'arxiv:journal_ref'?: string;
  'arxiv:doi'?: string;
  'arxiv:primary_category'?: AtomCategory;
}

export interface AtomAuthor {
  name: string;
  'arxiv:affiliation'?: string;
}

export interface AtomLink {
  '@_href': string;
  '@_rel'?: string;
  '@_type'?: string;
  '@_title'?: string;
}

export interface AtomCategory {
  '@_term': string;
  '@_scheme'?: string;
}
