import { describe, expect, it } from 'vitest';
import { ISO6392B_TO_T, normalizeLangCodes } from '../src/i18n/index.js';

describe('normalizeLangCodes', () => {
  it('maps every ISO 639-2/B code to its 639-2/T equivalent', () => {
    // The full divergent set we commit to covering (mirrors AIOStreams'
    // LANGUAGE_ALIAS_MAP, with the corrected slo→slv for Slovenian).
    const pairs: [string, string][] = [
      ['alb', 'sqi'],
      ['arm', 'hye'],
      ['baq', 'eus'],
      ['bur', 'mya'],
      ['chi', 'zho'],
      ['cze', 'ces'],
      ['dut', 'nld'],
      ['fre', 'fra'],
      ['geo', 'kat'],
      ['ger', 'deu'],
      ['gre', 'ell'],
      ['ice', 'isl'],
      ['mac', 'mkd'],
      ['mao', 'mri'],
      ['may', 'msa'],
      ['per', 'fas'],
      ['rum', 'ron'],
      ['slo', 'slv'],
      ['tib', 'bod'],
      ['wel', 'cym'],
    ];
    for (const [b, t] of pairs) {
      expect(normalizeLangCodes([b])).toEqual([t]);
    }
    // Sanity: the exported map has exactly these entries and nothing extra.
    expect(Object.keys(ISO6392B_TO_T).sort()).toEqual(pairs.map(([b]) => b).sort());
  });

  it("corrects the Slovenian mapping (slo→slv, not AIOStreams' buggy slo→slk)", () => {
    expect(normalizeLangCodes(['slo'])).toEqual(['slv']);
  });

  it('passes through codes that do not diverge between B and T', () => {
    expect(normalizeLangCodes(['eng', 'spa', 'kor', 'dan', 'jpn', 'rus'])).toEqual([
      'eng',
      'spa',
      'kor',
      'dan',
      'jpn',
      'rus',
    ]);
  });

  it('trims and lowercases before mapping', () => {
    expect(normalizeLangCodes([' GER ', 'Eng'])).toEqual(['deu', 'eng']);
  });

  it('drops empty/whitespace-only codes', () => {
    expect(normalizeLangCodes(['eng', '', '   ', 'ger'])).toEqual(['eng', 'deu']);
  });

  it('de-duplicates after normalization, preserving first-seen order', () => {
    // ger→deu collides with an explicit deu; keep the first occurrence only.
    expect(normalizeLangCodes(['ger', 'deu', 'eng', 'eng'])).toEqual(['deu', 'eng']);
  });

  it('returns an empty array for empty input', () => {
    expect(normalizeLangCodes([])).toEqual([]);
  });
});
