// Generación y lectura de listas M3U con atributos IPTV.
const { groupFor, slug } = require('./text');
const { isCountry } = require('./countries');

// País del canal para el M3U: el real si se conoce, la región si no.
const scopeOf = channel => (isCountry(channel.origin) ? channel.origin : (channel.country || 'LATAM'));

const escapeAttr = value => String(value ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();

// En `#EXTINF` la coma separa los atributos del nombre del canal: una coma en el
// nombre rompe la entrada en la mayoría de reproductores.
const escapeName = value => escapeAttr(value).replace(/,/g, ' ');

/**
 * Convierte canales en M3U extendido. Solo incluye canales con al menos una URL
 * reproducible. En este agregador todos los medios llegan ya resueltos desde las
 * listas (HLS/MPEG-TS), así que no se resuelven páginas: el archivo se escribe en
 * una sola pasada y en orden determinista.
 */
async function buildM3u(channels, {
  siteName = 'Agregador IPTV', siteUrl = '', epgUrl = ''
} = {}) {
  // `x-tvg-url` vacío desactiva la guía en la mayoría de reproductores; si hay
  // EPG se declara, y si no se omite el atributo en vez de dejarlo en blanco.
  const lines = [epgUrl ? `#EXTM3U x-tvg-url="${escapeAttr(epgUrl)}"` : '#EXTM3U'];
  let count = 0;

  // Un `tvg-id` puede venir de la EPG de la fuente y estar repetido entre
  // canales distintos ("13 Cultura" y "13C" comparten `13C.cl`). El id interno
  // del catálogo sí es único, así que solo se desambigua cuando el choque es
  // real: las señales del mismo canal conservan su id.
  //
  // El dueño se identifica por nombre: dos variantes del mismo canal pueden
  // compartir el id interno ("us-axn" para AXN Andes y AXN South) pero siguen
  // siendo canales distintos.
  const nombres = new Map();
  for (const channel of channels) {
    const base = channel.epgId || channel.id;
    if (!base) continue;
    const vistos = nombres.get(base) || new Set();
    // Se compara el nombre normalizado: la misma cadena llega escrita como
    // "Bigtime - Películas Gratis" y "Bigtime Peliculas Gratis".
    vistos.add(slug(channel.name || channel.id, 'canal'));
    nombres.set(base, vistos);
  }
  const compartido = base => (nombres.get(base) || new Set()).size > 1;

  // Escribir en orden, que es lo que hace determinista el archivo.
  for (const channel of channels) {
    const streams = [];
    for (const stream of channel.streams || []) {
      // Una entrada sin medio reproducible (`page`) no se publica: en un
      // reproductor sería una línea que no abre nada.
      if (stream.kind === 'page') continue;
      if (/^https?:\/\//i.test(stream.url || '')) streams.push(stream);
    }
    if (!streams.length) continue;
    for (const stream of streams) {
      // Si la lista de origen trae `tvg-id` (el que usa la EPG), se publica ese;
      // si no, el id interno del catálogo.
      const base = channel.epgId || channel.id;
      const tvgId = compartido(base) ? `${base}-${slug(channel.name || channel.id, 'canal')}` : base;
      lines.push(
        `#EXTINF:-1 tvg-id="${escapeAttr(tvgId)}" tvg-name="${escapeAttr(channel.name)}"` +
        // El grupo y el `tvg-country` usan el país real cuando se conoce
        // (`Argentina`/`AR`), y solo caen a la región (`Latinoamérica`/`LATAM`)
        // cuando la fuente no lo dice. Antes todo Latinoamérica salía como
        // "Latinoamérica" y los canales argentinos perdían su país en el M3U.
        ` tvg-logo="${escapeAttr(channel.logo || '')}" group-title="${escapeAttr(groupFor(scopeOf(channel), channel.category))}"` +
        ` tvg-country="${escapeAttr(scopeOf(channel))}"` +
        ` source="${escapeAttr(stream.source || channel.sources[0] || siteName)}",${escapeName(channel.name)}`
      );
      if (stream.referer) lines.push(`#EXTVLCOPT:http-referrer=${stream.referer}`);
      lines.push(`#EXTVLCOPT:http-user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36`);
      if (siteUrl) lines.push(`#EXTGRP:${escapeAttr(groupFor(scopeOf(channel), channel.category))}`);
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

module.exports = { buildM3u, parseM3u, groupFor };
