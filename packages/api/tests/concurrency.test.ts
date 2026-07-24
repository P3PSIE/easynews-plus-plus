import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EasynewsAPI, createLimiter } from '../src/api';

/**
 * Per-account concurrency limiting + single-flight coalescing.
 *
 * Live-measured (2026-07-24, controlled benchmark): Easynews serves at most ~2
 * concurrent searches per account; exceeding that triggers a ~16s server-side
 * tarpit that turns into timeouts at our 20s limit. The cap is an ACCOUNT
 * property (shared across API instances and versions), so it must be enforced
 * inside EasynewsAPI, not left to callers' batching discipline.
 */

vi.mock('easynews-plus-plus-shared', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
  parseIntEnv: (value: string | undefined, fallback: number) => {
    if (value === undefined || value === '') return fallback;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
  },
}));

const okBody = { data: [], results: 0, returned: 0, unfilteredResults: 0 };

/**
 * A controllable fetch mock: every call stays pending until released, and the
 * tracker records how many requests are in flight simultaneously.
 */
function trackedFetch() {
  let active = 0;
  let maxActive = 0;
  const resolvers: Array<() => void> = [];
  const impl = vi.fn().mockImplementation(() => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise(resolve => {
      resolvers.push(() => {
        active--;
        resolve({ status: 200, ok: true, json: () => Promise.resolve(okBody) });
      });
    });
  });
  const releaseOne = () => resolvers.shift()?.();
  const releaseAll = () => {
    while (resolvers.length) releaseOne();
  };
  return {
    impl,
    releaseOne,
    releaseAll,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Releases every pending request, including ones the limiter only dispatches
 * AFTER earlier releases free a slot (their resolvers don't exist yet on the
 * first pass — hence the release/tick loop).
 */
async function drain(tracker: ReturnType<typeof trackedFetch>) {
  for (let i = 0; i < 10; i++) {
    tracker.releaseAll();
    await tick();
  }
}

describe('per-account concurrency limit', () => {
  beforeEach(() => {
    EasynewsAPI.clearCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.EASYNEWS_ACCOUNT_CONCURRENCY;
    vi.clearAllMocks();
  });

  it('keeps at most 2 Easynews requests in flight per account', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const searches = ['a', 'b', 'c', 'd', 'e'].map(q => api.search({ query: q }));
    await tick();

    expect(tracker.active).toBe(2);

    // Freeing a slot lets the next queued search start — but never a third.
    tracker.releaseOne();
    await tick();
    expect(tracker.active).toBe(2);

    await drain(tracker);
    await Promise.all(searches);
    // Late-released requests must also have been dispatched eventually.
    expect(tracker.impl).toHaveBeenCalledTimes(5);
    expect(tracker.maxActive).toBe(2);
  });

  it('shares the limit across API instances using the same credentials', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api1 = new EasynewsAPI({ username: 'same', password: 'creds' });
    const api2 = new EasynewsAPI({ username: 'same', password: 'creds' });

    const searches = [
      api1.search({ query: 'a' }),
      api1.search({ query: 'b' }),
      api2.search({ query: 'c' }),
      api2.search({ query: 'd' }),
    ];
    await tick();

    // Two instances, one account — still only 2 slots total.
    expect(tracker.active).toBe(2);

    await drain(tracker);
    await Promise.all(searches);
    expect(tracker.maxActive).toBe(2);
  });

  it('limits accounts independently of each other', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const apiA = new EasynewsAPI({ username: 'account-a', password: 'pa' });
    const apiB = new EasynewsAPI({ username: 'account-b', password: 'pb' });

    const searches = [
      apiA.search({ query: 'a' }),
      apiA.search({ query: 'b' }),
      apiA.search({ query: 'c' }),
      apiB.search({ query: 'd' }),
      apiB.search({ query: 'e' }),
      apiB.search({ query: 'f' }),
    ];
    await tick();

    // 2 slots per account, two accounts: 4 concurrent requests, not 2, not 6.
    expect(tracker.active).toBe(4);

    await drain(tracker);
    await Promise.all(searches);
  });

  it('honors EASYNEWS_ACCOUNT_CONCURRENCY as an override', async () => {
    process.env.EASYNEWS_ACCOUNT_CONCURRENCY = '1';
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const searches = [api.search({ query: 'a' }), api.search({ query: 'b' })];
    await tick();

    expect(tracker.active).toBe(1);

    await drain(tracker);
    await Promise.all(searches);
    expect(tracker.maxActive).toBe(1);
  });
});

describe('single-flight coalescing', () => {
  beforeEach(() => {
    EasynewsAPI.clearCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('coalesces identical concurrent searches into one request', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const p1 = api.search({ query: 'same' });
    const p2 = api.search({ query: 'same' });
    await tick();

    // Both callers wait on ONE underlying request (the cache can only dedupe
    // completed searches; in-flight duplicates must be coalesced explicitly).
    expect(tracker.impl).toHaveBeenCalledTimes(1);

    tracker.releaseAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(okBody);
    expect(r2).toEqual(okBody);

    // And the result still lands in the cache for later callers.
    const r3 = await api.search({ query: 'same' });
    expect(r3).toEqual(okBody);
    expect(tracker.impl).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce searches with different queries', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const p1 = api.search({ query: 'one' });
    const p2 = api.search({ query: 'two' });
    await tick();

    expect(tracker.impl).toHaveBeenCalledTimes(2);

    tracker.releaseAll();
    await Promise.all([p1, p2]);
  });

  it('a stale request settling after clearCache does not remove a newer in-flight entry', async () => {
    // Call 1 (request A): controllable, will FAIL (a failure never writes the
    // cache, so the later coalescing check below cannot be satisfied by a
    // cache hit). Calls 2+ (request B): hang until released.
    let failA!: () => void;
    let active = 0;
    const resolvers: Array<() => void> = [];
    global.fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            failA = () => resolve({ status: 500, ok: false, statusText: 'Internal Server Error' });
          })
      )
      .mockImplementation(() => {
        active++;
        return new Promise(resolve => {
          resolvers.push(() =>
            resolve({ status: 200, ok: true, json: () => Promise.resolve(okBody) })
          );
        });
      });
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const a = api.search({ query: 'same' });
    await tick();
    EasynewsAPI.clearCache(); // wipes the in-flight map while A is running

    const b = api.search({ query: 'same' }); // re-registers key K
    await tick();
    expect(global.fetch).toHaveBeenCalledTimes(2);

    failA(); // A settles AFTER the clear — must NOT delete B's entry
    await expect(a).rejects.toThrow();

    const c = api.search({ query: 'same' }); // must coalesce onto B
    await tick();
    expect(global.fetch).toHaveBeenCalledTimes(2);

    while (resolvers.length) resolvers.shift()!();
    await Promise.all([b, c]);
  });

  it('clears the in-flight entry on failure so the next search retries', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, ok: false, statusText: 'Internal Server Error' })
      .mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve(okBody) });
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    // Two concurrent identical searches share the same failure...
    const results = await Promise.allSettled([
      api.search({ query: 'flaky' }),
      api.search({ query: 'flaky' }),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // ...but a subsequent search is NOT stuck on the dead in-flight promise.
    const retry = await api.search({ query: 'flaky' });
    expect(retry).toEqual(okBody);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('search timeout covers limiter queue wait', () => {
  beforeEach(() => {
    EasynewsAPI.clearCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.EASYNEWS_ACCOUNT_CONCURRENCY;
    delete process.env.SEARCH_TIMEOUT_MS;
    vi.clearAllMocks();
  });

  it('rejects a queued search when SEARCH_TIMEOUT_MS elapses before a slot frees', async () => {
    process.env.EASYNEWS_ACCOUNT_CONCURRENCY = '1';
    process.env.SEARCH_TIMEOUT_MS = '80';
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const holder = api.search({ query: 'holds-the-only-slot' });
    await tick();
    const queued = api.search({ query: 'starves-in-queue' });

    // The queued search's clock must run while WAITING, not only once dispatched.
    await expect(queued).rejects.toThrow(/timed out/);
    // ...and it must never have consumed a fetch.
    expect(tracker.impl).toHaveBeenCalledTimes(1);

    // The slot is not leaked by the aborted waiter: after the holder finishes,
    // a new search dispatches normally.
    tracker.releaseAll();
    await holder;
    const after = api.search({ query: 'runs-after-release' });
    await tick();
    expect(tracker.impl).toHaveBeenCalledTimes(2);
    tracker.releaseAll();
    await after;
  });

  it("maps a real fetch timeout (DOMException 'TimeoutError') to the friendly message", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      );
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    await expect(api.search({ query: 'tarpitted' })).rejects.toThrow(/timed out after 20 seconds/);
  });
});

describe('Cloudflare Workers mode (no cross-request promise sharing)', () => {
  beforeEach(() => {
    EasynewsAPI.clearCache();
    vi.resetAllMocks();
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('scopes the limiter per API instance instead of sharing it across requests', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    // On Workers each stream request constructs its own EasynewsAPI; sharing
    // slots across instances would resume one request's fetch inside another
    // request's I/O context, which workerd forbids.
    const req1 = new EasynewsAPI({ username: 'same', password: 'creds' });
    const req2 = new EasynewsAPI({ username: 'same', password: 'creds' });

    const searches = [
      req1.search({ query: 'a' }),
      req1.search({ query: 'b' }),
      req1.search({ query: 'c' }),
      req2.search({ query: 'd' }),
      req2.search({ query: 'e' }),
      req2.search({ query: 'f' }),
    ];
    await tick();

    // 2 per instance — NOT 2 shared across both, NOT 6.
    expect(tracker.active).toBe(4);

    await drain(tracker);
    await Promise.all(searches);
  });

  it('does not coalesce identical in-flight searches (module-level promise sharing is unsafe)', async () => {
    const tracker = trackedFetch();
    global.fetch = tracker.impl as any;
    const api = new EasynewsAPI({ username: 'u1', password: 'p1' });

    const p1 = api.search({ query: 'same' });
    const p2 = api.search({ query: 'same' });
    await tick();

    expect(tracker.impl).toHaveBeenCalledTimes(2);

    await drain(tracker);
    await Promise.all([p1, p2]);
  });
});

describe('account limiter eviction', () => {
  beforeEach(() => {
    EasynewsAPI.clearCache();
    vi.resetAllMocks();
  });

  it('bounds the limiter registry instead of growing per unique credential forever', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve(okBody) });

    // MAX_CACHE_ENTRIES defaults to 1000; drive 1005 distinct accounts through.
    for (let i = 0; i < 1005; i++) {
      await new EasynewsAPI({ username: `user-${i}`, password: 'p' }).search({ query: `q${i}` });
    }

    expect(EasynewsAPI.stats().accountLimiters).toBeLessThanOrEqual(1000);
  });
});

describe('createLimiter', () => {
  it('rejects a queued task on abort without leaking the slot', async () => {
    const limiter = createLimiter(1);
    let releaseFirst!: () => void;
    const first = limiter.run(() => new Promise<void>(resolve => (releaseFirst = resolve)));

    const controller = new AbortController();
    const queued = limiter.run(async () => 'never', controller.signal);
    controller.abort(new DOMException('too slow', 'TimeoutError'));
    await expect(queued).rejects.toThrow();

    releaseFirst();
    await first;

    // The aborted waiter must not have consumed the slot.
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
    expect(limiter.isIdle).toBe(true);
  });
});
