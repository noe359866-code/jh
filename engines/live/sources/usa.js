// Fuente de Estados Unidos.
//
// `iptv-org` publica `streams/us.m3u` con más de mil canales, pero no dice en
// qué idioma emite cada uno. Su base de datos sí: `data/feeds.csv` tiene una fila
// por emisión con `languages` (`spa`, `eng`…) y `is_main`.
//
// Ojo con el idioma: `ABC.us` tiene cientos de emisiones locales, casi todas en
// inglés y alguna en español, así que «tiene algún feed en español» no sirve para
// decidir. La regla es por emisión principal:
//
//   - feed principal en español  → se publica (`language: 'es'`).
//   - solo emisiones secundarias en español y es cadena mayoritaria (ABC, CNN…)
//     → se publica marcado `language: 'en'`, como complemento.
//   - el resto de `us.m3u` (ingleses locales) → se descarta.
const { parseM3u } = require('../m3u');
const { entryFromItem, categoryFromGroup } = require('./playlist');

const STREAMS_URL = 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u';
const FEEDS_URL = 'https://raw.githubusercontent.com/iptv-org/database/master/data/feeds.csv';

// Cadenas mayoritarias en inglés que se incluyen como complemento. El resto de
// canales en inglés de `us.m3u` son locales y no se publican. El `\b` final
// evita que `NBC` capture `NBC Sports NOW`: esas variantes ya están cubiertas
// por su propia entrada y así no se duplica la lista con docenas de señales.
const MAJOR_NETWORKS = new RegExp([
  'ABC', 'CBS', 'NBC', 'FOX', 'PBS', 'CNN', 'MSNBC', 'CNBC', 'HLN', 'OAN',
  'NewsNation', 'Newsmax', 'Bloomberg', 'C-SPAN', 'The Weather Channel',
  'Fox News', 'Fox Business', 'Fox Sports', 'ESPN', 'NBA TV', 'NFL Network'
].map(network => network.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

// Canales de Estados Unidos que emiten en español por definición. La base de
// iptv-org marca algunos de ellos como `eng` en su feed principal (Univision y
// Telemundo figuran así), lo que es un error de datos: su programación es en
// español. Se fuerza el idioma en lugar de perderlos.
const ALWAYS_SPANISH = new Set([
  'Univision.us', 'UniMas.us', 'Telemundo.us', 'Galavision.us', 'EstrellaTV.us',
  'Pasiones.us', 'PasionesLatinAmerica.us', 'TUDN.us', 'ESPNDeportes.us',
  'FoxDeportes.us', 'CNNenEspanol.us', 'NewsmaxSpanish.us', 'DiscoveryenEspanol.us',
  'NatGeoMundo.us', 'CineLatino.us', 'DePeliculaUS.us', 'MegaTV.us', 'CanelaTV.us',
  'EstrellaNews.us', 'EstrellaGames.us', 'BabyFirst.us', 'Semillitas.us',
  'Sorpresa.us', 'TelefeInternacional.us', 'TVEInternacional.us', 'Antena3.us'
]);

// Nombre base sin calidad ni sufijos de emisión: `NBC West (San Diego) [Not 24/7]`.
const baseName = name => String(name || '')
  .replace(/\s*\((?:[^)]*\b(?:1080p|720p|480p|HD|SD|4K)\b[^)]*)\)/gi, '')
  .replace(/\s*\[[^\]]*\]/g, '')
  .replace(/\s*\((?:East|West|Central|Mountain|Pacific|Hawaii)[^)]*\)/gi, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Idioma de la emisión principal de cada canal: `{ spanish, secondary }`.
 * `spanish` = el feed marcado `is_main` emite en español; `secondary` = solo
 * alguna emisión local lo hace.
 */
function spanishFeeds(csv) {
  const spanish = new Set();
  const secondary = new Set();
  const lines = String(csv).split(/\r?\n/);
  if (!lines.length) return { spanish, secondary };
  const header = lines[0].split(',');
  const iChannel = header.indexOf('channel');
  const iLanguages = header.indexOf('languages');
  const iMain = header.indexOf('is_main');
  if (iChannel < 0 || iLanguages < 0) return { spanish, secondary };
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split(',');
    const channel = cells[iChannel];
    const languages = (cells[iLanguages] || '').split(';');
    if (!channel || !languages.includes('spa')) continue;
    if (iMain >= 0 && String(cells[iMain]).toUpperCase() === 'TRUE') spanish.add(channel);
    else secondary.add(channel);
  }
  for (const channel of spanish) secondary.delete(channel);
  return { spanish, secondary };
}

async function collect({ get, onSource }) {
  // El CSV es grande (2,8 MB) pero es la única forma de saber el idioma.
  const [streams, feeds] = await Promise.all([
    get(STREAMS_URL, { allowHttp: true, maxBytes: 8 * 1024 * 1024, accept: 'application/x-mpegURL,text/plain,*/*' }),
    get(FEEDS_URL, { allowHttp: true, maxBytes: 8 * 1024 * 1024, accept: 'text/csv,text/plain,*/*' })
  ]);
  const { spanish, secondary } = spanishFeeds(feeds.text);
  const entries = [];
  let dropped = 0;
  for (const item of parseM3u(streams.text)) {
    const id = String(item.attrs['tvg-id'] || '').replace(/@.*$/, '');
    const name = baseName(item.name);
    const isSpanish = spanish.has(id) || ALWAYS_SPANISH.has(id);
    // Una cadena mayoritaria con alguna emisión en español se queda, pero como
    // canal en inglés: su señal habitual no es en español.
    const major = !isSpanish && MAJOR_NETWORKS.test(name) && (secondary.has(id) || !spanish.has(id));
    if (!isSpanish && !major) {
      dropped++;
      continue;
    }
    const entry = entryFromItem({ ...item, name }, { source: 'Estados Unidos (iptv-org)', forcedCountry: 'US' });
    if (!entry) continue;
    entry.language = isSpanish ? 'es' : 'en';
    // En `us.m3u` el `group-title` suele ser `News`/`Sports`/`Movies`, que sí es
    // una categoría; se traduce. Antes se copiaba tal cual y Stremio mostraba
    // «News» como categoría, sin traducir.
    entry.category = categoryFromGroup(item.attrs['group-title']) || (isSpanish ? 'Generalista' : 'Generalista (inglés)');
    entries.push(entry);
  }
  if (onSource) {
    onSource({
      usStreams: entries.length,
      usSpanish: entries.filter(entry => entry.language === 'es').length,
      usEnglish: entries.filter(entry => entry.language === 'en').length,
      usDiscarded: dropped
    });
  }
  // Deduplicar por URL: la lista repite señales con distinto id.
  const seen = new Set();
  return entries.filter(entry => {
    const url = entry.streams[0].url;
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

module.exports = {
  id: 'usa', name: 'Estados Unidos (iptv-org)', collect, spanishFeeds, MAJOR_NETWORKS, baseName, ALWAYS_SPANISH
};
