const { createExtractor } = require('./extractor');

// Direct site stream extraction: resolves a page URL on one of the supported
// streaming sites to verified HLS/MP4 streams only. No catalogs, no metadata,
// no demo entries: the resolver returns verified media or an empty list.
const SITES = [
  {
    key: 'documaniatv',
    name: 'DocumaniaTV',
    title: 'HLS / MP4',
    hosts: ['www.documaniatv.com', 'documaniatv.com']
  },
  {
    key: 'flixlatam',
    name: 'FlixLatam',
    title: 'HLS / MP4',
    hosts: ['www.flixlatam.com', 'flixlatam.com']
  },
  {
    key: 'poseidonhd2',
    name: 'PoseidonHD2',
    title: 'HLS / MP4',
    hosts: ['www.poseidonhd2.co', 'poseidonhd2.co']
  }
];

// Only the three site domains are trusted by default. Additional media/CDN
// hosts must be added explicitly via SITES_ALLOWED_HOSTS after checking them.
function allowedHosts() {
  const extra = (process.env.SITES_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...SITES.flatMap(site => site.hosts.map(h => h.toLowerCase())), ...extra])];
}

function findSite(host) {
  const normalized = String(host).toLowerCase();
  return SITES.find(site => site.hosts.includes(normalized)) || null;
}

function validateSiteUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('A site URL is required');
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('Site URL is not a valid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Site URL must be a plain HTTPS URL without credentials');
  }
  const site = findSite(url.hostname);
  if (!site) throw new TypeError(`Unsupported site host: ${url.hostname}`);
  return { url, site };
}

// Stream-only resolution: validates the page URL, extracts literal HLS/MP4
// candidates from the page (and same-site iframes) and verifies each response
// signature. Returns [{ name, title, url }]; an empty array means nothing
// verifiable was found on that page.
async function resolve(request, options = {}) {
  const { url, site } = validateSiteUrl(request && request.url);
  const extractor = createExtractor({
    allowedHosts: allowedHosts(),
    name: site.name,
    title: site.title,
    ...options
  });
  return extractor.extract(url.href);
}

module.exports = { SITES, allowedHosts, findSite, validateSiteUrl, resolve };
