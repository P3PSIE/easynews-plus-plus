import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EasynewsAPI } from '../src/api';

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
