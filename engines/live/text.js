// Utilidades de texto compartidas por los recolectores.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+|#\d+);/gi, (match, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? match);
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const unescapeJs = value => String(value).replace(/\\\//g, '/').replace(/\\u0026/gi, '&');

/**
 * Normaliza un nombre de canal para mostrarlo y para agrupar duplicados:
 * marcas de calidad entre corchetes/paréntesis, sufijos de país y espacios.
 */
function cleanChannelName(raw = '') {
  return decodeHtml(raw)
    .replace(/\s*\[[^\]]{0,40}\]\s*/g, ' ')
    .replace(/\s*\((?:\d{3,4}p|HD|FHD|UHD|4K|SD|2K|Geo-blocked|Not 24\/7)\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clave estable para deduplicar el mismo canal entre fuentes. */
function channelKey(name, country) {
  const normalized = cleanChannelName(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${country || 'xx'}:${normalized || 'canal'}`;
}

/** Id seguro para usar en URLs de Stremio (`tt`-style no aplica a TV). */
function slug(value, fallback = 'canal') {
  const out = String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}

/** Grupos de la lista M3U a partir de país y categoría. */
function groupFor(country, category) {
  const base = country === 'ES' ? 'España' : country === 'LATAM' ? 'Latinoamérica' : (country || 'Internacional');
  return category ? `${base} · ${category}` : base;
}

module.exports = { decodeHtml, stripTags, unescapeJs, cleanChannelName, channelKey, slug, groupFor };
