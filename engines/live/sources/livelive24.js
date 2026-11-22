// Recolector de livelive24.com (https://livelive24.com).
//
// La portada publica su parrilla de TV en `/tv.json`
// (`{ channel_name, image, url, country, category }`). La `url` apunta a un
// reproductor intermedio (blogspot) del que a veces se puede sacar el `.m3u8`
// literal. Se intenta con el extractor genérico al recolectar; si no aparece,
// el canal queda como "solo en la web de origen" y nunca se anuncia un medio
// que no reproduce.
const { cleanChannelName, channelKey } = require('../text');
const { genericResolve } = require('../extract');

const BASE = 'https://livelive24.com';
const TV_JSON = `${BASE}/tv.json`;

// Países hispanohablantes tal como los nombra tv.json.
const HISPANIC = new Set([
  'spain', 'mexico', 'argentina', 'colombia', 'chile', 'peru', 'venezuela', 'ecuador',
  'guatemala', 'honduras', 'el salvador', 'nicaragua', 'costa rica', 'panama', 'cuba',
  'dominican republic', 'puerto rico', 'uruguay', 'paraguay', 'bolivia'
]);

function regionOf(country) {
  return /^spain$/i.test(country || '') ? 'ES' : 'LATAM';
}

/** Convierte tv.json en canales hispanohablantes. */
function parseTvJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  return data
    .filter(item => HISPANIC.has(String(item.country || '').trim().toLowerCase()))
    .map(item => ({
      name: cleanChannelName(item.channel_name || ''),
      country: item.country,
      region: regionOf(item.country),
      category: item.category || 'Generalista',
      logo: typeof item.image === 'string' && item.image.startsWith('http') ? item.image : null,
      pageUrl: item.url || null
    }))
    .filter(item => item.name);
}

async function collect({ get, onSource }) {
  const text = await get(TV_JSON, { accept: 'application/json' }).then(r => r.text);
  const channels = parseTvJson(text);
  const entries = channels.map(channel => ({
    name: channel.name,
    country: channel.region,
    origin: channel.country,
    category: channel.category,
    logo: channel.logo,
    // El reproductor intermedio se intenta resolver al recolectar.
    streams: channel.pageUrl ? [{ url: channel.pageUrl, kind: 'page', source: 'livelive24.com' }] : [],
    externalUrl: channel.pageUrl || BASE,
    info: 'Enlace solo en la web original',
    key: channelKey(channel.name, channel.region)
  }));
  if (onSource) onSource({ channels: entries.length });
  return entries;
}

/**
 * Intenta sacar el HLS del reproductor intermedio (blogspot o similar).
 * Devuelve `{ url, referer }` o `null`. Se usa desde la fase de extracción.
 */
async function resolve(pageUrl, { get }) {
  if (!pageUrl) return null;
  return genericResolve(pageUrl, { get, maxHops: 3 });
}

module.exports = { id: 'livelive24', name: 'livelive24.com', collect, resolve, parseTvJson, HISPANIC };
