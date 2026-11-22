// Recolector de tvgarden.world (https://tvgarden.world).
//
// La web sirve su catálogo como JSON estático (comprimido con gzip aunque no se
// pida): `/api/tv/countries/<cc>.json` devuelve una lista con
// `{ name, stream_urls[], youtube_urls[], languages[], country, isGeoBlocked }`.
const { cleanChannelName, channelKey } = require('../text');
const { mapLimit } = require('../limit');

const API = 'https://tvgarden.world/api/tv/countries';
const COUNTRIES = [
  ['es', 'ES'], ['mx', 'LATAM'], ['ar', 'LATAM'], ['co', 'LATAM'], ['cl', 'LATAM'],
  ['pe', 'LATAM'], ['ve', 'LATAM'], ['ec', 'LATAM'], ['gt', 'LATAM'], ['hn', 'LATAM'],
  ['sv', 'LATAM'], ['ni', 'LATAM'], ['cr', 'LATAM'], ['pa', 'LATAM'], ['cu', 'LATAM'],
  ['do', 'LATAM'], ['pr', 'LATAM'], ['uy', 'LATAM'], ['py', 'LATAM'], ['bo', 'LATAM']
];

/** Convierte la respuesta JSON (tolera ambas formas: plana y anidada). */
function parseCountry(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  return data.map(channel => {
    const streams = channel.stream_urls || channel.sources?.streams || [];
    return {
      name: cleanChannelName(channel.name || ''),
      streams: streams.filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)),
      languages: channel.languages || [],
      country: channel.country || null,
      geoBlocked: Boolean(channel.isGeoBlocked)
    };
  }).filter(channel => channel.name && channel.streams.length);
}

async function collect({ get, onSource }) {
  const perCountry = await mapLimit(COUNTRIES, 8, async ([code, region]) => {
    const entries = [];
    const html = await get(`${API}/${code}.json`, { accept: 'application/json' }).then(r => r.text);
    const channels = parseCountry(html);
    for (const channel of channels) {
      entries.push({
        name: channel.name,
        country: region,
        origin: channel.country || code,
        category: 'Generalista',
        geoBlocked: channel.geoBlocked,
        streams: channel.streams.slice(0, 3).map(url => ({ url, source: 'tvgarden.world' })),
        key: channelKey(channel.name, region)
      });
    }
    if (onSource) onSource({ country: code, channels: channels.length });
    return entries;
  });
  return perCountry.flat();
}

module.exports = { id: 'tvgarden', name: 'tvgarden.world', collect, parseCountry, COUNTRIES };
