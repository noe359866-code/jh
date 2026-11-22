// Recolector de globalfreetv.com (https://www.globalfreetv.com).
//
// El sitio es un SSR de TanStack: cada página de canal lleva el payload
// serializado (`streams:$R[16]=[$R[17]={id:…,channel_id:"La1.es",
// url:"https://….m3u8",http_referrer:null,user_agent:null},…]`) y el nombre en
// `channel:{…,name:"La 1",country:"ES",…}`. Las páginas de país usan `?page=N`.
const { cleanChannelName, channelKey, decodeHtml } = require('../text');
const { mapLimit } = require('../limit');

const BASE = 'https://www.globalfreetv.com';
const COUNTRIES = [
  ['ES', 'ES'], ['MX', 'LATAM'], ['AR', 'LATAM'], ['CO', 'LATAM'], ['CL', 'LATAM'],
  ['PE', 'LATAM']
];
const MAX_PAGES = 6;

/** Enlaces de canal (`La1.es`) de una página de país. */
function channelIds(html) {
  const ids = new Set();
  for (const match of String(html).matchAll(/\/channels\/([A-Za-z0-9._-]+)/g)) {
    if (match[1].includes('.')) ids.add(match[1]);
  }
  return [...ids];
}


/**
 * Devuelve el texto entre corchetes que empieza en `start` (el índice del `[`),
 * respetando cadenas y anidamiento. El payload SSR usa referencias `$R[n]`
 * dentro de los arrays, así que un `match` no codicioso cortaría de más.
 */
function sliceBalanced(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Bloque `streams:$R[n]=[…]` completo de una página de canal. */
function streamsBlock(text) {
  const match = /\bstreams:\$R\[\d+\]=/.exec(text);
  if (!match) return '';
  const start = text.indexOf('[', match.index + match[0].length - 1);
  return start < 0 ? '' : sliceBalanced(text, start);
}

/**
 * Extrae los medios de la página de un canal. El bloque `streams:` puede
 * contener varias fuentes; se conserva el `http_referrer` si existe porque
 * algunos CDN lo exigen.
 */
function parseChannel(html) {
  const text = String(html);
  const name = (text.match(/\bchannel:\$R\[\d+\]=\{[\s\S]{0,400}?\bname:"([^"]+)"/) || [])[1]
    || (text.match(/<title>([^<|]+?)(?: Live)?\s*[-|]/) || [])[1] || '';
  const country = (text.match(/\bchannel:\$R\[\d+\]=\{[\s\S]{0,400}?\bcountry:"([A-Z]{2})"/) || [])[1] || null;
  const logo = (text.match(/\bchannel:\$R\[\d+\]=\{[\s\S]{0,400}?\blogo:"([^"]*)"/) || [])[1] || null;
  const block = streamsBlock(text);
  const streams = [];
  for (const match of block.matchAll(/url:"([^"]+)"/g)) {
    const raw = decodeHtml(match[1]).replace(/\\\//g, '/');
    if (!/^https?:\/\//i.test(raw)) continue;
    const referer = (block.match(/http_referrer:"([^"]+)"/) || [])[1] || null;
    streams.push({ url: raw, referer: referer || undefined, source: 'globalfreetv.com' });
  }
  const status = (text.match(/\bstreamStatus:"([^"]+)"/) || [])[1] || null;
  return { name: cleanChannelName(name), country, logo: logo || null, streams, status };
}

async function collect({ get, onSource, maxChannelsPerCountry = 60 }) {
  const perCountry = await mapLimit(COUNTRIES, 6, async ([code, region]) => {
    const entries = [];
    const ids = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE}/countries/${code}${page > 1 ? `?page=${page}` : ''}`;
      let html;
      try {
        html = await get(url).then(r => r.text);
      } catch {
        break;
      }
      const found = channelIds(html);
      const before = ids.size;
      for (const id of found) ids.add(id);
      if (ids.size === before || !found.length) break;
    }
    const wanted = [...ids].slice(0, maxChannelsPerCountry);
    const parsed = await mapLimit(wanted, 6, async id => {
      try {
        return parseChannel(await get(`${BASE}/channels/${id}`).then(r => r.text));
      } catch {
        return null;
      }
    });
    let channels = 0;
    for (const info of parsed) {
      if (!info || !info.name || !info.streams.length) continue;
      channels++;
      entries.push({
        name: info.name,
        country: region,
        origin: info.country || code,
        category: 'Generalista',
        logo: info.logo,
        availability: info.status === 'available' ? 'online' : 'unknown',
        streams: info.streams.slice(0, 4),
        key: channelKey(info.name, region)
      });
    }
    if (onSource) onSource({ country: code, channels });
    return entries;
  });
  return perCountry.flat();
}

module.exports = { id: 'globalfreetv', name: 'globalfreetv.com', collect, parseChannel, channelIds, streamsBlock, sliceBalanced, COUNTRIES };
