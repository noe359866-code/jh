// Catálogo de canales en español: agrega las fuentes, deduplica por nombre y
// mantiene una caché con TTL. Los fallos de una fuente no ocultan las demás.
const { get } = require('./http');
const { MODE } = require('./sources');
const { slug } = require('./text');

const TTL_MS = 30 * 60 * 1000;

/** Une las fuentes conservando el orden y agrupando los streams por canal. */
function mergeSources(results) {
  const byKey = new Map();
  for (const result of results) {
    if (!result || !Array.isArray(result.entries)) continue;
    for (const entry of result.entries) {
      const key = entry.key || `${entry.country}:${slug(entry.name)}`;
      const existing = byKey.get(key);
      if (existing) {
        const seen = new Set(existing.streams.map(stream => stream.url));
        for (const stream of entry.streams) {
          if (!seen.has(stream.url)) {
            existing.streams.push(stream);
            seen.add(stream.url);
          }
        }
        existing.sources = [...new Set([...existing.sources, result.id])];
        existing.logo = existing.logo || entry.logo || null;
        continue;
      }
      byKey.set(key, {
        id: `${entry.country.toLowerCase()}-${slug(entry.name)}`,
        key,
        name: entry.name,
        country: entry.country || 'LATAM',
        origin: entry.origin || null,
        category: entry.category || 'Generalista',
        logo: entry.logo || null,
        geoBlocked: Boolean(entry.geoBlocked),
        externalUrl: entry.externalUrl || null,
        info: entry.info || null,
        sources: [result.id],
        streams: [...(entry.streams || [])]
      });
    }
  }
  return [...byKey.values()]
    .map(channel => ({ ...channel, playable: channel.streams.length > 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/**
 * Crea el catálogo con caché. `only` permite recolectar una sola fuente
 * (pruebas en vivo). Devuelve `{ refresh, channels, status, loadedAt }`.
 */
function createCatalog({
  fetchGet = get,
  sources,
  ttlMs = TTL_MS,
  now = Date.now,
  timeoutMs = 90000
} = {}) {
  let cache = null;
  let pending = null;

  async function refresh() {
    const startedAt = now();
    const results = [];
    const status = {};
    const workers = sources.map(async source => {
      const sourceStarted = now();
      try {
        const entries = await source.collect({
          get: (url, options) => fetchGet(url, { allowHttp: true, ...options }),
          onSource: detail => { status[source.id] = { ...(status[source.id] || {}), ...detail }; }
        });
        results.push({ id: source.id, entries });
        status[source.id] = {
          ...(status[source.id] || {}),
          mode: MODE[source.id] || 'direct',
          ok: true,
          entries: entries.length,
          ms: now() - sourceStarted
        };
      } catch (error) {
        status[source.id] = {
          ...(status[source.id] || {}),
          mode: MODE[source.id] || 'direct',
          ok: false,
          entries: 0,
          error: error.message,
          ms: now() - sourceStarted
        };
      }
    });
    await Promise.all(workers);
    const channels = mergeSources(results);
    return {
      channels,
      status,
      loadedAt: startedAt,
      ms: now() - startedAt,
      counts: {
        total: channels.length,
        playable: channels.filter(channel => channel.playable).length,
        es: channels.filter(channel => channel.country === 'ES').length,
        latam: channels.filter(channel => channel.country === 'LATAM').length
      }
    };
  }

  async function load({ force = false } = {}) {
    if (!force && cache && now() - cache.loadedAt < ttlMs) return cache;
    if (pending) return pending;
    pending = Promise.race([
      refresh(),
      new Promise((_, reject) => setTimeout(() => {
        const error = new Error('La recolección del catálogo tardó demasiado');
        error.code = 'CATALOG_TIMEOUT';
        reject(error);
      }, timeoutMs).unref?.())
    ]).then(result => {
      cache = result;
      return result;
    }).finally(() => { pending = null; });
    return pending;
  }

  return {
    load,
    peek: () => cache,
    reset: () => { cache = null; }
  };
}

module.exports = { createCatalog, mergeSources, TTL_MS };
