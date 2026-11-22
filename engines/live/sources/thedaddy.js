// Recolector de thedaddy.li (DaddyLiveHD, https://thedaddy.li).
//
// El sitio publica un listado 24/7 sin país ni idioma. Solo se incorporan los
// canales cuyo nombre coincide con señales españolas conocidas (lista curada).
// La resolución encadena `watch.php?id=N` → iframe `stream/stream-N.php` →
// iframe del reproductor (`dembed.st/...`) → `const SRC = "https://….m3u8"`.
// El CDN de ese reproductor exige `Referer`, que se propaga al reproductor.
const { cleanChannelName, channelKey, stripTags } = require('../text');

const BASE = 'https://thedaddy.li';
const LIST_PATH = '/24-7-channels.php';

// Señales españolas habituales en el listado 24/7 (nombres normalizados).
const SPANISH_SIGNALS = [
  /^la\s*1(\s|$)/i, /^la\s*2(\s|$)/i, /^24\s*h(oras)?(\s|$)/i, /teledeporte/i, /^rtve/i,
  /^antena\s*3/i, /^cuatro(\s|$)/i, /^telecinco/i, /^la\s*sexta/i, /^neox/i, /^nova(\s|$)/i,
  /^fdf/i, /^divinity/i, /^energy(\s|$)/i, /^mega(\s|$)/i, /^dkiss/i, /^ten(\s|$)/i, /^dmax/i,
  /^movistar/i, /^m\+\s/i, /^dazn/i, /^gol(\s|$)/i, /^laliga/i, /^vamos(\s|$)/i, /^real\s*madrid/i,
  /^barca\s*tv/i, /^betis/i, /^sevilla\s*fc/i, /^canal\s*sur/i, /^tv3(\s|$)/i, /^etb/i,
  /^a\s*punt/i, /^aragon\s*tv/i, /^telemadrid/i, /^castilla/i, /^extremadura/i, /^andalucia/i,
  /^canarias/i, /^galicia/i, /^tv\s*galicia/i, /^c\s*tv(\s|$)/i, /^canal\s*33/i, /^canal\s*7/i,
  /^iberalia/i, /^caza\s*y\s*pesca/i, /^toros/i, /^tenis/i, /^esport3/i, /^sport3/i
];

/** Tarjetas `a.card[href="/watch.php?id=N"]`. */
function parseList(html) {
  const items = [];
  const text = String(html);
  const cardRe = /<a\b[^>]*href="\/watch\.php\?id=(\d+)"[^>]*>([\s\S]{0,1200}?)<\/a>/gi;
  for (const match of text.matchAll(cardRe)) {
    const body = match[2];
    const title = (body.match(/<div class="card__title">([\s\S]*?)<\/div>/) || [])[1]
      || (match[0].match(/data-title="([^"]+)"/) || [])[1] || '';
    const name = cleanChannelName(stripTags(title));
    if (name) items.push({ id: Number(match[1]), name });
  }
  if (!items.length) {
    for (const match of text.matchAll(/watch\.php\?id=(\d+)"[^>]*title="([^"]+)"/g)) {
      items.push({ id: Number(match[1]), name: cleanChannelName(match[2]) });
    }
  }
  return items;
}

function isSpanishSignal(name) {
  return SPANISH_SIGNALS.some(pattern => pattern.test(name.replace(/\s+/g, ' ').trim()));
}

function iframeUrl(html) {
  return (String(html).match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1]?.replace(/&amp;/g, '&') || null;
}

function srcFromEmbed(html) {
  const match = String(html).match(/(?:const|var|let)\s+SRC\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i)
    || String(html).match(/["'](https?:[^"'<>\s]+?\.m3u8[^"'<>\s]*)["']/i);
  return match ? match[1] : null;
}

async function collect({ get, onSource }) {
  const html = await get(BASE + LIST_PATH).then(r => r.text);
  const items = parseList(html).filter(item => isSpanishSignal(item.name));
  const entries = items.map(item => ({
    name: item.name,
    country: 'ES',
    origin: 'thedaddy.li',
    category: 'Deportes',
    streams: [{ url: `${BASE}/watch.php?id=${item.id}`, kind: 'page', source: 'thedaddy.li' }],
    key: channelKey(item.name, 'ES')
  }));
  if (onSource) onSource({ listed: items.length });
  return entries;
}

/** watch.php → stream-N.php → embed → `SRC` (tres saltos, Referer en cada uno). */
async function resolve(watchUrl, { get }) {
  const watch = await get(watchUrl, { referer: BASE + '/' });
  const first = iframeUrl(watch.text);
  if (!first) return null;
  const player = await get(new URL(first, watchUrl).href, { referer: watchUrl });
  const second = iframeUrl(player.text);
  if (!second) return null;
  const embedUrl = new URL(second, player.url).href;
  const embed = await get(embedUrl, { referer: player.url });
  const url = srcFromEmbed(embed.text);
  if (!url) return null;
  return { url, referer: new URL(embedUrl).origin + '/' };
}

module.exports = { id: 'thedaddy', name: 'thedaddy.li', collect, resolve, parseList, isSpanishSignal, srcFromEmbed };
