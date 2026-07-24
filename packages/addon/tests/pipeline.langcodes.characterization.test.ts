import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Characterization test for the language/subtitle description lines produced by
 * mapStream. Unlike the other pipeline suites, this one deliberately does NOT mock
 * `../src/i18n`, so the REAL normalizeLangCodes (B→T) runs end-to-end. It pins:
 *   - the audio `🌐` line emits normalized 639-2/T codes (ger→deu),
 *   - a `💬` subtitle line is emitted (also normalized) when `slangs` is present,
 *   - no `💬` line is emitted when `slangs` is absent/empty.
 */

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

function fileOf(o: {
  hash: string;
  title: string;
  size: string;
  raw: number;
  res: string;
  alangs?: string[] | null;
  slangs?: string[] | null;
}) {
  return {
    '0': o.hash,
    '2': '.mkv',
    '4': o.size,
    '10': o.title,
    '11': '.mkv',
    '14': '120m',
    type: 'VIDEO',
    rawSize: o.raw,
    fullres: o.res,
    alangs: o.alangs ?? null,
    slangs: o.slangs ?? null,
    ts: 0,
    passwd: false,
    virus: false,
    downURL: 'https://members.easynews.com/dl',
    dlFarm: 'farm',
    dlPort: 'port',
  };
}

// Files at distinct qualities (kept as separate streams): one with divergent audio
// (ger) + subtitle (fre/chi) B-codes, one with no subtitle langs, and one whose
// slangs is a non-empty array of only blank strings (must NOT emit a bare `💬 `).
const FILES = [
  fileOf({
    hash: 'a',
    title: 'Test Movie 2020 2160p BluRay',
    size: '2 GB',
    raw: 2e9,
    res: '3840x2160',
    alangs: ['ger', 'eng'],
    slangs: ['eng', 'fre', 'chi'],
  }),
  fileOf({
    hash: 'b',
    title: 'Test Movie 2020 1080p WEB-DL',
    size: '5 GB',
    raw: 5e9,
    res: '1920x1080',
    alangs: ['eng'],
    slangs: null,
  }),
  fileOf({
    hash: 'c',
    title: 'Test Movie 2020 720p HDTV',
    size: '3 GB',
    raw: 3e9,
    res: '1280x720',
    alangs: ['eng'],
    slangs: ['', '   '],
  }),
];

vi.mock('easynews-plus-plus-api', async importOriginal => ({
  // Spread the real module so non-mocked exports (createLimiter) stay live.
  ...(await importOriginal<typeof import('easynews-plus-plus-api')>()),
  EasynewsAPI: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({
      data: FILES,
      downURL: 'https://members.easynews.com/dl',
      dlFarm: 'farm',
      dlPort: 'port',
    }),
  })),
}));

vi.mock('../src/meta', () => ({
  publicMetaProvider: vi.fn().mockResolvedValue({
    id: 'tt1234567',
    name: 'Test Movie',
    year: 2020,
    type: 'movie',
  }),
}));

// NOTE: '../src/i18n' is intentionally NOT mocked here — we exercise the real
// normalizeLangCodes so B→T normalization is verified end-to-end.

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
    warn: vi.fn(),
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

async function runHandler(config: Record<string, string> = {}) {
  const handler = (global as any).streamHandler;
  return handler({
    id: 'tt1234567',
    type: 'movie',
    config: { username: 'u', password: 'p', baseUrl: 'https://addon.test', ...config },
  });
}

const qualityOf = (s: any) => String(s.name).split('\n')[1];

describe('language/subtitle description lines (real i18n)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes the audio 🌐 line to 639-2/T codes (ger→deu)', async () => {
    const { streams } = await runHandler();
    const fourK = streams.find((s: any) => qualityOf(s) === '4K');
    const lines = fourK.description.split('\n');
    const audio = lines.find((l: string) => l.startsWith('🌐'));
    expect(audio).toBe('🌐 deu, eng');
  });

  it('emits a 💬 subtitle line with normalized codes when slangs is present', async () => {
    const { streams } = await runHandler();
    const fourK = streams.find((s: any) => qualityOf(s) === '4K');
    const lines = fourK.description.split('\n');
    const subs = lines.find((l: string) => l.startsWith('💬'));
    expect(subs).toBe('💬 eng, fra, zho');
  });

  it('marks the preferred audio language with ⭐ using the raw B-code', async () => {
    const { streams } = await runHandler({ preferredLanguage: 'ger' });
    const fourK = streams.find((s: any) => qualityOf(s) === '4K');
    const audio = fourK.description.split('\n').find((l: string) => l.startsWith('🌐'));
    expect(audio).toBe('🌐 deu, eng ⭐');
  });

  it('omits the 💬 line entirely when slangs is absent', async () => {
    const { streams } = await runHandler();
    const teneighty = streams.find((s: any) => qualityOf(s) === '1080p');
    expect(teneighty.description).not.toContain('💬');
    // audio line still present
    expect(teneighty.description).toContain('🌐 eng');
  });

  it('does not emit a bare 💬 line when slangs contains only blank codes', async () => {
    // Guards against regressing to a raw-length check: ['', '   '] has length 2 but
    // normalizes to [], so no subtitle line should appear.
    const { streams } = await runHandler();
    const sevenTwenty = streams.find((s: any) => qualityOf(s) === '720p');
    expect(sevenTwenty.description).not.toContain('💬');
  });
});
