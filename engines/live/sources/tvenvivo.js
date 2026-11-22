// Recolector de tvenvivo.org (https://www.tvenvivo.org).
//
// Sus canales no publican HLS en el HTML: cada página de canal apunta a
// `/live[N]/core.php?canal=<slug>`, que devuelve un iframe firmado del host de
// reproducción, y ese iframe expone `var src = "https:/…/index.m3u8?token=…"`.
// Por eso la fuente se marca como `page`: se resuelve al reproducir/M3U.
const { cleanChannelName, channelKey, stripTags } = require('../text');

const BASE = 'https://www.tvenvivo.org';

/** Canales del listado de portada: enlaces `*-en-vivo-online.php`. */
function parseHome(html) {
  const channels = [];
  const seen = new Set();
  const linkRe = /<a\b([^>]*href="([^"]*?\/[a-z0-9-]+-en-vivo-online\.php)"[^>]*)>([\s\S]{0,600}?)<\/a>/gi;
  for (const match of String(html).matchAll(linkRe)) {
    const pageUrl = new URL(match[2], BASE).href;
    if (seen.has(pageUrl)) continue;
    const inner = match[3];
    const fromImage = (inner.match(/alt="([^"]+)"/i) || [])[1]
      || (inner.match(/\/imge\/([^"/]+)\.(?:webp|png|jpg)/i) || [])[1] || '';
    const name = cleanChannelName(stripTags(inner) || fromImage || '');
    if (!name || /^ver\s/i.test(name)) continue;
    seen.add(pageUrl);
    const logo = (inner.match(/src="([^"]+\.(?:webp|png|jpg|jpeg|svg))"/i) || [])[1];
    channels.push({
      name,
      pageUrl,
      slug: pageUrl.split('/').pop().replace(/-en-vivo-online\.php$/i, ''),
      logo: logo ? new URL(logo, BASE).href : null
    });
  }
  return channels;
}

/** Parámetro `canal=` de los reproductores internos de la página. */
function canalFromPage(html) {
  return (String(html).match(/\/live\d?\/core\.php\?canal=([a-z0-9-]+)/i) || [])[1] || null;
}

/** Iframe firmado devuelto por `core.php`. */
function iframeFromCore(html) {
  const raw = (String(html).match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1];
  return raw ? raw.replace(/&amp;/g, '&') : null;
}

/** `var src = "https:\/\/…m3u8?token=…"` (con barras escapadas). */
function streamFromEmbed(html) {
  const text = String(html);
  const quoted = text.match(/var\s+src\s*=\s*"([^"]+)"/)
    || text.match(/["'](https?:\\?\/\\?\/[^"'<>\s]+?\.m3u8[^"'<>\s]*)["']/);
  if (!quoted) return null;
  const url = quoted[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
  return /^https?:\/\//i.test(url) ? url : null;
}

async function collect({ get, maxPages = 3, onSource }) {
  const home = await get(BASE + '/').then(r => r.text);
  const channels = parseHome(home).slice(0, maxPages * 100);
  const entries = channels.map(channel => ({
    name: channel.name,
    country: 'ES',
    origin: 'tvenvivo.org',
    category: 'Generalista',
    logo: channel.logo,
    streams: [{ url: channel.pageUrl, kind: 'page', source: 'tvenvivo.org' }],
    key: channelKey(channel.name, 'ES')
  }));
  if (onSource) onSource({ channels: entries.length });
  return entries;
}

/**
 * Cadena de resolución: página → core.php → iframe → `var src` HLS.
 * Devuelve `null` si algún paso no expone el medio.
 */
async function resolve(pageUrl, { get }) {
  const page = await get(pageUrl, { referer: BASE + '/' });
  const canal = canalFromPage(page.text) || pageUrl.split('/').pop().replace(/-en-vivo-online\.php$/i, '');
  for (const variant of ['live', 'live2', 'live3']) {
    const coreUrl = `${BASE}/${variant}/core.php?canal=${encodeURIComponent(canal)}`;
    let core;
    try {
      core = await get(coreUrl, { referer: pageUrl });
    } catch {
      continue;
    }
    const iframe = iframeFromCore(core.text);
    if (!iframe) continue;
    let embed;
    try {
      embed = await get(iframe, { referer: coreUrl });
    } catch {
      continue;
    }
    const url = streamFromEmbed(embed.text);
    if (url) return { url, referer: new URL(iframe).origin + '/' };
  }
  return null;
}

module.exports = { id: 'tvenvivo', name: 'tvenvivo.org', collect, resolve, parseHome, canalFromPage, iframeFromCore, streamFromEmbed };
