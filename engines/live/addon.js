// Manifiesto y endpoints Stremio para canales en directo.
//
// Tipo `tv`, ids propios (`es-la-1`, `latam-tudn`…). Los catálogos exponen solo
// canales con al menos una URL reproducible (o resoluble), y `skip` pagina de
// 100 en 100, que es el tamaño de página que Stremio solicita.
const { groupFor, slug } = require('./text');
const { COUNTRIES, countryName } = require('./countries');

const PAGE_SIZE = 100;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

// Subcategorías que se ofrecen dentro de cada país (solo si hay canales).
const COUNTRY_GENRES = ['Generalista', 'Deportes', 'Noticias', 'Infantil', 'Música', 'Cine y series'];

function manifest() {
  // El género se ofrece por país en «Todos» para poder filtrar sin cambiar de
  // catálogo. Se generan **solo los nombres de país** (`México`), no las 126
  // combinaciones país·categoría: el manifiesto completo pasaba de 8 KB y
  // Stremio puede rechazarlo. Las subcategorías van en el `extra` de cada país.
  const genres = ['España', 'Estados Unidos', 'Latinoamérica', ...COUNTRIES.map(country => country.name)];
  return {
    id: 'org.tvespanol.live',
    version: '3.4.0',
    name: 'TV en Español (directo)',
    description: 'Canales de televisión en español y de Estados Unidos, por país: España, México, Argentina, Colombia, Chile, Perú, Venezuela, Ecuador, Centroamérica, Caribe y más. Fuentes: eja.tv, iptvcat, TV Garden, Global Free TV, TVEnVivo, DaddyLive, Live24, CineCity, Telechancho, iptv-chile, Samsung TV Plus, Pluto TV, D9Kod e iptv-org.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    // Prefijo por país **y por región**: los canales cuya fuente no dice el país
    // llevan id `latam-…`, así que sin `latam-` Stremio rechazaría sus enlaces.
    idPrefixes: [...COUNTRIES.map(country => `${country.code.toLowerCase()}-`), 'latam-'],
    catalogs: [
      { type: 'tv', id: 'todos', name: 'TV · Todos los canales', extra: [{ name: 'genre', options: genres }, { name: 'skip' }] },
      // Una entrada por país, en el orden de `countries.js`.
      ...COUNTRIES.map(country => ({
        type: 'tv',
        id: `pais-${country.code.toLowerCase()}`,
        name: `TV · ${country.name}`,
        extra: [{ name: 'genre', options: COUNTRY_GENRES.map(genre => `${country.name} · ${genre}`) }, { name: 'skip' }]
      })),
      { type: 'tv', id: 'sinpais', name: 'TV · Sin país asignado', extra: [{ name: 'skip' }] },
      { type: 'tv', id: 'deportes', name: 'TV · Deportes', extra: [{ name: 'skip' }] },
      { type: 'tv', id: 'caidos', name: 'TV · Caídos (verificador)', extra: [{ name: 'skip' }] }
    ],
    behaviorHints: { configurable: false, configurationRequired: false }
  };
}

/** Categoría de un catálogo `pais-xx` → código de país, o `null`. */
function catalogCountry(id) {
  const match = String(id || '').match(/^pais-([a-z]{2})$/);
  return match ? match[1].toUpperCase() : null;
}

/** Canales que se publican: tienen al menos una vía de reproducción. */
function listed(channels) {
  return channels.filter(channel => channel.playable || (channel.streams || []).some(stream => stream.kind === 'page'));
}

function toMeta(channel) {
  const country = channelCountry(channel);
  const genres = [country, channel.category];
  return {
    id: channel.id,
    type: 'tv',
    name: channel.name,
    // Sin logo, Stremio muestra una tarjeta vacía. Un póster generado con las
    // iniciales y el color del país da algo reconocible sin inventar imágenes.
    poster: channel.logo || `https://placehold.co/300x300/1f2933/ffffff/png?text=${encodeURIComponent(initials(channel.name))}`,
    posterShape: 'square',
    genres: genres.filter(Boolean),
    description: [
      country,
      channel.language === 'en' ? 'emite en inglés' : null,
      channel.origin && channel.origin !== channel.country && !/^[a-z]{2}$/i.test(channel.origin)
        ? `origen: ${channel.origin}` : null,
      channel.category,
      channel.dead ? `⚠ señal caída (${channel.health && channel.health.error ? channel.health.error : 'no responde'})` : null,
      channel.unverified ? 'sin verificar (no se pudo comprobar)' : null,
      channel.geoBlocked ? 'puede estar geobloqueado' : null,
      `fuentes: ${channel.sources.join(', ')}`
    ].filter(Boolean).join(' · ')
  };
}

/** Iniciales del canal para el póster de reserva (`La 1` → `L1`). */
function initials(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'TV';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Etiqueta de país para mostrar de un canal. */
function channelCountry(channel) {
  return countryName(channel.origin) || countryName(channel.country)
    || (channel.country === 'ES' ? 'España' : channel.country === 'US' ? 'Estados Unidos' : 'Latinoamérica');
}

/**
 * ¿El canal cae en este género? Acepta dos formas:
 *   - `España`, `Estados Unidos`, `Latinoamérica` → por país/región.
 *   - `México · Deportes` → país y categoría a la vez.
 */
function matchesGenre(channel, genre) {
  const [first, second] = String(genre).split(' · ');
  const label = channelCountry(channel);
  if (!second) {
    // Género sin categoría: o es un país/región, o es una categoría suelta.
    if (first === label) return true;
    return channel.category === first || (first === 'Deportes' && /deporte|sport/i.test(channel.category || ''));
  }
  if (first !== label) return false;
  if (second === channel.category) return true;
  return second === 'Deportes' && /deporte|sport/i.test(channel.category || '');
}

/** Catálogo paginado con filtro por `genre`. */
function catalog(channels, id, genre, skip = 0) {
  // El catálogo normal oculta los caídos; `caidos` es justo lo contrario, para
  // poder verlos en Stremio con el motivo.
  let items = id === 'caidos'
    ? (channels || []).filter(channel => channel.dead)
    : listed(channels).filter(channel => !channel.dead);
  const country = catalogCountry(id);
  if (country) items = items.filter(channel => (channel.origin || channel.country) === country);
  if (id === 'espana') items = items.filter(channel => channel.country === 'ES');
  if (id === 'usa' || id === 'us') items = items.filter(channel => channel.country === 'US');
  // `sinpais`: los canales cuya fuente no declara país (la mayoría de Pluto y
  // CineCity). `latinoamerica` se queda como sinónimo de la región completa.
  if (id === 'sinpais') items = items.filter(channel => !channel.origin || channel.origin === 'Internacional');
  if (id === 'latinoamerica') items = items.filter(channel => channel.country === 'LATAM');
  if (id === 'deportes') items = items.filter(channel => /deporte|sport/i.test(channel.category));
  if (genre) items = items.filter(channel => matchesGenre(channel, genre));
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
  // Canal marcado caído por el verificador: no se ofrecen medios que no
  // responden. Si tiene web de origen, se deja como último recurso.
  if (channel.dead) {
    if (channel.externalUrl) {
      return [{
        name: 'Web original',
        title: `${channel.name} · señal caída (${channel.health ? channel.health.error || 'no responde' : 'no responde'})`,
        externalUrl: channel.externalUrl
      }];
    }
    return [];
  }
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

module.exports = {
  manifest, catalog, streams, findChannel, toMeta, listed, initials, PAGE_SIZE, ID_PATTERN, slug
};
