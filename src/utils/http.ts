import { ApiError } from '../core/errors';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const USER_AGENT = 'ResearchLoop/0.1.0 (VSCode Extension)';

/**
 * Determines whether a failed request should be retried based on its status code.
 * Retries on 429 (rate-limited) and 5xx (server errors).
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Calculates the delay before the next retry using exponential backoff with jitter.
 * If a Retry-After header is present and the status is 429, that value is respected.
 */
function getRetryDelay(attempt: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }
  // Exponential backoff: 1s, 2s, 4s ... plus jitter
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS * 0.5;
  return exponential + jitter;
}

/**
 * Sleep helper that respects an optional AbortSignal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * HTTP client with retry on 429/5xx, exponential backoff, timeout, and User-Agent header.
 *
 * @param url - The URL to fetch.
 * @param options - Optional request configuration.
 * @returns The HTTP response with status, headers, and body text.
 * @throws {ApiError} On non-retryable HTTP errors or after exhausting retries.
 */
export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT, signal } = options;

  const mergedHeaders: Record<string, string> = {
    'User-Agent': USER_AGENT,
    ...headers,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Create a timeout controller that chains with the external signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    // If the external signal is already aborted, abort immediately
    if (signal?.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException('Aborted', 'AbortError');
    }

    // Forward external abort to our controller
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers: mergedHeaders,
        body,
        signal: timeoutController.signal,
      });

      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onExternalAbort);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const responseBody = await response.text();

      if (response.ok) {
        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
        };
      }

      // Non-retryable error -- fail immediately
      if (!isRetryableStatus(response.status)) {
        throw new ApiError(
          `HTTP ${response.status} ${response.statusText}: ${responseBody.slice(0, 200)}`,
          url,
          response.status,
        );
      }

      // Retryable error -- will retry if attempts remain
      lastError = new ApiError(
        `HTTP ${response.status} ${response.statusText}`,
        url,
        response.status,
      );

      if (attempt < MAX_RETRIES) {
        const retryAfter = responseHeaders['retry-after'];
        const delay = getRetryDelay(attempt, retryAfter);
        await sleep(delay, signal);
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onExternalAbort);

      // Propagate abort errors without retrying
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      // Network-level errors (DNS failure, connection refused, etc.) are retryable
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt);
        await sleep(delay, signal);
      }
    }
  }

  throw new ApiError(
    `Request to ${url} failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
    url,
  );
}
