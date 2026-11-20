const fs = require('node:fs');
const { createExtractor } = require('../media');

function validatePages(pages) {
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) throw new TypeError('FlixLatam pages must be an object');
  for (const [key, raw] of Object.entries(pages)) {
    if (!/^(movie:tt\d{7,}|series:tt\d{7,}:[1-9]\d*:[1-9]\d*)$/.test(key)) throw new TypeError('Invalid FlixLatam mapping key');
    if (typeof raw !== 'string') throw new TypeError('FlixLatam page must be a URL string');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
      throw new TypeError('Expected an HTTPS page URL without credentials, port or fragment');
    }
  }
  return pages;
}
function loadPages() {
  return process.env.FLIXLATAM_PAGES_FILE
    ? validatePages(JSON.parse(fs.readFileSync(process.env.FLIXLATAM_PAGES_FILE, 'utf8'))) : {};
}
function createProvider({ pages = loadPages(), allowedHosts = (process.env.FLIXLATAM_ALLOWED_HOSTS || 'flixlatam.com,www.flixlatam.com')
  .split(',').map(host => host.trim()).filter(Boolean), ...options } = {}) {
  validatePages(pages);
  const extractor = createExtractor({ ...options, name: 'FlixLatam', allowedHosts, followScripts: true });
  async function extract(pageUrl) {
    const url = new URL(pageUrl);
    // A hash selects an episode in JavaScript; fetching it would silently fetch
    // the series landing page and could return the wrong episode.
    if (url.hash) throw new TypeError('Episode hash navigation is not supported; supply the exact player page');
    return extractor.extract(url.href);
  }
  async function resolve({ type, imdbId, season, episode }) {
    if (!/^tt\d{7,}$/.test(imdbId)) throw new TypeError('Invalid IMDb ID');
    let key;
    if (type === 'movie') key = `movie:${imdbId}`;
    else if (type === 'episode' && /^[1-9]\d*$/.test(String(season)) && /^[1-9]\d*$/.test(String(episode))) {
      key = `series:${imdbId}:${season}:${episode}`;
    } else throw new TypeError('Expected movie or episode with positive season and episode');
    const page = Object.hasOwn(pages, key) ? pages[key] : null;
    if (!page) return [];
    return extract(page);
  }
  return { resolve, extract };
}
module.exports = { createProvider, validatePages };
