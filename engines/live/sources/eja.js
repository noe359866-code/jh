// Recolector de eja.tv (https://eja.tv).
//
// Cada tarjeta del listado (`div.card.h-100`) contiene el nombre visible, los
// enlaces de país/idioma y un `<video>` con `<source src="...#poster">`. El
// fragmento tras `#` es solo el nombre del snapshot, no parte del medio.
const { decodeHtml, stripTags, cleanChannelName, channelKey } = require('../text');

const BASE = 'https://eja.tv/';
const PER_PAGE = 6;

// Países de habla hispana con su agrupación. `us` se consulta con
// `language=spa` porque su listado mezcla idiomas.
const COUNTRIES = [
  ['es', 'ES'], ['mx', 'LATAM'], ['ar', 'LATAM'], ['co', 'LATAM'], ['cl', 'LATAM'],
  ['pe', 'LATAM'], ['ve', 'LATAM'], ['ec', 'LATAM'], ['gt', 'LATAM'], ['hn', 'LATAM'],
  ['sv', 'LATAM'], ['ni', 'LATAM'], ['cr', 'LATAM'], ['pa', 'LATAM'], ['cu', 'LATAM'],
  ['do', 'LATAM'], ['pr', 'LATAM'], ['uy', 'LATAM'], ['py', 'LATAM'], ['bo', 'LATAM'],
  ['us', 'LATAM']
];

const QUALITY = [['bi-badge-4k', '4K'], ['bi-badge-fhd', 'FHD'], ['bi-badge-hd', 'HD'], ['bi-badge-sd', 'SD']];

function listUrl(country, offset) {
  const params = new URLSearchParams({ country, language: country === 'us' ? 'spa' : '', category: '', search: '' });
  if (offset) params.set('offset', String(offset));
  return `${BASE}?${params.toString()}`;
}

/** Extrae las tarjetas de una página de listado. */
function parseCards(html) {
  const cards = [];
  for (const match of String(html).matchAll(/<div class="card h-100">([\s\S]*?)<\/video>/g)) {
    const block = match[1];
    const name = stripTags((block.match(/<span class="text-muted">([\s\S]*?)<\/span>/) || [])[1] || '');
    const source = (block.match(/<source\s+src="([^"]+)"/) || [])[1] || '';
    const poster = (block.match(/poster="([^"]+)"/) || [])[1] || '';
    const language = (block.match(/\?language=([a-z]{2,3})"/) || [])[1] || '';
    const country = (block.match(/\?country=([a-z]{2})"/) || [])[1] || '';
    if (!name || !source) continue;
    const url = decodeHtml(source).split('#')[0];
    if (!/^https?:\/\//i.test(url)) continue;
    const quality = (QUALITY.find(([icon]) => block.includes(icon)) || [])[1] || 'SD';
    cards.push({
      name: cleanChannelName(name),
      url,
      logo: poster ? new URL(poster, BASE).href : null,
      language,
      country,
      quality
    });
  }
  return cards;
}

function totalFrom(html) {
  const match = String(html).match(/(\d+)\s+live iptv channels/i);
  return match ? Number(match[1]) : null;
}

/**
 * Recorre el listado con el paginador `?offset=` (6 tarjetas por página) y
 * devuelve canales en español. `maxPages` acota las peticiones por país.
 */
async function collect({ get, maxPages = 8, onSource }) {
  const entries = [];
  for (const [code, region] of COUNTRIES) {
    let total = null;
    let empty = 0;
    for (let page = 0; page < maxPages; page++) {
      const html = await get(listUrl(code, page * PER_PAGE)).then(r => r.text);
      if (page === 0) total = totalFrom(html);
      const cards = parseCards(html);
      if (!cards.length) break;
      for (const card of cards) {
        if (card.language && card.language !== 'spa') continue;
        entries.push({
          name: card.name,
          country: region,
          origin: card.country || code,
          category: 'Generalista',
          logo: card.logo,
          quality: card.quality,
          streams: [{ url: card.url, source: 'eja.tv' }],
          key: channelKey(card.name, region)
        });
      }
      if (total && (page + 1) * PER_PAGE >= total) break;
      empty = 0;
      empty += cards.length ? 0 : 1;
    }
    if (onSource) onSource({ country: code, total });
  }
  return entries;
}

module.exports = { id: 'eja', name: 'eja.tv', collect, parseCards, listUrl, COUNTRIES };
