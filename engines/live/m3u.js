// Generación y lectura de listas M3U con atributos IPTV.
const { groupFor, slug } = require('./text');

const escapeAttr = value => String(value ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();

/**
 * Convierte canales en M3U extendido. Solo incluye canales con al menos una URL
 * reproducible; `resolve` permite convertir fuentes `kind:'page'` en medios
 * bajo demanda (devuelve `{ url, referer }` o `null`).
 */
async function buildM3u(channels, { resolve, siteName = 'TV en español', siteUrl = '' } = {}) {
  const lines = [`#EXTM3U x-tvg-url=""`];
  let count = 0;
  for (const channel of channels) {
    const streams = [];
    for (const stream of channel.streams || []) {
      if (stream.kind === 'page') {
        if (!resolve) continue;
        const resolved = await resolve(stream);
        if (resolved) streams.push({ url: resolved.url, referer: resolved.referer });
        continue;
      }
      if (/^https?:\/\//i.test(stream.url || '')) streams.push(stream);
    }
    if (!streams.length) continue;
    for (const stream of streams) {
      const tvgId = channel.id;
      lines.push(
        `#EXTINF:-1 tvg-id="${escapeAttr(tvgId)}" tvg-name="${escapeAttr(channel.name)}"` +
        ` tvg-logo="${escapeAttr(channel.logo || '')}" group-title="${escapeAttr(groupFor(channel.country, channel.category))}"` +
        ` tvg-country="${escapeAttr(channel.country === 'LATAM' ? 'LATAM' : channel.country)}"` +
        ` source="${escapeAttr(stream.source || channel.sources[0] || siteName)}",${escapeAttr(channel.name)}`
      );
      if (stream.referer) lines.push(`#EXTVLCOPT:http-referrer=${stream.referer}`);
      lines.push(`#EXTVLCOPT:http-user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36`);
      if (siteUrl) lines.push(`#EXTGRP:${escapeAttr(groupFor(channel.country, channel.category))}`);
      lines.push(stream.url);
      count++;
    }
  }
  return { body: lines.join('\n') + '\n', count };
}

/** Parser M3U permisivo (para depuración y tests). */
function parseM3u(text) {
  const items = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const match of line.matchAll(/([a-z-]+)="([^"]*)"/gi)) attrs[match[1]] = match[2];
      const name = line.slice(line.lastIndexOf(',') + 1).trim();
      current = { name, attrs };
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      if (current) {
        const [, key, value] = line.match(/^#EXTVLCOPT:([^=]+)=(.*)$/) || [];
        if (key === 'http-referrer') current.referer = value;
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (current) {
      items.push({ ...current, url: line });
      current = null;
    } else {
      items.push({ name: '', attrs: {}, url: line });
    }
  }
  return items;
}

/** Nombre de archivo estable por combinación país/categoría. */
function playlistName(country, category) {
  return slug([country, category].filter(Boolean).join('-'), 'tv');
}

module.exports = { buildM3u, parseM3u, playlistName, groupFor };
