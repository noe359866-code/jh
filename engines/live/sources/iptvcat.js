// Recolector de iptvcat.net (https://iptvcat.net).
//
// El listado por país muestra filas `tr.border-solid.belongs_to_<id>`; cada
// fila trae el nombre en `span.channel_name` (su atributo `data-content`
// contiene HTML con `>` por lo que hay que leer la etiqueta respetando comillas)
// y una minilista M3U firmada en `data-clipboard-text`. Esa minilista ya es un
// HLS válido que apunta al medio real, así que se puede entregar tal cual.
const { stripTags, cleanChannelName, channelKey } = require('../text');
const { mapLimit } = require('../limit');

const BASE = 'https://iptvcat.net';
// Incluye tanto España como los países hispanohablantes de América.
const COUNTRY_PATTERN = /^(spain|mexico|argentina|bolivia|chile|colombia|costa_rica|cuba|dominican_republic|ecuador|el_salvador|guatemala|honduras|nicaragua|panama|paraguay|peru|puerto_rico|uruguay|venezuela)__\d+$/;

function regionOf(slug) {
  return slug.startsWith('spain__') ? 'ES' : 'LATAM';
}

/** Devuelve los slugs de país (`spain__1`) presentes en la portada. */
function countrySlugs(html) {
  const slugs = new Set();
  for (const match of String(html).matchAll(/href="\/([a-z_]+__\d+)"/g)) {
    if (COUNTRY_PATTERN.test(match[1])) slugs.add(match[1]);
  }
  return [...slugs];
}

// Lee una etiqueta de apertura desde `start`, respetando atributos entrecomillados.
function readTag(html, start) {
  let quote = null;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return { end: i + 1, raw: html.slice(start, i + 1) };
    }
  }
  return { end: html.length, raw: html.slice(start) };
}

/** Nombre visible de un canal de una fila de iptvcat. */
function channelName(row) {
  const at = row.indexOf('class="channel_name"');
  if (at < 0) return '';
  const tag = readTag(row, row.lastIndexOf('<', at));
  return stripTags(row.slice(tag.end, row.indexOf('</span>', tag.end)));
}

/** Convierte el HTML del listado en canales con su minilista M3U. */
function parseRows(html) {
  const entries = [];
  const starts = [...String(html).matchAll(/<tr class="border-solid belongs_to_\d+">/g)].map(m => m.index);
  for (let i = 0; i < starts.length; i++) {
    const row = String(html).slice(starts[i], starts[i + 1] ?? starts[i] + 20000);
    const name = cleanChannelName(channelName(row));
    const url = (row.match(/data-clipboard-text="([^"]+)"/) || [])[1] || '';
    if (!name || !/^https:\/\/list\.iptvcat\.net\//.test(url)) continue;
    const countryTitle = (row.match(/<img[^>]+title="([^"]+)"/) || [])[1] || '';
    const geo = /geo-blocked/i.test(row);
    entries.push({
      name,
      country: null,
      origin: countryTitle,
      category: 'Generalista',
      geoBlocked: geo,
      streams: [{ url, source: 'iptvcat.net' }]
    });
  }
  return entries;
}

async function collect({ get, maxPages = 6, onSource }) {
  const home = await get(BASE + '/').then(r => r.text);
  const slugs = countrySlugs(home);
  const perCountry = await mapLimit(slugs, 8, async slug => {
    const entries = [];
    const region = regionOf(slug);
    let rows = 0;
    for (let page = 1; page <= maxPages; page++) {
      const path = page === 1 ? `/${slug}` : `/${slug}/${page}`;
      const html = await get(BASE + path).then(r => r.text);
      const parsed = parseRows(html);
      if (!parsed.length) break;
      rows += parsed.length;
      for (const entry of parsed) {
        entries.push({ ...entry, country: region, key: channelKey(entry.name, region) });
      }
      if (!new RegExp(`href="/${slug}/${page + 1}"`).test(html)) break;
    }
    if (onSource) onSource({ country: slug, rows });
    return entries;
  });
  return perCountry.flat();
}

module.exports = { id: 'iptvcat', name: 'iptvcat.net', collect, parseRows, countrySlugs, COUNTRY_PATTERN };
