// Manifiesto y endpoints Stremio para canales en directo.
//
// Tipo `tv`, ids propios (`es-la-1`, `latam-tudn`…). Los catálogos exponen solo
// canales con al menos una URL reproducible (o resoluble), y `skip` pagina de
// 100 en 100, que es el tamaño de página que Stremio solicita.
const { groupFor, slug } = require('./text');

const PAGE_SIZE = 100;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function manifest() {
  const genres = ['España', 'Latinoamérica', 'España · Generalista', 'España · Deportes',
    'Latinoamérica · Generalista', 'Latinoamérica · Deportes', 'Latinoamérica · Infantil',
    'Latinoamérica · Noticias', 'Latinoamérica · Música', 'España · Noticias', 'España · Música'];
  return {
    id: 'org.tvespanol.live',
    version: '3.0.0',
    name: 'TV en Español (directo)',
    description: 'Canales de televisión en español (España y Latinoamérica) recopilados de eja.tv, iptvcat, TV Garden, Global Free TV, TVEnVivo, DaddyLive y Live24. Solo canales; los medios dudosos se marcan.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['es-', 'latam-'],
    catalogs: [
      { type: 'tv', id: 'todos', name: 'TV en español · Todos', extra: [{ name: 'genre', options: genres }, { name: 'skip' }] },
      { type: 'tv', id: 'espana', name: 'TV · España', extra: [{ name: 'skip' }] },
      { type: 'tv', id: 'latinoamerica', name: 'TV · Latinoamérica', extra: [{ name: 'skip' }] },
      { type: 'tv', id: 'deportes', name: 'TV · Deportes', extra: [{ name: 'skip' }] }
    ],
    behaviorHints: { configurable: false, configurationRequired: false }
  };
}

/** Canales que se publican: tienen al menos una vía de reproducción. */
function listed(channels) {
  return channels.filter(channel => channel.playable || (channel.streams || []).some(stream => stream.kind === 'page'));
}

function toMeta(channel) {
  const genres = [channel.country === 'ES' ? 'España' : 'Latinoamérica', channel.category];
  return {
    id: channel.id,
    type: 'tv',
    name: channel.name,
    poster: channel.logo || undefined,
    posterShape: 'square',
    genres: genres.filter(Boolean),
    description: [
      channel.country === 'ES' ? 'España' : 'Latinoamérica',
      channel.origin && channel.origin !== channel.country && !/^[a-z]{2}$/i.test(channel.origin)
        ? `origen: ${channel.origin}` : null,
      channel.category,
      channel.geoBlocked ? 'puede estar geobloqueado' : null,
      `fuentes: ${channel.sources.join(', ')}`
    ].filter(Boolean).join(' · ')
  };
}

/** Catálogo paginado con filtro por `genre`. */
function catalog(channels, id, genre, skip = 0) {
  let items = listed(channels);
  if (id === 'espana') items = items.filter(channel => channel.country === 'ES');
  if (id === 'latinoamerica') items = items.filter(channel => channel.country === 'LATAM');
  if (id === 'deportes') items = items.filter(channel => /deporte|sport/i.test(channel.category));
  if (genre) {
    items = items.filter(channel => {
      const groups = [channel.country === 'ES' ? 'España' : 'Latinoamérica', groupFor(channel.country, channel.category)];
      return groups.includes(genre) || groupFor(channel.country, channel.category) === genre;
    });
  }
  const page = items.slice(skip, skip + PAGE_SIZE).map(toMeta);
  return { metas: page };
}

function streamTitle(stream, channel) {
  const bits = [stream.source || channel.sources[0] || 'fuente'];
  if (stream.kind === 'page') bits.push('se resuelve al reproducir');
  if (channel.geoBlocked) bits.push('posible geobloqueo');
  return bits.join(' · ');
}

/** Reproduce: directos tal cual; `page` se resuelve con el resolutor indicado. */
async function streams(channel, { resolvePage } = {}) {
  const out = [];
  for (const stream of channel.streams || []) {
    if (stream.kind === 'page') {
      if (!resolvePage) continue;
      let resolved = null;
      try {
        resolved = await resolvePage(stream);
      } catch {
        resolved = null;
      }
      if (!resolved) continue;
      out.push({
        url: resolved.url,
        name: channel.sources[0],
        title: `${channel.name} · ${stream.source || ''}`.trim(),
        behaviorHints: {
          notWebReady: true,
          ...(resolved.referer ? { proxyHeaders: { request: { Referer: resolved.referer } } } : {})
        }
      });
      continue;
    }
    if (!/^https?:\/\//i.test(stream.url || '')) continue;
    out.push({
      url: stream.url,
      name: stream.source || channel.sources[0],
      title: `${channel.name} · ${stream.source || ''}`.trim(),
      behaviorHints: stream.referer ? { proxyHeaders: { request: { Referer: stream.referer } } } : undefined
    });
  }
  if (!out.length && channel.externalUrl) {
    out.push({
      name: 'Web original',
      title: channel.info || 'Ver en la web de origen',
      externalUrl: channel.externalUrl
    });
  }
  return out;
}

function findChannel(channels, id) {
  if (!ID_PATTERN.test(String(id || ''))) return null;
  return channels.find(channel => channel.id === id) || null;
}

module.exports = { manifest, catalog, streams, findChannel, toMeta, listed, PAGE_SIZE, ID_PATTERN, slug };
