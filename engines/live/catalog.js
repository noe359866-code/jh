// Catálogo de canales en español: agrega las fuentes, deduplica por nombre y
// mantiene una caché con TTL. Los fallos de una fuente no ocultan las demás.
const { get } = require('./http');
const { MODE } = require('./sources');
const { slug } = require('./text');
const { isCountry, countryOf, regionOf } = require('./countries');
const { countryFromText } = require('./sources/playlist');
const { applyReport, summarize } = require('./checker');

const TTL_MS = 30 * 60 * 1000;

/**
 * Id estable y válido para Stremio: el patrón del SDK admite 80 caracteres y un
 * nombre largo lo superaba, con lo que `findChannel` rechazaba el canal y no se
 * podía abrir. Si hay colisión se añade un sufijo numérico.
 */
function uniqueId(base, byId) {
  let candidate = base.slice(0, 80).replace(/-+$/, '') || 'canal';
  if (!byId.has(candidate)) return candidate;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const next = `${candidate.slice(0, 80 - suffix.length)}${suffix}`;
    if (!byId.has(next)) return next;
  }
}

/**
 * Recuentos del catálogo. `es`/`latam` cuentan regiones (compatibles con lo que
 * ya había); `paises` cuenta los canales con país identificado.
 */
function countsOf(channels) {
  return {
    total: channels.length,
    playable: channels.filter(channel => channel.playable).length,
    dead: channels.filter(channel => channel.dead).length,
    alive: channels.filter(channel => !channel.dead).length,
    es: channels.filter(channel => channel.country === 'ES').length,
    latam: channels.filter(channel => channel.country === 'LATAM').length,
    us: channels.filter(channel => channel.country === 'US').length,
    paises: channels.filter(channel => isCountry(channel.origin)).length
  };
}

/** Une las fuentes conservando el orden y agrupando los streams por canal. */
function mergeSources(results) {
  const byKey = new Map();
  for (const result of results) {
    if (!result || !Array.isArray(result.entries)) continue;
    for (const entry of result.entries) {
      // Una fuente puede devolver una entrada a medio construir (sin nombre o
      // sin `streams`): se salta en lugar de romper la recolección entera.
      if (!entry || !entry.name || !Array.isArray(entry.streams)) continue;
      // Una fuente puede devolver `null` en la lista de señales: se filtra antes
      // de tocarla, o el catálogo entero revienta por una entrada rota.
      const streams = entry.streams.filter(stream => stream && typeof stream === 'object');
      // Cada fuente nombra el país a su manera (`cl`, `CL`, `Chile`, `Mexico`).
      // Se normaliza aquí, en el único punto por el que pasan todas, para que
      // las categorías por país no se fragmenten. Si la fuente no da país, se
      // intenta deducir del nombre del canal.
      const origin = countryOf(entry.origin) || countryFromText(entry.name) || null;
      const region = origin ? regionOf(origin) : (entry.country || 'LATAM');
      // La clave se calcula siempre igual. Antes se respetaba la de la fuente, y
      // dos fuentes con criterios distintos (`LATAM:canal-5` y `MX:canal-5`)
      // dejaban **dos canales con el mismo id**, con lo que Stremio abría el
      // primero y el otro quedaba inaccesible.
      const key = `${origin || region}:${slug(entry.name)}`;
      const existing = byKey.get(key);
      if (existing) {
        const seen = new Set(existing.streams.map(stream => stream.url));
        for (const stream of streams) {
          if (!seen.has(stream.url)) {
            existing.streams.push(stream);
            seen.add(stream.url);
          }
        }
        existing.sources = [...new Set([...existing.sources, result.id])];
        existing.epgId = existing.epgId || entry.epgId || null;
        existing.logo = existing.logo || entry.logo || null;
        continue;
      }
      // El prefijo del id es el país real cuando se conoce (`mx-canal-5`); si
      // no, la región (`latam-…`). Stremio valida `idPrefixes` sobre esto.
      const scope = origin ? origin.toLowerCase() : String(region).toLowerCase();
      byKey.set(key, {
        id: uniqueId(`${scope}-${slug(entry.name)}`, byKey),
        key,
        name: entry.name,
        country: region,
        origin: origin || 'Internacional',
        epgId: entry.epgId || null,
        category: entry.category || 'Generalista',
        logo: entry.logo || null,
        geoBlocked: Boolean(entry.geoBlocked),
        externalUrl: entry.externalUrl || null,
        info: entry.info || null,
        sources: [result.id],
        streams: [...streams]
      });
    }
  }
  return [...byKey.values()]
    // `playable` = hay al menos un medio real (no basta una página a resolver).
    .map(channel => ({
      ...channel,
      playable: channel.streams.some(stream => stream.kind !== 'page' && /^https?:\/\//i.test(stream.url || ''))
    }))
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
  // Debe superar al presupuesto de extracción: son fases secuenciales.
  timeoutMs = 240000,
  // Extracción de HLS de las fuentes con embeds. `null` la desactiva; los tests
  // la inyectan o la omiten para no tocar la red.
  extract = null,
  extractBudgetMs = 90 * 1000
} = {}) {
  let cache = null;
  let pending = null;
  let healthReport = null;

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

    // Fase 2: resolver los embeds y dejar el HLS en el catálogo. Se hace después
    // de fusionar para resolver cada canal una sola vez (varias fuentes pueden
    // aportar el mismo canal) y para que el sondeo sea el mínimo.
    if (extract && channels.length) {
      const extractStarted = now();
      try {
        const extracted = await extract(channels, { get: url => fetchGet(url, { allowHttp: true }), budgetMs: extractBudgetMs });
        if (extracted) {
          status._extract = { ...extracted, ms: now() - extractStarted };
        }
      } catch (error) {
        // Nunca romper la recolección por un embed roto.
        status._extract = { ok: false, error: error.message, ms: now() - extractStarted };
      }
      // La extracción puede convertir una página en medio directo: recalcular.
      for (const channel of channels) {
        channel.playable = channel.streams.some(stream => stream.kind !== 'page' && /^https?:\/\//i.test(stream.url || ''));
      }
    }
    // Todas las fuentes pueden caer a la vez: en ese caso no se cachea un
    // catálogo vacío, porque sustituiría a uno bueno y publicaría listas M3U sin
    // canales. Se conserva el catálogo anterior y se informa del fallo.
    if (!channels.length) {
      const failed = Object.entries(status).filter(([, value]) => value && value.ok === false).map(([id, value]) => `${id}: ${value.error}`);
      const error = new Error(failed.length ? `Ninguna fuente respondió (${failed.join('; ')})` : 'Ninguna fuente devolvió canales');
      error.code = 'CATALOG_EMPTY';
      throw error;
    }
    return {
      channels,
      status,
      loadedAt: startedAt,
      ms: now() - startedAt,
      counts: countsOf(channels)
    };
  }

  // Informe de salud aplicado al catálogo (sin volver a recolectar). El resultado
  // se cachea junto al informe del que sale: `load()` puede llamarse decenas de
  // veces por minuto y no debe reconstruir la lista cada vez.
  let healthView = null;
  function withHealth(entry) {
    if (!entry) return entry;
    const health = healthReport;
    if (!health || !health.results) return entry;
    if (healthView && healthView.loadedAt === entry.loadedAt && healthView.report === health) return healthView.view;
    const channels = applyReport(entry.channels, health);
    // Los contadores salen del catálogo final, no del de antes de la extracción:
    // `playable`, `es` y `latam` se quedaban con los valores viejos (y `es`/`latam`
    // contaban regiones, no países).
    const view = {
      ...entry,
      channels,
      health: summarize(channels, health),
      counts: countsOf(channels)
    };
    healthView = { loadedAt: entry.loadedAt, report: health, view };
    return view;
  }

  async function load({ force = false } = {}) {
    if (!force && cache && now() - cache.loadedAt < ttlMs) return withHealth(cache);
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
      return withHealth(result);
    }).catch(error => {
      if (cache) {
        // Con caché previa se sirve la última copia buena durante un ciclo más.
        cache.stale = true;
        return { ...withHealth(cache), stale: true, staleReason: error.message };
      }
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }

  const self = {
    load,
    peek: () => withHealth(cache),
    reset: () => { cache = null; healthReport = null; healthView = null; },
    setHealth: (health) => {
      healthReport = health || null;
      healthView = null;
      if (cache) cache.stale = false;
    },
    health: () => healthReport
  };
  return self;
}

module.exports = { createCatalog, mergeSources, countsOf, uniqueId, TTL_MS };
