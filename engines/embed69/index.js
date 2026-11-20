const API_ENDPOINT = 'https://apiz.6969009.xyz/api/check';
const EMBED_BASE_URL = 'https://embed69.org/f/';

function validateImdbId(imdbId) {
  if (typeof imdbId !== 'string' || !/^tt\\d{7,}$/.test(imdbId)) {
    throw new TypeError('IMDb ID must use the tt######## format');
  }
  return imdbId;
}

function normalizeRequest({ type, imdbId, season, episode }) {
  validateImdbId(imdbId);

  if (type === 'movie') {
    return { kind: 'movie', imdbId, queryName: 'imdb', queryValue: imdbId };
  }

  if (type === 'series') {
    return { kind: 'series', imdbId, queryName: 'imdb_tv', queryValue: imdbId };
  }

  if (type === 'episode') {
    const seasonNumber = Number(season);
    const episodeNumber = Number(episode);
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1
      || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
      throw new TypeError('Season and episode must be positive integers');
    }
    const suffix = `${seasonNumber}x${String(episodeNumber).padStart(2, '0')}`;
    return {
      kind: 'episode',
      imdbId,
      season: seasonNumber,
      episode: episodeNumber,
      queryName: 'imdb_tv',
      queryValue: `${imdbId}-${suffix}`
    };
  }

  throw new TypeError('Type must be movie, series, or episode');
}

function buildEmbedUrl(request) {
  const normalized = normalizeRequest(request);
  const suffix = normalized.kind === 'episode'
    ? `-${normalized.season}x${String(normalized.episode).padStart(2, '0')}`
    : '';
  return new URL(`${encodeURIComponent(normalized.imdbId)}${suffix}`, EMBED_BASE_URL).toString();
}

async function checkAvailability(request, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  const normalized = normalizeRequest(request);
  const url = new URL(API_ENDPOINT);
  url.searchParams.set(normalized.queryName, normalized.queryValue);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Embed69 availability API returned HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Embed69 availability API returned invalid JSON');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.exists !== 'boolean') {
      throw new Error('Embed69 availability API returned an unexpected response');
    }

    return {
      available: payload.exists,
      embedUrl: payload.exists ? buildEmbedUrl(request) : null,
      kind: normalized.kind
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * This provider currently discovers Embed69 pages; it does not extract playable
 * HLS/MP4 URLs. Never return embedUrl as a Stremio stream URL.
 */
async function discover(request, options) {
  const result = await checkAvailability(request, options);
  return {
    provider: 'embed69',
    available: result.available,
    pageUrl: result.embedUrl,
    playable: false,
    limitation: 'Embed69 page extraction is not implemented yet'
  };
}

module.exports = {
  API_ENDPOINT,
  EMBED_BASE_URL,
  normalizeRequest,
  buildEmbedUrl,
  checkAvailability,
  discover
};
