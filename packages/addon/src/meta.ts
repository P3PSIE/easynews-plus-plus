import { extractDigits, getAlternativeTitles, sanitizeTitle } from './utils.js';
import { createLogger } from 'easynews-plus-plus-shared';
import { ISO_TO_LANGUAGE, ADDITIONAL_LANGUAGE_CODES } from './i18n/index.js';

// Create a logger with Meta prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'Meta',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

export type MetaProviderResponse = {
  name: string;
  originalName?: string; // Original name before any custom titles
  alternativeNames?: string[]; // Alternative names/custom titles
  year?: number;
  season?: string;
  episode?: string;
};

// API Key for TMDB - should be added to environment variables in a production app
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Flag to indicate if TMDB integration should be used
let useTMDB = true;

if (!TMDB_API_KEY) {
  logger.warn('TMDB_API_KEY is not set. TMDB integration for translated titles will be disabled.');
  useTMDB = false;
}

// Metadata lookups (IMDb, Cinemeta, TMDB) sit on the critical path BEFORE any
// Easynews search runs. Without a timeout a single hung endpoint stalls the whole
// stream request indefinitely. Bound every metadata fetch; override via env.
const META_FETCH_TIMEOUT_MS = Number(process.env.META_FETCH_TIMEOUT_MS) || 5000;

interface CachedMeta {
  name: string;
  originalName?: string;
  alternativeNames?: string[];
  year?: number;
  expires: number;
}

// In-memory cache for metadata results (name, year, alternativeNames are immutable per IMDb ID)
const metaCache = new Map<string, CachedMeta>();
const META_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_META_CACHE_ENTRIES = 2000;

/** Clears the in-memory metadata cache (primarily for tests / operational reset). */
export function clearMetaCache(): void {
  metaCache.clear();
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const isCloudflare = typeof process !== 'undefined' && process.env?.CLOUDFLARE === 'true';
  const cfInit: RequestInit & { cf?: Record<string, unknown> } = {
    ...init,
    signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
  };
  if (isCloudflare) {
    cfInit.cf = {
      cacheTtl: 86400 * 7, // 7 days Cloudflare edge cache for external metadata APIs
      cacheEverything: true,
    };
  }
  return fetch(url, cfInit);
}

/**
 * Converts ISO 639-2 language code (used in Stremio) to ISO 639-1 (used by TMDB)
 * @param langCode ISO 639-2 language code
 * @returns ISO 639-1 language code or original code if no mapping exists
 */
function convertToTMDBLanguageCode(langCode: string): string {
  // First check our standard language map from i18n
  if (ISO_TO_LANGUAGE[langCode]) {
    return ISO_TO_LANGUAGE[langCode];
  }

  // Then check additional languages not used in the UI
  if (ADDITIONAL_LANGUAGE_CODES[langCode]) {
    return ADDITIONAL_LANGUAGE_CODES[langCode];
  }

  // Return original if no mapping exists
  return langCode;
}

/**
/**
 * Fetches translated title and alternative aliases for a movie or TV show from TMDB
 * @param imdbId IMDb ID
 * @param preferredLanguage Preferred language code (ISO 639-2 format like 'ger', 'fre', etc.)
 * @param customApiKey Optional user-supplied TMDB API key
 * @returns The translated title and alias titles found on TMDB
 */
async function getTMDBDetails(
  imdbId: string,
  preferredLanguage?: string,
  customApiKey?: string
): Promise<{ translatedTitle: string | null; aliases: string[] }> {
  const apiKey = customApiKey || TMDB_API_KEY;
  if (!apiKey) {
    return { translatedTitle: null, aliases: [] };
  }

  const tmdbLangCode = preferredLanguage ? convertToTMDBLanguageCode(preferredLanguage) : '';

  try {
    // First, find the TMDB ID from the IMDb ID
    const findResponse = await fetchWithTimeout(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`
    );

    if (!findResponse.ok) {
      const errorText = await findResponse.text();
      logger.error(`TMDB API error: ${findResponse.status} - ${errorText}`);
      return { translatedTitle: null, aliases: [] };
    }

    const findData = await findResponse.json();
    const isMovie = findData.movie_results && findData.movie_results.length > 0;
    const isTVShow = findData.tv_results && findData.tv_results.length > 0;

    if (!isMovie && !isTVShow) {
      logger.info(`No TMDB entry found for IMDb ID: ${imdbId}`);
      return { translatedTitle: null, aliases: [] };
    }

    const rawTmdbId = isMovie ? findData.movie_results[0].id : findData.tv_results[0].id;
    const tmdbId: string = rawTmdbId.toString();
    const mediaType = isMovie ? 'movie' : 'tv';

    const aliases: string[] = [];
    let translatedTitle: string | null = null;

    // Fetch primary TMDB details (and localized title if language requested)
    const detailsUrl = tmdbLangCode
      ? `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=${tmdbLangCode}`
      : `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}`;

    const detailsResponse = await fetchWithTimeout(detailsUrl);
    if (detailsResponse.ok) {
      const detailsData = await detailsResponse.json();
      const origName = detailsData.original_title || detailsData.original_name;
      if (origName && !aliases.includes(origName)) {
        aliases.push(origName);
      }

      if (tmdbLangCode) {
        translatedTitle = detailsData.title || detailsData.name || null;
      }
    }

    // Fetch alternative aliases from TMDB
    try {
      const altUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${encodeURIComponent(apiKey)}`;
      const altRes = await fetchWithTimeout(altUrl);
      if (altRes.ok) {
        const altData = await altRes.json();
        const rawTitles = isMovie ? altData.titles : altData.results;
        if (Array.isArray(rawTitles)) {
          for (const item of rawTitles.slice(0, 8)) {
            const alt = item?.title;
            if (alt && typeof alt === 'string' && !aliases.includes(alt)) {
              aliases.push(alt);
            }
          }
        }
      }
    } catch (err) {
      logger.debug(`Could not fetch TMDB alternative titles: ${err}`);
    }

    return { translatedTitle, aliases };
  } catch (error) {
    logger.error(`Error fetching TMDB data for ${imdbId}: ${error}`);
    return { translatedTitle: null, aliases: [] };
  }
}

async function imdbMetaProvider(
  id: string,
  preferredLanguage?: string,
  tmdbApiKey?: string
): Promise<MetaProviderResponse> {
  var [tt, season, episode] = id.split(':');

  return fetchWithTimeout(`https://v2.sg.media-imdb.com/suggestion/t/${tt}.json`)
    .then(res => res.json())
    .then(json => {
      return json.d.find((item: { id: string }) => item.id === tt);
    })
    .then(async ({ l, y }) => {
      // Get original name and potential custom titles
      const originalName = l;
      const alternativeNames = getAlternativeTitles(originalName);

      // Check TMDB for translations & aliases
      const tmdb = await getTMDBDetails(tt, preferredLanguage, tmdbApiKey);
      if (tmdb.translatedTitle) {
        if (!alternativeNames.includes(tmdb.translatedTitle)) {
          alternativeNames.push(tmdb.translatedTitle);
          logger.info(`Added TMDB translated title: ${tmdb.translatedTitle}`);
        }
        const sanitized = sanitizeTitle(tmdb.translatedTitle);
        if (sanitized !== tmdb.translatedTitle && !alternativeNames.includes(sanitized)) {
          alternativeNames.push(sanitized);
        }
      }

      for (const alias of tmdb.aliases) {
        if (!alternativeNames.includes(alias)) {
          alternativeNames.push(alias);
          logger.debug(`Added TMDB alias: ${alias}`);
        }
      }

      return {
        name: originalName,
        originalName,
        alternativeNames,
        year: y,
        season,
        episode,
      };
    });
}

async function cinemetaMetaProvider(
  id: string,
  type: string,
  preferredLanguage?: string,
  tmdbApiKey?: string
): Promise<MetaProviderResponse> {
  var [tt, season, episode] = id.split(':');

  return fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${type}/${tt}.json`)
    .then(res => res.json())
    .then(async json => {
      const meta = json.meta;
      const name = meta.name;
      const year = extractDigits(meta.year ?? meta.releaseInfo);

      // Get original name and potential custom titles
      const originalName = name;
      const alternativeNames = getAlternativeTitles(originalName);

      // Check TMDB for translations & aliases
      const tmdb = await getTMDBDetails(tt, preferredLanguage, tmdbApiKey);
      if (tmdb.translatedTitle) {
        if (!alternativeNames.includes(tmdb.translatedTitle)) {
          alternativeNames.push(tmdb.translatedTitle);
          logger.info(`Added TMDB translated title: ${tmdb.translatedTitle}`);
        }
        const sanitized = sanitizeTitle(tmdb.translatedTitle);
        if (sanitized !== tmdb.translatedTitle && !alternativeNames.includes(sanitized)) {
          alternativeNames.push(sanitized);
        }
      }

      for (const alias of tmdb.aliases) {
        if (!alternativeNames.includes(alias)) {
          alternativeNames.push(alias);
          logger.debug(`Added TMDB alias: ${alias}`);
        }
      }

      return {
        name,
        originalName,
        alternativeNames,
        year,
        episode,
        season,
      } satisfies MetaProviderResponse;
    });
}

/**
 * Fetches metadata from IMDB and use Cinemeta as a fallback, cached in memory.
 */
export async function publicMetaProvider(
  id: string,
  type: string,
  preferredLanguage?: string,
  tmdbApiKey?: string
): Promise<MetaProviderResponse> {
  const [tt, season, episode] = id.split(':');
  const cacheKey = `${tt}:${type}:${preferredLanguage || ''}:${tmdbApiKey ? 'user' : 'sys'}`;
  const cached = metaCache.get(cacheKey);

  if (cached && cached.expires > Date.now()) {
    logger.debug(`Meta cache HIT for ${cacheKey}: "${cached.name}"`);
    return {
      name: cached.name,
      originalName: cached.originalName,
      alternativeNames: cached.alternativeNames ? [...cached.alternativeNames] : undefined,
      year: cached.year,
      season,
      episode,
    };
  }

  const meta = await imdbMetaProvider(id, preferredLanguage, tmdbApiKey)
    .catch(error => {
      logger.debug(`IMDb metadata lookup failed, falling back to Cinemeta: ${error}`);
      return { name: '' } as MetaProviderResponse;
    })
    .then(result => {
      if (result.name) {
        return result;
      }

      return cinemetaMetaProvider(id, type, preferredLanguage, tmdbApiKey);
    })
    .then(result => {
      if (result.name) {
        return result;
      }

      throw new Error('Failed to find metadata');
    });

  // Store resolved metadata in cache (keyed by show/movie tt ID)
  metaCache.set(cacheKey, {
    name: meta.name,
    originalName: meta.originalName,
    alternativeNames: meta.alternativeNames,
    year: meta.year,
    expires: Date.now() + META_CACHE_TTL_MS,
  });

  while (metaCache.size > MAX_META_CACHE_ENTRIES) {
    const oldest = metaCache.keys().next().value;
    if (oldest === undefined) break;
    metaCache.delete(oldest);
  }

  return meta;
}
