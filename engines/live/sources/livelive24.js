// Recolector de livelive24.com (https://livelive24.com).
//
// La portada publica su parrilla de TV en `/tv.json`
// (`{ channel_name, image, url, country, category }`). La `url` apunta a un
// reproductor intermedio que hoy exige ejecutar JavaScript o resuelve a formatos
// que Stremio no reproduce de forma fiable, así que se ingiere el catálogo
// (para búsqueda y M3U) pero **no** se publican URLs de reproducción de esta
// fuente: aparecen como "solo en la web de origen".
const { cleanChannelName, channelKey } = require('../text');

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
    // Catálogo consultable; sin URL reproducible verificada.
    streams: [],
    externalUrl: channel.pageUrl || BASE,
    info: 'Enlace solo en la web original',
    key: channelKey(channel.name, channel.region)
  }));
  if (onSource) onSource({ channels: entries.length });
  return entries;
}

module.exports = { id: 'livelive24', name: 'livelive24.com', collect, parseTvJson, HISPANIC };
