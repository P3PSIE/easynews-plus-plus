import { EasynewsSearchResponse, FileData, SearchOptions } from './types';
import { createBasic } from './utils';
import { createLogger, parseIntEnv } from 'easynews-plus-plus-shared';

// Create a logger with API prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'API',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

// Search results are cached PER PROCESS and shared across EasynewsAPI instances.
// The addon constructs a fresh instance on every stream request, so an
// instance-local cache would never survive a single request (CACHE_TTL would be
// effectively dead). Sharing the map lets repeat requests in the same process
// actually hit the cache. Entries are credential-scoped (see credFingerprint) so
// one account's cached results can never be served to a different account — in
// particular a request with WRONG credentials still misses and gets a real 401
// rather than someone else's data.
const sharedCache = new Map<string, { data: EasynewsSearchResponse; timestamp: number }>();
const MAX_CACHE_ENTRIES = parseIntEnv(process.env.MAX_CACHE_ENTRIES, 1000);

// Easynews serves at most ~2 concurrent searches per account (live-measured
// 2026-07-24: a controlled benchmark showed 2 simultaneous requests complete in
// ~1s while 3+ trigger a ~16s server-side tarpit that scales with the excess —
// past our 20s timeout at 5+. The cap is shared across API versions and across
// clients of the same account). It is an ACCOUNT property, so it is enforced
// here — shared across EasynewsAPI instances via a per-credential limiter —
// rather than left to callers' batching discipline. EASYNEWS_ACCOUNT_CONCURRENCY
// exists as an escape hatch should Easynews ever change the cap.
export interface Limiter {
  /** Runs `task` once a slot is free; `signal` aborts the wait (not the task). */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** True when no task holds or awaits a slot (safe to evict / recreate). */
  readonly isIdle: boolean;
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  type Waiter = { grant: () => void };
  const queue: Waiter[] = [];
  // On completion the slot is handed directly to the next waiter (active is NOT
  // decremented in between) — decrementing first would open a window where a
  // new caller sneaks in and the woken waiter overshoots the cap.
  const release = () => {
    const next = queue.shift();
    if (next) next.grant();
    else active--;
  };
  return {
    get isIdle() {
      return active === 0 && queue.length === 0;
    },
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw signal.reason ?? new Error('The operation was aborted');
      if (active >= max) {
        await new Promise<void>((resolve, reject) => {
          let cleanup = () => {};
          const waiter: Waiter = {
            grant: () => {
              cleanup();
              resolve();
            },
          };
          if (signal) {
            // An aborted waiter is spliced OUT of the queue before rejecting,
            // so it never held a slot and release() never hands it one — no
            // slot leak, no double-grant (grant removes it from the queue
            // first, making the later indexOf miss).
            const onAbort = () => {
              const index = queue.indexOf(waiter);
              if (index !== -1) {
                queue.splice(index, 1);
                reject(signal.reason ?? new Error('The operation was aborted'));
              }
            };
            signal.addEventListener('abort', onAbort, { once: true });
            cleanup = () => signal.removeEventListener('abort', onAbort);
          }
          queue.push(waiter);
        });
      } else {
        active++;
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

const accountLimiters = new Map<string, Limiter>();

// Cloudflare Workers forbids performing I/O on behalf of a different request:
// a queued task resumed by another request's release(), or a caller awaiting
// another request's coalesced fetch promise, would execute I/O inside that
// other request's IoContext and be rejected or cancelled by workerd. On
// Workers we therefore fall back to per-instance limiting (the addon
// constructs one EasynewsAPI per stream request) and skip in-flight
// coalescing — weaker cross-request enforcement, but correct.
function isCloudflareWorkers(): boolean {
  return (
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
    'Cloudflare-Workers'
  );
}

// In-flight identical searches are coalesced onto one promise (the response
// cache only dedupes COMPLETED searches, so without this two simultaneous
// cache misses for the same query would spend two of the account's slots on
// identical work). Keyed by the same credential-scoped cache key.
const inflightSearches = new Map<string, Promise<EasynewsSearchResponse>>();

// Small non-cryptographic fingerprint (FNV-1a) of the credentials, used only to
// namespace cache entries per account. It is not security-sensitive and is never
// logged in full; distinct accounts simply need to land on distinct keys.
function credFingerprint(username: string, password: string): string {
  let h = 0x811c9dc5;
  const s = `${username}:${password}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class EasynewsAPI {
  private readonly baseUrl = 'https://members.easynews.com';
  private readonly username: string;
  private readonly password: string;
  private readonly cache = sharedCache;
  private readonly cacheTTL = 1000 * 60 * 60 * parseIntEnv(process.env.CACHE_TTL, 24); // 24 hours
  private readonly credKey: string;

  constructor(options: { username: string; password: string }) {
    if (!options) {
      throw new Error('Missing options');
    }

    this.username = options.username;
    this.password = options.password;
    this.credKey = credFingerprint(this.username, this.password);
  }

  /**
   * Clears the shared search cache (primarily for tests / operational reset).
   * Not safe while searches are in flight: discarding a busy limiter lets the
   * next search overshoot the per-account cap with fresh slots.
   */
  static clearCache(): void {
    sharedCache.clear();
    accountLimiters.clear();
    inflightSearches.clear();
  }

  /** Sizes of the module-level registries (operational introspection). */
  static stats(): { cacheEntries: number; accountLimiters: number; inflightSearches: number } {
    return {
      cacheEntries: sharedCache.size,
      accountLimiters: accountLimiters.size,
      inflightSearches: inflightSearches.size,
    };
  }

  private instanceLimiter?: Limiter;

  private getLimiter(): Limiter {
    const max = Math.max(1, parseIntEnv(process.env.EASYNEWS_ACCOUNT_CONCURRENCY, 2));
    if (isCloudflareWorkers()) {
      return (this.instanceLimiter ??= createLimiter(max));
    }
    let limiter = accountLimiters.get(this.credKey);
    if (!limiter) {
      limiter = createLimiter(max);
      accountLimiters.set(this.credKey, limiter);
      // Bound the registry like sharedCache: evict the oldest IDLE limiters.
      // An idle limiter carries no state and is recreated on demand; a busy
      // one must survive or the account cap could be overshot.
      if (accountLimiters.size > MAX_CACHE_ENTRIES) {
        for (const [key, candidate] of accountLimiters) {
          if (accountLimiters.size <= MAX_CACHE_ENTRIES) break;
          if (key !== this.credKey && candidate.isIdle) {
            accountLimiters.delete(key);
          }
        }
      }
    }
    return limiter;
  }

  private getCacheKey(options: SearchOptions): string {
    return JSON.stringify({
      cred: this.credKey,
      query: options.query,
      pageNr: options.pageNr || 1,
      // Use the ACTUAL page size requested, not the env default — otherwise two
      // different page sizes (e.g. searchAll's computed optimalPageSize) collide
      // on the same key and return each other's results.
      maxResults: options.maxResults ?? parseIntEnv(process.env.MAX_RESULTS_PER_PAGE, 250),
      sort1: options.sort1 || 'dsize',
      sort1Direction: options.sort1Direction || '-',
      sort2: options.sort2 || 'relevance',
      sort2Direction: options.sort2Direction || '-',
      sort3: options.sort3 || 'dtime',
      sort3Direction: options.sort3Direction || '-',
    });
  }

  private getFromCache(cacheKey: string): EasynewsSearchResponse | null {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      logger.debug(`Cache miss for key: ${cacheKey.substring(0, 50)}...`);
      return null;
    }

    const now = Date.now();
    if (now - cached.timestamp > this.cacheTTL) {
      logger.debug(`Cache expired for key: ${cacheKey.substring(0, 50)}...`);
      this.cache.delete(cacheKey);
      return null;
    }

    logger.debug(`Cache hit for key: ${cacheKey.substring(0, 50)}...`);
    return cached.data;
  }

  private setCache(cacheKey: string, data: EasynewsSearchResponse): void {
    logger.debug(
      `Caching ${data.data?.length || 0} results for key: ${cacheKey.substring(0, 50)}...`
    );
    this.cache.set(cacheKey, { data, timestamp: Date.now() });

    // The shared cache is process-lived, so bound its size. Map preserves
    // insertion order, so deleting the first key evicts the oldest entry.
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async search({
    query,
    pageNr = 1,
    maxResults = parseIntEnv(process.env.MAX_RESULTS_PER_PAGE, 250),
    sort1 = 'dsize',
    sort1Direction = '-',
    sort2 = 'relevance',
    sort2Direction = '-',
    sort3 = 'dtime',
    sort3Direction = '-',
  }: SearchOptions): Promise<EasynewsSearchResponse> {
    if (!query) {
      throw new Error('Query parameter is required');
    }

    logger.debug(`Searching for: "${query}" (page ${pageNr}, max ${maxResults})`);

    const cacheKey = this.getCacheKey({
      query,
      pageNr,
      maxResults,
      sort1,
      sort1Direction,
      sort2,
      sort2Direction,
      sort3,
      sort3Direction,
    });

    const cachedResult = this.getFromCache(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    // The timeout covers the WHOLE search — limiter queue wait included — so a
    // request starved behind a busy account still settles within timeoutMs
    // instead of waiting indefinitely for a slot.
    const timeoutMs = Math.max(1, parseIntEnv(process.env.SEARCH_TIMEOUT_MS, 20_000));
    const signal = AbortSignal.timeout(timeoutMs);

    const run = () =>
      this.getLimiter()
        .run(
          () =>
            this.doSearch(
              {
                query,
                pageNr,
                maxResults,
                sort1,
                sort1Direction,
                sort2,
                sort2Direction,
                sort3,
                sort3Direction,
              },
              cacheKey,
              signal
            ),
          signal
        )
        .catch(error => {
          // AbortSignal.timeout rejects with a DOMException named
          // 'TimeoutError' (both while queued and mid-fetch); a plain abort
          // yields 'AbortError'. Map both to the friendly message.
          const name = (error as { name?: string })?.name;
          if (name === 'TimeoutError' || name === 'AbortError') {
            logger.debug(`Search request timed out for: "${query}"`);
            throw new Error(
              `Search request for '${query}' timed out after ${timeoutMs / 1000} seconds`
            );
          }
          throw error;
        });

    if (isCloudflareWorkers()) {
      // No module-level promise sharing on Workers (see isCloudflareWorkers).
      return run();
    }

    // Coalesce onto an identical in-flight search instead of spending a second
    // account slot on the same work.
    const pending = inflightSearches.get(cacheKey);
    if (pending) {
      logger.debug(`Joining in-flight search for key: ${cacheKey.substring(0, 50)}...`);
      return pending;
    }

    const request = run().finally(() => {
      // Guarded: after a clearCache() a NEWER request may own this key — only
      // the promise that registered the entry may remove it.
      if (inflightSearches.get(cacheKey) === request) {
        inflightSearches.delete(cacheKey);
      }
    });
    inflightSearches.set(cacheKey, request);
    return request;
  }

  /** Performs the actual HTTP search request. Callers must hold an account slot. */
  private async doSearch(
    {
      query,
      pageNr,
      maxResults,
      sort1,
      sort1Direction,
      sort2,
      sort2Direction,
      sort3,
      sort3Direction,
    }: Required<Omit<SearchOptions, 'query'>> & { query: string },
    cacheKey: string,
    signal: AbortSignal
  ): Promise<EasynewsSearchResponse> {
    const searchParams = {
      st: 'adv',
      sb: '1',
      fex: 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm',
      'fty[]': 'VIDEO',
      spamf: '1',
      u: '1',
      gx: '1',
      pno: pageNr.toString(),
      sS: '3',
      s1: sort1,
      s1d: sort1Direction,
      s2: sort2,
      s2d: sort2Direction,
      s3: sort3,
      s3d: sort3Direction,
      pby: maxResults.toString(),
      safeO: '0',
      gps: query,
    };

    const url = new URL(`${this.baseUrl}/2.0/search/solr-search/advanced`);
    url.search = new URLSearchParams(searchParams).toString();

    logger.debug(`Request URL: ${url.toString().substring(0, 100)}...`);

    try {
      const fetchOptions: RequestInit = {
        headers: {
          Authorization: createBasic(this.username, this.password),
        },
        signal, // the caller's whole-search timeout (queue wait included)
      };

      if (isCloudflareWorkers()) {
        (fetchOptions as any).cf = {
          cacheTtl: 86400,
          cacheEverything: true,
        };
      }

      const res = await fetch(url, fetchOptions);

      if (res.status === 401) {
        // Do not log the username/credentials.
        logger.debug('Authentication failed (401) for the configured Easynews account');
        throw new Error('Authentication failed: Invalid username or password');
      }

      if (!res.ok) {
        logger.debug(`Request failed with status: ${res.status} ${res.statusText}`);
        throw new Error(
          `Failed to fetch search results of query '${query}': ${res.status} ${res.statusText}`
        );
      }

      const json = await res.json();
      logger.debug(`Received ${json.data?.length || 0} results out of ${json.results || 0} total`);
      this.setCache(cacheKey, json);
      return json;
    } catch (error) {
      if (error instanceof Error) {
        // Timeout/abort rejections are mapped to a friendly message by
        // search()'s catch (they can also fire while queued, before this
        // method even runs) — just pass them through here.
        logger.debug(`Error during search: ${error.message}`);
        throw error;
      }
      logger.debug(`Unknown error during search`);
      throw new Error(`Unknown error during search for '${query}'`);
    }
  }

  async searchAll(options: SearchOptions): Promise<EasynewsSearchResponse> {
    logger.debug(`Starting searchAll for: "${options.query}"`);

    const data: FileData[] = [];
    let res: Partial<EasynewsSearchResponse> = {
      data: [],
      results: 0,
      returned: 0,
      unfilteredResults: 0,
    };

    // Set constants for result limits
    const TOTAL_MAX_RESULTS = parseIntEnv(process.env.TOTAL_MAX_RESULTS, 500); // Maximum total results to return
    const MAX_PAGES = parseIntEnv(process.env.MAX_PAGES, 10); // Safety limit on number of page requests
    const MAX_RESULTS_PER_PAGE = parseIntEnv(process.env.MAX_RESULTS_PER_PAGE, 250); // Maximum results per page

    logger.info(
      `Search limits: max ${TOTAL_MAX_RESULTS} results, max ${MAX_PAGES} pages, ${MAX_RESULTS_PER_PAGE} per page`
    );

    let pageNr = 1;
    let pageCount = 0;
    // Track the first item of the previous page to detect the API re-serving the
    // same page (cycling) regardless of which page number we are on.
    let previousFirstHash: string | undefined;

    try {
      while (pageCount < MAX_PAGES) {
        // Calculate optimal page size for each request
        // Always respect TOTAL_MAX_RESULTS even on the first page
        const remainingResults = TOTAL_MAX_RESULTS - data.length;
        const optimalPageSize = Math.min(MAX_RESULTS_PER_PAGE, remainingResults);

        // If we've already reached our limit, stop fetching
        if (remainingResults <= 0) {
          logger.debug(`Reached result limit (${TOTAL_MAX_RESULTS}), stopping pagination`);
          break;
        }

        logger.debug(`Fetching page ${pageNr} with ${optimalPageSize} results per page`);
        const pageResult = await this.search({
          ...options,
          pageNr,
          maxResults: optimalPageSize,
        });

        res = pageResult;
        pageCount++;

        const newData = pageResult.data || [];

        // No more results
        if (newData.length === 0) {
          logger.debug(`No more results found, stopping pagination`);
          break;
        }

        // Duplicate detection - stop if this page's first item matches the
        // previous page's first item (the API re-served the same page).
        if (previousFirstHash !== undefined && newData[0]?.['0'] === previousFirstHash) {
          logger.debug(`Duplicate results detected, stopping pagination`);
          break;
        }
        previousFirstHash = newData[0]?.['0'];

        logger.debug(`Adding ${newData.length} results from page ${pageNr}`);
        data.push(...newData);

        // Stop if we've reached our total limit
        if (data.length >= TOTAL_MAX_RESULTS) {
          logger.debug(`Reached result limit (${TOTAL_MAX_RESULTS}), trimming and stopping`);
          // Trim the array to exactly TOTAL_MAX_RESULTS
          data.length = TOTAL_MAX_RESULTS;
          break;
        }

        logger.debug(
          `Progress: ${data.length}/${TOTAL_MAX_RESULTS} results (${Math.round(
            (data.length / TOTAL_MAX_RESULTS) * 100
          )}%)`
        );

        pageNr++;
      }

      logger.debug(`SearchAll complete, returning ${data.length} total results`);
      return { ...res, data } as EasynewsSearchResponse;
    } catch (error) {
      // If we have partial results, return them
      if (data.length > 0) {
        logger.debug(`Returning ${data.length} partial results due to error`);
        logger.error(`Search error: ${(error as Error).message}`);
        return { ...res, data } as EasynewsSearchResponse;
      }
      logger.debug(`No results to return due to error: ${(error as Error).message}`);
      throw error;
    }
  }
}
