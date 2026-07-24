# Backlog

Ideas and investigations not yet scheduled. Each item records the request, what
we found while researching it, and a concrete direction — so we don't lose the
context. Newest first.

> Note on terminology: this fork runs on the community **`@stremio-addon/*`** SDK
> (`@stremio-addon/sdk` / `/compat` / `/node-express`), **not** the official
> unmaintained `Stremio/stremio-addon-sdk`. Schema references below point at
> `@stremio-addon/sdk`'s `Stream`/`Subtitle` types. We reach Easynews only through
> **search** — `api.search()` (`packages/api/src/api.ts`) is called from the
> stream handler (`addon.ts`) to find files per title variant; there is no other
> Easynews call path.

---

## Roadmap & critical assessment (read first)

**Right-size it.** The whole language/subtitle effort is a lookup map + two
description lines + a modest upstream PR. The deep research was to avoid shipping the
wrong thing (flag emojis), not because the change is large. Don't let the analysis
depth inflate the perceived scope.

**Two reframes that set priority:**

1. **`behaviorHints.filename` is the stable, cross-tool signal; the `🌐`/`💬` code
   lines are AIOStreams-specific polish.** We already set the filename, so language
   detection works across AIOStreams (both paths), other aggregators, and players
   today. The emoji-code lines are _authoritative augmentation_ for the AIOStreams
   **preset** path only — cheap and worth doing, but **not load-bearing** and
   inherently **fragile** (coupled to AIOStreams' undocumented parser; a refactor
   there silently breaks them, with no deprecation notice). Keep filename primary.
2. **Subtitle langs are the unique prize; audio is partly redundant.** Filenames
   usually encode audio language (→ PTT recovers it), but almost never subtitle
   language — so `slangs` is data _no other signal carries_. The subtitle line has
   the strongest unique-value case, even though it needs the upstream PR to be
   machine-consumed.

**Priorities:**

- **P1 — ship now (small, high-confidence):** full B→T normalization on the `🌐`
  line (fixes real dropped languages) + read `slangs` + emit the `💬` codes line
  (immediate human value; PR-ready). **Verify end-to-end** against a live AIOStreams
  Easynews++ preset instance before calling it done — the "safe to ship" analysis is
  sound reasoning, not yet a real-instance test.
- **P2 — one upstream PR (higher leverage, maintainer-paced):** alias fix
  (+`slo→slv`) so B-codes work for _all_ external addons, plus the `💬`
  `getSubtitles` override. Backward-compatible + symmetric. Don't block P1 on it.
- **P3 — deferred, evidence-gated:** v3 migration (item 3). Its concurrency benefit
  is **unmeasured**; V2-retirement risk is low; cost is a real normalization layer.
  Do **not** start until we measure an actual 2.0 concurrency bottleneck.

**Open question (needs usage data, not derivable from code):** what fraction of our
users are direct-Stremio vs via AIOStreams? We currently show raw ISO codes
(`🌐 eng, deu`) to _all_ direct users to satisfy AIOStreams' code-parser. If direct
users are the majority, that degrades their UX for an AIOStreams minority — and we'd
prefer names/flags for humans (and ask AIOStreams to parse those, or accept
filename-only there). Default until data exists: keep codes (pre-existing, cheap, and
AIOStreams reformats them so its users never see them); revisit if a direct-user
majority is confirmed.

**Audience caveat:** the AIOStreams-preset segment is bounded —
`{fork users} ∩ {AIOStreams users} ∩ {added via the Easynews++ preset, not the
builtin Easynews scraper, not custom-URL}`. Real, but don't overstate its reach.

---

## 1. Surface subtitle-language metadata (we already receive it on 2.0)

**Requested by:** community user — "could we update to Easynews API V3 to allow
for subtitle metadata."

**Status:** researched. **The premise turned out to be wrong in our favour** — we
do **not** need v3 for this. Small, ready to schedule.

### Key finding (verified live, 2026-07-24)

The **2.0** endpoint we already call **already returns subtitle-language
metadata.** A live probe of `/2.0/search/solr-search/advanced` with our dev
account returned, per file:

- `slangs` — subtitle language codes, e.g. `["eng","fre","ger","kor","rus"]`
- `alangs` — audio language codes, e.g. `["kor"]`
  (also duplicated as named `subtitle_tracks` / `audio_tracks`, alongside
  `acodec`, `vcodec`, `xres`/`yres`, `bps`, `fps`, `fn`).

Codes are **ISO 639-2 three-letter**. Populated on a large share of posts
(~21/29 and ~82/100 across two probe titles), not all.

**The trap:** `packages/api/src/types.ts` declares `slangs: null` — that type was
quicktype-generated from a sparse sample and is simply **wrong**. `mapStream`
(`addon.ts`) only ever reads `file.alangs`, so we silently discard the subtitle
data Easynews already hands us.

### Direction

1. Fix the type: `slangs: string[] | null` in `packages/api/src/types.ts`.
2. In `mapStream`, read `file.slangs` and surface it as a **`💬` description line
   of B→T-normalized codes** (`💬 eng, fra, deu`), parallel to the `🌐` audio line.
   This is the SAME line as the subtitle-emit in item 2 — one line serves both the
   human-readable display (for clients that render our description) and the future
   AIOStreams parser. Use codes (matching `🌐`), not names. **Important:** keep
   subtitle langs _out_ of the `🌐` line — `EasynewsPlusPlusParser` treats
   everything after `🌐` as **audio** (see item 2), so mixing subs there mislabels
   them. Safe to ship now — see item 2's "progressive enhancement" note.
3. This is metadata/labelling only — 2.0 (and 3.0) report the _languages present
   in the post_, not downloadable standalone `.srt` files. Attaching real subtitle
   tracks via `Stream.subtitles[]` (`{ id, url, lang }`, `lang` = ISO 639-2) would
   require actually extracting subs and is out of scope here (noted so it isn't
   re-researched).

**Effort:** small. No API migration, no endpoint change, no new dependency.

---

## 2. Report language to AIOStreams — we mostly already do; fix the code format

**Requested by:** community user — "ensure that our addon reports language back to
AIOStreams according to some reference template."

**Status:** researched (source-verified against AIOStreams `main`, commit `7f9a9b6`,
via multiple independent traces). **The premise was wrong: there _is_ a template,
it's for us specifically, and we already emit it — but with a code-format bug that
silently drops German/French/Dutch/Chinese.** The fix is tiny and high-value.

### The "reference template" is real and Easynews++-specific

AIOStreams ships a **bespoke `EasynewsPlusPlusParser`** written for this addon
(`packages/core/src/presets/easynewsPlusPlus.ts`). Its `getLanguages()` override
reads audio languages from our description line:

> `🌐` marker, then **comma-separated ISO 639-2 codes**, terminated at the next
> emoji / newline / end — each code looked up via `convertISO6392ToLanguage`.

We **already emit exactly this**: `mapStream` produces `🌐 ${file.alangs.join(', ')}`
(+ optional ` ⭐`), i.e. `🌐 eng, ger ⭐`. Verified: the trailing ` ⭐` is parsed
around cleanly (⭐ terminates the capture), so `["eng","ger"]` is extracted. So on
the working path, our audio-language reporting **already functions today** — no flag
emojis needed. (This corrects an earlier draft of this item that recommended flag
emojis; see "Do NOT add flags" below.)

### Reachability: works via the Easynews++ _preset_, not custom-URL

Parser selection is keyed on the **AIOStreams preset**, not our manifest id/name.
`PresetManager.fromId('easynewsPlusPlus')` → `EasynewsPlusPlusPreset` →
`getParser()` returns `EasynewsPlusPlusParser` (`presetManager.ts:208`,
`easynewsPlusPlus.ts:33`).

- **Easynews++ preset → our fork's URL:** ✅ the preset's `url` option is
  user-overridable (default is just the upstream public instance,
  `config/schema/presets.ts:274`), so a user pointing the preset at our
  self-hosted fork gets `EasynewsPlusPlusParser` and the `🌐` parsing. Our config
  field shape matches what the preset generates.
- **Generic Custom addon (add-by-URL):** ❌ that's `CustomPreset` → base
  `StreamParser`, which does flag-emoji + filename parsing only and **ignores our
  `🌐` line entirely.** These users get language only from our
  `behaviorHints.filename` (which we already set — `addon.ts:1112` — so PTT still
  extracts filename tokens).

### The live bug — B-codes vs T-codes (✅ CONFIRMED from source)

Source-verified against AIOStreams `main`@`7f9a9b6`. The Easynews++ parser's
`convertISO6392ToLanguage()` (`parser/streams.ts:644-649`) does a **raw strict
match** — `FULL_LANGUAGE_MAPPING.find(l => l.iso_639_2 === code)` — with **no alias
normalization**. AIOStreams _does_ ship a `LANGUAGE_ALIAS_MAP` + `normaliseLangCode()`
(`utils/languages.ts`, maps `ger→deu`, `fre→fra`, `dut→nld`, `chi→zho`, …) — but it
is wired only into the _builtin-scraper_ path (`normaliseLanguage`, `media-info.ts`),
**never** the external-addon `getLanguages()` → `convertISO6392ToLanguage()` path.
`FULL_LANGUAGE_MAPPING` stores only 639-2/T codes, so a B-code misses and is dropped
by the `.filter(l => l !== undefined)` in `getLanguages()`.

Easynews returns **ISO 639-2/B** codes and we pass `file.alangs` through **verbatim**
(`addon.ts:1073`). Concretely traced: `🌐 eng, ger` → `["English"]`; **German lost.**

Examples (`ger`→`deu`, `fre`→`fra`, `dut`→`nld`, `chi`→`zho` are all **dropped**;
`eng, spa, ita, por, kor, jpn, dan, swe, nor, fin, rus` and other single-code langs
already work). Our live probe returned `alangs: ["ger","eng"]` and `slangs` with
`fre`/`chi`/`dut` — the drop is real and hits many languages.

> **This is language-agnostic — there is no "core" language.** The addon serves all
> languages equally, so normalize the **full** set of B/T-divergent codes, not a
> convenient subset. (An earlier draft singled out German; that framing was wrong.)

**Full B→T set to cover** — the ~20 languages where ISO 639-2 B≠T (i.e. every entry
in AIOStreams' `LANGUAGE_ALIAS_MAP`):
`fre→fra, ger→deu, cze→ces, rum→ron, dut→nld, gre→ell, alb→sqi, baq→eus, bur→mya,
chi→zho, per→fas, arm→hye, geo→kat, ice→isl, mac→mkd, mao→mri, may→msa, tib→bod,
wel→cym`, and **`slo→slv`** (Slovenian).

> **Nordic check:** of the Nordic languages, only **Icelandic** has a B/T split
> (`ice→isl`, already listed). Danish (`dan`), Swedish (`swe`), Norwegian
> (`nor`/`nob`/`nno`), Finnish (`fin`), Faroese (`fao`) have no B/T divergence and
> resolve directly.

> **`slo` correction:** AIOStreams' own map has the buggy `slo→slk` (Slovak); the
> standard B-code `slo` is **Slovenian** (T `slv`). We should emit the correct
> `slo→slv` — since we pre-normalize, their bug never reaches us, and `slv` resolves
> to Slovenian in their table. Flag their `slo→slk` bug in the upstream PR.

**Two fix routes — do both; they're complementary:**

1. **Our side (ship now, no dependency):** normalize the full B→T set above before
   building the `🌐` line. We already keep 639-2↔639-1 tables in `i18n/index.ts` —
   add a B→T map there. Keep emitting **codes** (not English names) in the `🌐`
   line — the parser needs codes; names would break it. Forward-compatible: still
   correct even after AIOStreams fixes its side.
2. **Upstream (fix it properly for everyone):** this is arguably an AIOStreams bug
   — its own alias map exists but isn't applied on the external-addon path. A
   one-line change routing `code` through `normaliseLangCode()` inside
   `convertISO6392ToLanguage()` (as the sibling `normaliseLanguage`/`media-info`
   paths already do) fixes B-codes for _every_ external addon, not just us — plus
   the `slo→slv` correction. Bundle with the subtitle PR below.

Route 1 is the tiny, immediate win; it doesn't wait on an upstream merge/deploy.

### Do NOT add flag emojis

`EasynewsPlusPlusParser.getLanguages()` **replaces** the base flag-emoji parser (it
doesn't call `super`). So on the preset path, flag emojis in our description are
**ignored** — adding them would not help and clutters the UI. (They would only help
the secondary custom-URL audience, via the base parser. If we ever want to serve
that audience too, flags are an _optional, additive_ extra — but the primary,
correct move is the `🌐` T-code line above.)

### Subtitles to AIOStreams — a symmetric `💬` convention + one-file PR

Today AIOStreams has **no** way to ingest subtitle languages from an external addon
(`EasynewsPlusPlusParser` has no `getSubtitles()`; the structured
`MediaInfo`/`subtitle[]` pipeline is builtin-scraper-only; Torrentio's `"Multi Subs"`
marker is bound to _its_ subclass). So until upstream changes, `slangs` stays a
human-readable line for direct clients (item 1). But because AIOStreams already
maintains a parser _for us_, first-class subtitle support is a small, likely-accepted
PR. Design chosen to be **maximally symmetric with the existing `🌐` audio path** so
the diff is trivial and idiomatic:

**We emit** a second marker line, identical in shape to the audio line, using a
distinct subtitle emoji and the same comma-separated **639-2/T** codes:

```
🌐 eng, deu          ← audio (existing)
💬 eng, fra, deu     ← subtitles (new, same shape; B→T normalized too)
```

`💬` has the Emoji_Presentation property, so it cleanly terminates the `🌐` capture
above it (swap for `📝`/`🔤` if preferred — design is emoji-agnostic).

**The AIOStreams PR** mirrors a pattern already in their tree — Torrentio's parser
overrides `getParsedFile()` to merge subtitle languages (`presets/torrentio.ts`). Do
the same on `EasynewsPlusPlusParser`: read the `💬` line via the _same_
`getRegexForTextAfterEmojis(['💬'])` + `convertISO6392ToLanguage` helpers already
used for `🌐`, and push into `parsedFile.subtitles`. Essentially a copy of their own
`getLanguages()` pointed at a new emoji + target field.

Why it should land easily: zero new concepts (reuses their helpers, marker
convention, and Torrentio's subtitle-merge pattern); coded input is cleaner/less
ambiguous than Torrentio's flag-emoji `"Multi Subs"`; harmless to non-AIOStreams
clients (just text). **Bundle the B→T alias fix + `slo→slv` correction into this same
PR** — one coherent, obviously-correct contribution.

**Safe to ship the emit side NOW (progressive enhancement).** Adding the `💬` line
today breaks nothing:

- It won't corrupt the existing `🌐` audio parse — the `🌐` capture terminates at
  its line-end (regex lookahead `(?=\p{Emoji_Presentation}|$|\n)`; description lines
  are `\n`-joined). Verified newline-termination behaviour.
- Current AIOStreams (no `💬` parser) and the base/custom-URL parser simply ignore
  it; plain Stremio just shows an extra info line.
- It lights up automatically once/if the parser PR merges — no redeploy needed.

**The PR is backward-compatible by construction.** The override is null-safe
(`description?.match(regex)?.[1]` → `undefined` when absent → `[] `), so Easynews++
instances/versions that DON'T emit `💬` keep `parsedFile.subtitles = []`, identical
to today. Existing instances (upstream, older versions, other forks) are unaffected.

**Line reconciliation:** use **codes** on the `💬` line (`💬 eng, fra`, B→T
normalized), matching the `🌐` convention — so the single line serves BOTH the
human-readable subtitle display (item 1) and the machine-parseable PR input. Item 1's
subtitle line and this emit line are therefore the same line.

**Effort:** the B→T fix (route 1) is **tiny** and should ship with item 1. The `💬`
emit line is small on our side; the parser override + alias fix is the upstream PR.

---

## 3. (Optional) Migrate Easynews search to v3 — reliability/latency, not subtitles

**Status:** researched. **Not urgent, not a subtitle prerequisite** (item 1 stands
on 2.0). Track as a forward hedge.

### V2 retirement risk: LOW

No official Easynews communication anywhere announces deprecating or retiring the
2.0 search API. The "Easynews 3.0" announcements are the **web-app redesign**, not
the API. The only real retirement notice (KB 561) retires legacy ISP hostnames and
**reaffirms `members.easynews.com` as actively maintained** — where our 2.0
endpoint lives. Easynews has a strong keep-old-versions-alive track record (still
offers three concurrent web layouts). "V2 = legacy" labelling comes only from the
AIOStreams maintainer's default choice, not from Easynews. Caveat: the API is
undocumented, so this is behaviour-based inference, not a guarantee.

### The actual reason v3 is attractive (it isn't subtitles)

Both 2.0 and 3.0 return the same rich metadata (verified). The real difference is
**concurrency**: 2.0 is limited to ~2 concurrent searches per account; **3.0 is not
rate-limited**, so pages fetch in parallel. Our handler fires **many per-title-
variant queries per request** — exactly the load the recent de-dupe work
(`409113e`) was trimming — so v3 could be a meaningful **latency/reliability win**.

Trade-off: 3.0 pages are **fixed at 100 results** (2.0 allows 250), and the
per-item response keys change from **numbered** (`file['0']` — our dedup hash) to
**named** (`hash`, `subtitle_tracks`, …), plus `pretty*` fields and singular
`alang`/`slang`. Note the ~2-concurrent counter is **per-account and shared** —
mixing 2.0 and 3.0 on one account pins you to the 2.0 cap.

### Direction (only if we pursue it)

Add an `apiVersion: '2.0' | '3.0'` switch in `packages/api` with a normalization
layer mapping both the numbered (2.0) and named (3.0) per-item shapes to one
internal `FileData` type, insulating the addon (`file['0']` dedup, etc.) from the
wire format. This normalization is the bulk of the cost. Auth (HTTP Basic) and
download-URL construction are unchanged between versions.

**Effort:** medium. Do items 1 & 2 first — they deliver the user-visible value on
2.0 with none of this risk.

---

## References

- `@stremio-addon/sdk` Stream/Subtitle types — `node_modules/@stremio-addon/sdk/dist/types.d.ts`
- Live v2-vs-v3 probe script (throwaway) —
  `<scratchpad>/v3-probe.mjs` (confirms 2.0 returns `slangs`/`alangs`)
- AIOStreams language detection (flags in name/description + PTT on filename) —
  https://github.com/Viren070/AIOStreams/blob/main/packages/core/src/parser/streams.ts
  (`getLanguages`, `convertFlagToLanguage`); flag map in
  `packages/core/src/utils/languages.ts` + `language-list.ts`
- AIOStreams docs (output formatters only; no input contract) —
  https://docs.aiostreams.viren070.me/reference/custom-formatter
- Easynews KB — 3.0 web app: https://help.easynews.com/kb/article/314-how-to-get-started-with-easynews-3-0/ ;
  legacy-domain retirement: https://help.easynews.com/kb/article/561-legacy-domain-retirement/ ;
  old layouts kept alive: https://help.easynews.com/kb/article/58-reverting-to-older-easynews-layouts/
- AIOStreams uses Easynews 3.0 by default (V2 "legacy", concurrency note) —
  https://github.com/Viren070/AIOStreams/commit/1b0c05b12f3f8f80095216ca6b253048bf6b7608
