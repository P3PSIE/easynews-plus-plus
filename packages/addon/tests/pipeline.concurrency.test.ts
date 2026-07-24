import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Search fan-out concurrency behavior.
 *
 * Live-measured (2026-07-24): Easynews serves ~2 concurrent searches per
 * account; a 3rd+ simultaneous request triggers a ~16s server-side tarpit
 * (guaranteed timeout at 5+ concurrent with our 20s limit). The fan-out must
 * therefore default to 2 and keep slots continuously filled (sliding window)
 * rather than dispatching in lock-step batches where one slow query holds an
 * idle slot hostage.
 */

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('../src/manifest', () => ({
  manifest: {
    id: 'org.easynews',
    name: 'Easynews++',
    description: 'Easynews++ Addon',
    version: '1.0.0',
    catalogs: [],
    resources: ['stream'],
    types: ['movie', 'series'],
  },
}));

const mockSearch = vi.fn();

vi.mock('easynews-plus-plus-api', () => ({
  EasynewsAPI: vi.fn().mockImplementation(() => ({ search: mockSearch })),
}));

vi.mock('../src/meta', () => ({
  // Five alternative titles + the original = 6 no-year queries (plus 6 year
  // queries), enough to observe the fan-out's concurrency window.
  publicMetaProvider: vi.fn().mockResolvedValue({
    id: 'tt1234567',
    name: 'Test Movie',
    alternativeNames: ['Alt One', 'Alt Two', 'Alt Three', 'Alt Four', 'Alt Five'],
    year: 2020,
    type: 'movie',
  }),
}));

vi.mock('../src/i18n', () => ({
  getUILanguage: vi.fn().mockReturnValue('eng'),
  translations: { eng: { errors: { authFailed: 'auth failed' } } },
  ISO_TO_LANGUAGE: { eng: 'en' },
  normalizeLangCodes: (codes: string[]) => codes,
}));

vi.mock('@stremio-addon/compat', () => ({
  addonBuilder: vi.fn().mockImplementation(() => ({
    defineStreamHandler: vi.fn().mockImplementation(handler => {
      (global as any).streamHandler = handler;
      return handler;
    }),
    getInterface: vi.fn().mockReturnValue({ manifest: {}, stream: {} }),
  })),
}));

vi.mock('easynews-plus-plus-shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
  parseIntEnv: (value: string | undefined, fallback: number) => {
    if (value === undefined || value === '') return fallback;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
  },
}));

vi.mock('../../../custom-titles.json', () => ({ default: {} }));
vi.mock('../src/custom-template', () => ({ default: vi.fn().mockReturnValue('<html></html>') }));

import '../src/addon';

const DL = { downURL: 'https://members.easynews.com/dl', dlFarm: 'farm', dlPort: 'port' };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function baseConfig() {
  return {
    username: 'u',
    password: 'p',
    baseUrl: 'https://addon.test',
    strictTitleMatching: 'false',
  };
}

async function runHandler(id: string) {
  const handler = (global as any).streamHandler;
  return handler({ id, type: 'movie', config: baseConfig() });
}

describe('search fan-out concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SEARCH_CONCURRENCY;
    delete process.env.TOTAL_MAX_RESULTS;
  });

  it('keeps at most 2 searches in flight by default', async () => {
    let active = 0;
    let maxActive = 0;
    mockSearch.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      return { data: [], ...DL };
    });

    await runHandler('tt0000101');

    expect(mockSearch.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(maxActive).toBe(2);
  });

  it('refills a freed slot immediately instead of waiting for the whole batch (sliding window)', async () => {
    process.env.SEARCH_CONCURRENCY = '2';
    const started: Array<{ query: string; at: number }> = [];
    const t0 = performance.now();
    mockSearch.mockImplementation(async ({ query }: { query: string }) => {
      started.push({ query, at: performance.now() - t0 });
      // The first query is slow; everything else is fast. With lock-step
      // batches of 2, the 3rd query cannot start until the slow one finishes
      // (~60ms); with a sliding window it starts as soon as the 2nd finishes.
      await delay(query === 'Test Movie' ? 60 : 5);
      return { data: [], ...DL };
    });

    await runHandler('tt0000102');

    expect(started.length).toBeGreaterThanOrEqual(3);
    const third = started[2];
    expect(third.at).toBeLessThan(40);
  });

  it('warns when SEARCH_CONCURRENCY is raised above the measured account cap', async () => {
    process.env.SEARCH_CONCURRENCY = '5';
    mockSearch.mockImplementation(async () => ({ data: [], ...DL }));

    await runHandler('tt0000103');

    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/concurren/i));
  });
});
