// Fuentes basadas en listas M3U publicadas por terceros.
//
// Cada entrada define una lista `raw` (GitHub, GitHub Pages…) o una lista
// generada a partir de un JSON/YAML. El parser es el mismo `parseM3u` que usa
// el resto del proyecto y las URLs se publican tal cual: el verificador
// (engines/live/checker.js) es quien comprueba que responden antes de que
// lleguen a las listas finales.
//
// Los canales se agrupan por país cuando la lista lo indica (`tvg-id` con
// prefijo, nombre con bandera/sufijo) y si no se puede deducir quedan como
// internacionales: nunca se descarta un canal en español por no saber el país.
const { parseM3u } = require('../m3u');
const { cleanChannelName, channelKey } = require('../text');

// País por bandera y por sufijo habitual en estas listas.
const FLAGS = {
  '🇪🇸': 'ES', '🇲🇽': 'MX', '🇦🇷': 'AR', '🇨🇱': 'CL', '🇨🇴': 'CO', '🇵🇪': 'PE', '🇻🇪': 'VE',
  '🇪🇨': 'EC', '🇬🇹': 'GT', '🇭🇳': 'HN', '🇸🇻': 'SV', '🇳🇮': 'NI', '🇨🇷': 'CR', '🇵🇦': 'PA',
  '🇨🇺': 'CU', '🇩🇴': 'DO', '🇵🇷': 'PR', '🇺🇾': 'UY', '🇵🇾': 'PY', '🇧🇴': 'BO'
};
const HISPANIC = new Set(Object.values(FLAGS));

// Nombres de país que usan las listas en `group-title`.
const COUNTRY_NAMES = {
  espana: 'ES', 'españa': 'ES', spain: 'ES',
  mexico: 'MX', 'méxico': 'MX', argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE', 'perú': 'PE',
  venezuela: 'VE', ecuador: 'EC', guatemala: 'GT', honduras: 'HN', 'el salvador': 'SV', nicaragua: 'NI',
  'costa rica': 'CR', panama: 'PA', 'panamá': 'PA', cuba: 'CU', 'republica dominicana': 'DO',
  'república dominicana': 'DO', 'puerto rico': 'PR', uruguay: 'UY', paraguay: 'PY', bolivia: 'BO'
};
const FLAG_PATTERN = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

// Idiomas que no son español: si la entrada lo declara, se descarta.
const OTHER_LANGUAGES = new Set(['por', 'pt', 'pt-br', 'eng', 'en', 'fra', 'fr', 'deu', 'de', 'ita', 'it']);

// Acortadores/redireccionadores que sirven un HLS aunque la URL no acabe en
// `.m3u8`. Se tratan como medio directo: `http.js` sigue el 302 y el
// verificador comprueba la firma `#EXTM3U` en el destino final.
const REDIRECTORS = /^https?:\/\/(jmp2\.uk|s\.id|bit\.ly|tinyurl\.com|is\.gd|rb\.gy|t\.co)\//i;

function countryFromText(text) {
  const value = String(text || '');
  // Algunas listas ponen emoji delante: "🌍 Mexico", "🏙️ Buenos Aires".
  const plain = value
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const named = COUNTRY_NAMES[plain];
  if (named) return named;
  // "Buenos Aires" y otras regiones de Argentina.
  if (/buenos aires|cordoba|córdoba|rosario|mendoza/.test(plain)) return 'AR';
  const flag = value.match(FLAG_PATTERN);
  if (flag) {
    for (const found of flag) if (FLAGS[found]) return FLAGS[found];
  }
  // `LA 1 (ES)`, `Mega [CL]`, `La 1 ES`.
  const suffix = value.match(/[([\s]([A-Z]{2})[)\]\s]*$/);
  if (suffix && HISPANIC.has(suffix[1])) return suffix[1];
  return null;
}

/** Convierte una lista M3U en entradas del catálogo. */
function parsePlaylist(text, { source, defaultCountry = null } = {}) {
  const entries = [];
  for (const item of parseM3u(text)) {
    const url = String(item.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    // Los `.m3u8`/`.mp4`/`.ts` y los redirectores conocidos son medio directo;
    // el resto se guarda como página por si un extractor puede resolverlo.
    const kind = /\.(m3u8|mp4|ts|m3u)(\?|$)/i.test(url) || REDIRECTORS.test(url) ? 'hls' : 'page';
    const rawName = item.name || item.attrs['tvg-name'] || '';
    // El país se busca en el nombre ORIGINAL: `cleanChannelName` recorta los
    // sufijos entre corchetes (`Mega [CL]` → `Mega`).
    const country = countryFromText(rawName)
      || countryFromText(item.attrs['tvg-country'])
      || countryFromText(item.attrs['group-title'])
      || (/(^|[_-])es$/i.test(item.attrs['tvg-id'] || '') ? 'ES' : null)
      || defaultCountry;
    // `cleanChannelName` no toca emojis: se quitan aquí para que el nombre quede
    // limpio en Stremio (`Azteca 🇲🇽` → `Azteca`).
    const name = cleanChannelName(rawName)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ')
      .replace(/^[\s☆✔️•·-]+/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;
    const language = String(item.attrs['tvg-language'] || '').toLowerCase();
    if (OTHER_LANGUAGES.has(language)) continue;
    entries.push({
      name,
      // El catálogo trabaja con dos regiones; `origin` guarda el país real.
      country: (country || defaultCountry) === 'ES' ? 'ES' : 'LATAM',
      origin: country || defaultCountry || 'Internacional',
      category: item.attrs['group-title'] || 'Generalista',
      logo: /^https?:\/\//i.test(item.attrs['tvg-logo'] || '') ? item.attrs['tvg-logo'] : null,
      streams: [{ url, kind, source, httpReferrer: item.referer || null }],
      language: language || null
    });
  }
  return entries;
}

/**
 * Recolector genérico para una lista. `urls` permite varias (una por país) y
 * `allowEmpty` documenta que una lista vacía no es un error del recolector.
 */
function createPlaylistSource({ id, name, urls, defaultCountry = null, maxEntries = 4000, labels = {} }) {
  async function collect({ get, onSource }) {
    const all = [];
    const counts = {};
    for (const url of urls) {
      let text;
      try {
        // `allowHttp` cubre listas servidas por HTTP (algunas IPTV lo hacen).
        text = await get(url, { allowHttp: true, maxBytes: 8 * 1024 * 1024, accept: 'application/x-mpegURL,text/plain,*/*' }).then(response => response.text);
      } catch (error) {
        counts[labels[url] || url] = `error: ${String(error.message).slice(0, 60)}`;
        continue;
      }
      const parsed = parsePlaylist(text, { source: name, defaultCountry });
      counts[labels[url] || url] = parsed.length;
      all.push(...parsed);
    }
    if (onSource) onSource({ playlists: counts });

    // Deduplicar por URL de medio: estas listas repiten mucho.
    const seen = new Set();
    const unique = [];
    for (const entry of all) {
      const key = entry.streams[0].url;
      if (seen.has(key)) continue;
      seen.add(key);
      entry.key = channelKey(entry.name, entry.origin === 'ES' ? 'ES' : HISPANIC.has(entry.origin) ? 'LATAM' : 'INT');
      unique.push(entry);
      if (unique.length >= maxEntries) break;
    }
    return unique;
  }

  return { id, name, collect };
}

module.exports = {
  createPlaylistSource,
  parsePlaylist,
  countryFromText,
  FLAGS,
  HISPANIC,
  OTHER_LANGUAGES
};
