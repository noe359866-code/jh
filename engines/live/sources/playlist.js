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
const { regionOf, isCountry } = require('../countries');

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



// Nombres (en inglés) de países que NO son de habla hispana, tal como los usan
// las listas mundiales en `group-title`/`tvg-country`. Devuelven un código que
// no está en `COUNTRIES`, así que el catálogo los deja fuera.
const FOREIGN_COUNTRIES = {
  italy: 'IT', poland: 'PL', hungary: 'HU', greece: 'GR', russia: 'RU', uk: 'GB',
  'united kingdom': 'GB', ukraine: 'UA', mongolia: 'MN', 'united arab emirates': 'AE',
  germany: 'DE', france: 'FR', india: 'IN', 'north macedonia': 'MK', finland: 'FI',
  usa: 'US', 'united states': 'US', 'czech republic': 'CZ', australia: 'AU', croatia: 'HR',
  iran: 'IR', korea: 'KR', 'south korea': 'KR', china: 'CN', japan: 'JP', canada: 'CA',
  somalia: 'SO', belarus: 'BY', ireland: 'IE', albania: 'AL', 'bosnia and herzegovina': 'BA',
  turkey: 'TR', lebanon: 'LB', portugal: 'PT', romania: 'RO', iraq: 'IQ', 'saudi arabia': 'SA',
  sweden: 'SE', netherlands: 'NL', taiwan: 'TW', denmark: 'DK', egypt: 'EG', nigeria: 'NG',
  qatar: 'QA', azerbaijan: 'AZ', brazil: 'BR', georgia: 'GE', belgium: 'BE', lithuania: 'LT',
  austria: 'AT', serbia: 'RS', estonia: 'EE', israel: 'IL', slovakia: 'SK', turkmenistan: 'TM',
  bulgaria: 'BG', cyprus: 'CY', moldova: 'MD', norway: 'NO', switzerland: 'CH',
  trinidad: 'TT', 'hong kong': 'HK', kenya: 'KE', latvia: 'LV', macau: 'MO',
  montenegro: 'ME', armenia: 'AM', iceland: 'IS', indonesia: 'ID', kazakhstan: 'KZ',
  luxembourg: 'LU', malta: 'MT', 'north korea': 'KP', chad: 'TD', 'faroe islands': 'FO',
  greenland: 'GL', monaco: 'MC', 'san marino': 'SM', andorra: 'AD', kosovo: 'XK', slovenia: 'SI'
};
const FOREIGN_CODES = new Set(Object.values(FOREIGN_COUNTRIES));

// Idiomas que no son español: si la entrada lo declara, se descarta.
const OTHER_LANGUAGES = new Set(['por', 'pt', 'pt-br', 'eng', 'en', 'fra', 'fr', 'deu', 'de', 'ita', 'it']);

// Idiomas en los que emite un canal en español (código ISO 639-1/2 y variantes
// que usan las listas). `tvg-language` con otro valor descarta la entrada.
const SPANISH_LANGUAGES = new Set(['es', 'es-es', 'es-ar', 'es-mx', 'spa', 'spanish', 'español', 'castellano']);

// `group-title` de las listas mezcla país (`Italy`), categoría real (`News`) y
// país+categoría (`News (AR)`). Se mapea a las categorías que ofrece el addon;
// lo que es un país se deja en `null` para no acabar con "Italy" de categoría.
const CATEGORY_PATTERNS = [
  [/\b(deportes?|deportiv[oa]s?|sports?|futbol|fútbol|esport)\b/i, 'Deportes'],
  [/\b(noticias?|news|informativ[oa]s?|actualidad)\b/i, 'Noticias'],
  [/\b(infantil|kids?|children|ni[nñ]os|juvenil|cartoon|anime)\b/i, 'Infantil'],
  [/\b(m[uú]sica|music|musical)\b/i, 'Música'],
  [/\b(cine|pel[ií]culas?|movies?|series|novelas|film|cinema)\b/i, 'Cine y series'],
  [/\b(documentales?|documentar(y|ies))\b/i, 'Documentales'],
  [/\b(cultura|cultural|arte)\b/i, 'Cultura'],
  [/\b(generalistas?|general|variedades|entretenimiento)\b/i, 'Generalista']
];

/**
 * Convierte el `group-title` de una lista en una categoría del catálogo.
 * Devuelve `null` cuando el grupo es el nombre de un país (`Italy`, `Chile`).
 */
function categoryFromGroup(group) {
  const raw = String(group || '').trim();
  if (!raw) return null;
  // Se mira el grupo sin el sufijo de país entre paréntesis: `News (AR)`.
  const withoutCountry = raw.replace(/\s*\([A-Z]{2}\)\s*$/, '').trim();
  if (COUNTRY_NAMES[withoutCountry.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()]) return null;
  for (const [pattern, name] of CATEGORY_PATTERNS) {
    if (pattern.test(withoutCountry) || pattern.test(raw)) return name;
  }
  return null;
}

// Acortadores/redireccionadores que sirven un HLS aunque la URL no acabe en
// `.m3u8`. Se tratan como medio directo: `http.js` sigue el 302 y el
// verificador comprueba la firma `#EXTM3U` en el destino final.
const REDIRECTORS = /^https?:\/\/(jmp2\.uk|s\.id|bit\.ly|tinyurl\.com|is\.gd|rb\.gy|t\.co)\//i;

function countryFromText(text) {
  const value = String(text || '');
  const upper = value.trim().toUpperCase();
  // Algunas listas ponen emoji delante: "🌍 Mexico", "🏙️ Buenos Aires".
  const plain = value
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const named = COUNTRY_NAMES[plain];
  if (named) return named;
  // Código ISO suelto (`tvg-country="ES"`, `tvg-country="MX"`), que es como lo
  // publican la mayoría de las listas.
  if (/^[a-z]{2}$/.test(plain) && isCountry(upper)) return upper;
  // País no hispano por su nombre en inglés (`Italy`, `Germany`). Saber que lo
  // es evita clasificarlo como internacional y colarlo en el catálogo cuando la
  // lista es mundial. No se publica: estas listas se filtran después.
  const foreign = FOREIGN_COUNTRIES[plain];
  if (foreign) return foreign;
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

/**
 * Normaliza una entrada M3U ya parseada a la forma del catálogo. Se reutiliza
 * desde las fuentes que necesitan filtrar antes (por idioma o por nombre) y
 * evita duplicar la limpieza de nombres, el país y el tipo de medio.
 */
function entryFromItem(item, { source, defaultCountry = null, forcedCountry = null, spanishOnly = false } = {}) {
  const url = String(item.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const kind = /\.(m3u8|mp4|ts|m3u)(\?|$)/i.test(url) || REDIRECTORS.test(url) ? 'hls' : 'page';
  const rawName = item.name || item.attrs['tvg-name'] || '';
  // El país se busca en el nombre ORIGINAL: `cleanChannelName` recorta los
  // sufijos entre corchetes (`Mega [CL]` → `Mega`).
  const country = forcedCountry
    || countryFromText(rawName)
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
  if (!name) return null;
  const language = String(item.attrs['tvg-language'] || '').toLowerCase();
  if (OTHER_LANGUAGES.has(language)) return null;
  // Lista mundial: solo entra lo que demuestra ser español. Sin `tvg-language`
  // hispano ni país hispano se descarta; si no, entrarían los dos mil canales en
  // albanés, italiano o árabe de una lista como la de Free-TV.
  if (spanishOnly && !SPANISH_LANGUAGES.has(language) && !HISPANIC.has(country)) {
    const latinName = /[\u00C0-\u024F]/.test(rawName);
    const unknownCountry = !country || country === 'Internacional' || !FOREIGN_CODES.has(country);
    // EE. UU. es el caso especial: sus canales hispanos lo dicen en el nombre
    // (`CNN en Español`, `Estrella TV`) y el resto emite en inglés, así que solo
    // se aceptan si el nombre lo delata.
    const spanishName = /espa[nñ]ol|spanish|latino|hispano/i.test(rawName);
    if (!(latinName && unknownCountry) && !(country === 'US' && spanishName)) return null;
  }
  return {
    name,
    // El catálogo trabaja con regiones (`ES`/`US`/`LATAM`); `origin` guarda el
    // país real, que es lo que alimenta las categorías por país.
    country: regionOf(country || defaultCountry),
    origin: country || defaultCountry || 'Internacional',
    // El `group-title` solo se usa como categoría si dice una categoría de
    // verdad; si es el país (`Italy`) se deja la genérica.
    category: categoryFromGroup(item.attrs['group-title']) || 'Generalista',
    // `tvg-id` original (`La1.TV`): es la clave que usa la EPG de la lista. Se
    // conserva para que la guía funcione; el id interno del addon es otro.
    epgId: item.attrs['tvg-id'] ? String(item.attrs['tvg-id']).replace(/@.*$/, '') : null,
    logo: /^https?:\/\//i.test(item.attrs['tvg-logo'] || '') ? item.attrs['tvg-logo'] : null,
    streams: [{ url, kind, source, httpReferrer: item.referer || null }],
    language: language || null
  };
}

/** Convierte una lista M3U en entradas del catálogo. */
function parsePlaylist(text, { source, defaultCountry = null, spanishOnly = false } = {}) {
  const entries = [];
  for (const item of parseM3u(text)) {
    const entry = entryFromItem(item, {
      source, defaultCountry, spanishOnly: spanishOnly || Boolean(defaultCountry)
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Recolector genérico para una lista. `urls` permite varias (una por país) y
 * `allowEmpty` documenta que una lista vacía no es un error del recolector.
 */
function createPlaylistSource({
  id, name, urls, defaultCountry = null, defaultCategory = null, spanishOnly = false,
  maxEntries = 4000, labels = {}
}) {
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
      const parsed = parsePlaylist(text, { source: name, defaultCountry, spanishOnly });
      if (defaultCategory) {
        for (const entry of parsed) {
          if (!entry.category || entry.category === 'Generalista') entry.category = defaultCategory;
        }
      }
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
      entry.key = channelKey(entry.name, HISPANIC.has(entry.origin) ? entry.origin : entry.country);
      unique.push(entry);
      if (unique.length >= maxEntries) break;
    }
    return unique;
  }

  return { id, name, collect };
}

module.exports = {
  categoryFromGroup,
  createPlaylistSource,
  entryFromItem,
  parsePlaylist,
  countryFromText,
  FLAGS,
  HISPANIC,
  OTHER_LANGUAGES
};
