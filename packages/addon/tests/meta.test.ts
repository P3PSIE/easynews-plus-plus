import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { publicMetaProvider, clearMetaCache } from '../src/meta';

// Route fetch by URL so we can exercise the IMDb -> Cinemeta fallback without
// real network access. A TMDB catch-all keeps the test robust regardless of
// whether TMDB_API_KEY happens to be set in the environment.
function mockFetch(imdbJson: unknown) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('media-imdb.com/suggestion')) {
      return { ok: true, json: async () => imdbJson } as unknown as Response;
    }
    if (u.includes('cinemeta')) {
      return {
        ok: true,
        json: async () => ({ meta: { name: 'Fallback Movie', year: '2020' } }),
      } as unknown as Response;
    }
    // TMDB find / anything else: no results.
    return {
      ok: true,
      json: async () => ({ movie_results: [], tv_results: [] }),
    } as unknown as Response;
  });
}

describe('publicMetaProvider — IMDb -> Cinemeta fallback & Caching', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    clearMetaCache();
    vi.restoreAllMocks();
  });

  it('falls back to Cinemeta when the IMDb suggestion has no matching id', async () => {
    // d is present but contains no item whose id === tt -> .find() returns undefined.
    global.fetch = mockFetch({ d: [{ id: 'tt9999999', l: 'Some Other Title' }] }) as typeof fetch;

    const meta = await publicMetaProvider('tt0000001', 'movie', '');

    expect(meta.name).toBe('Fallback Movie');
  });

  it('uses the IMDb title when the suggestion matches (no needless fallback)', async () => {
    global.fetch = mockFetch({
      d: [{ id: 'tt0000001', l: 'Imdb Movie', y: 1999 }],
    }) as typeof fetch;

    const meta = await publicMetaProvider('tt0000001', 'movie', '');

    expect(meta.name).toBe('Imdb Movie');
  });

  it('serves repeat and subsequent episode requests from the in-memory cache without re-fetching', async () => {
    const fetchMock = mockFetch({
      d: [{ id: 'tt0000002', l: 'Cached Series', y: 2024 }],
    });
    global.fetch = fetchMock as typeof fetch;

    // Episode 1 lookup
    const meta1 = await publicMetaProvider('tt0000002:1:1', 'series', '');
    expect(meta1.name).toBe('Cached Series');
    expect(meta1.season).toBe('1');
    expect(meta1.episode).toBe('1');
    const initialFetchCount = fetchMock.mock.calls.length;

    // Episode 2 lookup of same show: should hit cache and NOT re-fetch IMDb
    const meta2 = await publicMetaProvider('tt0000002:1:2', 'series', '');
    expect(meta2.name).toBe('Cached Series');
    expect(meta2.season).toBe('1');
    expect(meta2.episode).toBe('2');
    expect(fetchMock.mock.calls.length).toBe(initialFetchCount);
  });

  it('queries TMDB when user supplies a custom TMDB API key', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('media-imdb.com/suggestion')) {
        return {
          ok: true,
          json: async () => ({ d: [{ id: 'tt0000003', l: 'Money Heist', y: 2017 }] }),
        } as unknown as Response;
      }
      if (u.includes('api.themoviedb.org/3/find')) {
        return {
          ok: true,
          json: async () => ({
            movie_results: [],
            tv_results: [{ id: 71446 }],
          }),
        } as unknown as Response;
      }
      if (u.includes('api.themoviedb.org/3/tv/71446?')) {
        return {
          ok: true,
          json: async () => ({
            name: 'Haus des Geldes',
            original_name: 'La Casa de Papel',
          }),
        } as unknown as Response;
      }
      if (u.includes('api.themoviedb.org/3/tv/71446/alternative_titles')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ title: 'La casa de papel' }, { title: 'Money Heist' }],
          }),
        } as unknown as Response;
      }
      return { ok: false } as unknown as Response;
    });

    global.fetch = fetchMock as typeof fetch;

    const meta = await publicMetaProvider('tt0000003:1:1', 'series', 'ger', 'test-custom-tmdb-key');
    expect(meta.name).toBe('Money Heist');
    expect(meta.alternativeNames).toContain('La Casa de Papel');
    expect(meta.alternativeNames).toContain('Haus des Geldes');
  });
});
