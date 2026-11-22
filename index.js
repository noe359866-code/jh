const express = require('express');
const path = require('node:path');
const { createCatalog } = require('./engines/live/catalog');
const { get } = require('./engines/live/http');
const { sources, byId } = require('./engines/live/sources');
const { buildM3u } = require('./engines/live/m3u');
const addon = require('./engines/live/addon');
const { createChecker } = require('./engines/live/checker');

const SITE_NAME = 'TV en Español';

// TTL del catálogo configurable por entorno (`CACHE_TTL` en ms, mínimo 60 s).
function catalogTtl() {
  const value = Number(process.env.CACHE_TTL);
  return Number.isFinite(value) && value >= 60000 ? value : undefined;
}

// Resolutores por fuente para canales `kind:'page'` (se ejecutan bajo demanda,
// nunca en el arranque). Solo se permite resolver páginas de las dos fuentes
// cuyo reproductor es estable y público.
const PAGE_RESOLVERS = {
  'tvenvivo.org': {
    host: 'www.tvenvivo.org',
    resolve: async stream => byId('tvenvivo').resolve(stream.url, { get })
  },
  'thedaddy.li': {
    host: 'thedaddy.li',
    resolve: async stream => byId('thedaddy').resolve(stream.url, { get })
  }
};

function resolvePage(stream) {
  const resolver = PAGE_RESOLVERS[stream.source];
  if (!resolver) return Promise.resolve(null);
  if (new URL(stream.url).hostname !== resolver.host) return Promise.resolve(null);
  return resolver.resolve(stream);
}

/**
 * Extrae el id y los extras de una ruta tipo
 * `/catalog/tv/todos/genre=España&skip=100.json`.
 */
function parseRoute(raw, { withExtra = false } = {}) {
  const withoutJson = raw.replace(/\.json$/i, '');
  const parts = withoutJson.split('/').filter(Boolean);
  const id = parts.shift() || '';
  const extras = new Map();
  if (withExtra) {
    for (const part of parts.join('/').split('&')) {
      if (!part) continue;
      const index = part.indexOf('=');
      if (index < 0) continue;
      try {
        extras.set(part.slice(0, index), decodeURIComponent(part.slice(index + 1).replace(/\+/g, ' ')));
      } catch {
        extras.set(part.slice(0, index), part.slice(index + 1));
      }
    }
  }
  return { id, extras };
}

const PLAYLISTS = {
  all: { label: 'Todos los canales', filter: () => true },
  es: { label: 'España', filter: channel => channel.country === 'ES' },
  latam: { label: 'Latinoamérica', filter: channel => channel.country === 'LATAM' },
  deportes: { label: 'Deportes', filter: channel => /deporte|sport/i.test(channel.category) }
};

function createApp({
  catalog = createCatalog({ sources, ...(catalogTtl() ? { ttlMs: catalogTtl() } : {}) }),
  resolve = resolvePage,
  playlistTtlMs = 5 * 60 * 1000,
  now = Date.now,
  logger = console,
  // Verificador de señales. Se puede inyectar (pruebas) o desactivar con
  // `checker: null`; por defecto verifica bajo demanda con `get`.
  checker = createChecker({ get, resolvePage: resolve, logger }),
  // Persistencia opcional del informe (`{ read, write }`). El servidor real usa
  // `reports/health.json` para no re-sondear todo tras un reinicio.
  healthStore = null,
  // Verificación automática al arrancar el catálogo (por defecto sí).
  autoVerify = true
} = {}) {
  const app = express();
  const playlistCache = new Map();

  if (checker && healthStore && typeof healthStore.read === 'function') {
    try {
      const stored = healthStore.read();
      if (stored && checker.restore(stored)) catalog.setHealth(stored);
    } catch (error) {
      logger.warn(`[checker] informe guardado ilegible: ${error.message}`);
    }
  }

  function persistHealth(report) {
    if (!healthStore || typeof healthStore.write !== 'function' || !report) return;
    try {
      healthStore.write(report);
    } catch (error) {
      logger.warn(`[checker] no se pudo guardar el informe: ${error.message}`);
    }
  }

  /**
   * Verifica todo el catálogo y deja el resultado listo para las rutas.
   * Carga el catálogo primero: los ids de los canales los normaliza el catálogo
   * (slug del nombre), así que la lista debe salir de él y no de fuera.
   */
  async function verifyNow(list) {
    if (!checker) return null;
    const target = list || (await catalog.load()).channels;
    const report = await checker.run({ force: true, list: target });
    catalog.setHealth(report);
    playlistCache.clear();
    persistHealth(report);
    return report;
  }

  // Sin presupuesto suficiente, `?check=1` responde con el informe anterior en
  // vez de dejar la petición colgada.
  const CHECK_BUDGET_MS = Number(process.env.CHECK_BUDGET_MS) > 0 ? Number(process.env.CHECK_BUDGET_MS) : 25 * 1000;

  // Lanza la verificación en segundo plano sin bloquear la petición actual.
  function verifyInBackground(list) {
    if (!checker) return;
    if (checker.fresh()) return;
    checker.run({ list }).then(report => {
      catalog.setHealth(report);
      // El filtrado cambia: las listas cacheadas dejan de valer.
      playlistCache.clear();
      persistHealth(report);
    }).catch(error => {
      logger.warn(`[checker] no se pudo verificar: ${error.message}`);
    });
  }

  // `?check=1` fuerza verificación antes de responder; el resto de peticiones
  // responde al instante con el último informe y refresca en segundo plano.
  // Un fallo del verificador nunca rompe la respuesta.
  async function ensureHealth(req, loaded) {
    if (!checker) return loaded;
    const forced = req.query.check === '1' || req.query.check === 'true';
    try {
      if (forced) {
        const report = await Promise.race([
          verifyNow(loaded.channels),
          new Promise(resolve => setTimeout(() => resolve(null), CHECK_BUDGET_MS).unref?.())
        ]);
        if (report) return await catalog.load();
        logger.warn('[checker] verificación lenta: se responde con el informe anterior');
      }
      if (!checker.peek() || !checker.fresh()) verifyInBackground(loaded.channels);
      return loaded;
    } catch (error) {
      logger.warn(`[checker] verificación fallida: ${error.message}`);
      return loaded;
    }
  }

  async function channelsOr503(res) {
    try {
      return await catalog.load();
    } catch (error) {
      res.status(503).set('Retry-After', '30').json({ error: 'Catálogo temporalmente no disponible', detail: error.message });
      return null;
    }
  }

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.options('*', (req, res) => res.sendStatus(204));

  app.get('/manifest.json', (req, res) => res.json(addon.manifest()));

  // Catálogo: `/catalog/tv/todos.json`, `/catalog/tv/todos/skip=100.json`,
  // `/catalog/tv/todos/genre=España&skip=100.json`.
  app.get(/^\/catalog\/([^/]+)\/(.+)\.json$/, async (req, res) => {
    const type = decodeURIComponent(req.params[0]);
    if (type !== 'tv') return res.status(404).json({ error: 'Tipo no soportado' });
    const { id, extras } = parseRoute(req.params[1], { withExtra: true });
    if (!['todos', 'espana', 'latinoamerica', 'deportes', 'caidos'].includes(id)) {
      return res.status(404).json({ error: 'Catálogo desconocido' });
    }
    const loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    const genre = req.query.genre || extras.get('genre') || '';
    const rawSkip = Number(req.query.skip ?? extras.get('skip') ?? 0);
    const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.floor(rawSkip) : 0;
    return res.json(addon.catalog(loaded.channels, id, typeof genre === 'string' ? genre : '', skip));
  });

  // Express 4 (path-to-regexp 0.1) no admite comodines dentro de un segmento:
  // las rutas de Stremio terminan en `.json` y se capturan con regex explícitas.
  app.get(/^\/meta\/([^/]+)\/([^/]+?)(?:\.json)?$/, async (req, res) => {
    if (req.params[0] !== 'tv') return res.status(404).json({ error: 'Tipo no soportado' });
    const loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    const channel = addon.findChannel(loaded.channels, req.params[1]);
    if (!channel) return res.status(404).json({ error: 'Canal desconocido' });
    return res.json({ meta: addon.toMeta(channel) });
  });

  app.get(/^\/stream\/([^/]+)\/([^/]+?)(?:\.json)?$/, async (req, res) => {
    const type = req.params[0];
    const id = req.params[1];
    if (type !== 'tv') return res.status(404).json({ error: 'Tipo no soportado' });
    if (!addon.ID_PATTERN.test(id)) return res.status(400).json({ error: 'Identificador de canal inválido' });
    let loaded;
    try {
      loaded = await catalog.load();
    } catch (error) {
      logger.warn(`[stream] catálogo no disponible: ${error.message}`);
      return res.json({ streams: [] });
    }
    const channel = addon.findChannel(loaded.channels, id);
    if (!channel) return res.json({ streams: [] });
    try {
      const streams = await addon.streams(channel, { resolvePage: resolve });
      return res.json({ streams });
    } catch (error) {
      logger.warn(`[stream] ${channel.id}: ${error.message}`);
      return res.json({ streams: [] });
    }
  });

  // Listas M3U. `?pages=1` intenta resolver las fuentes `kind:'page'`
  // (tvenvivo, DaddyLive); sin ese parámetro solo se publican medios directos.
  app.get('/playlist/:variant.m3u', async (req, res) => {
    const variant = String(req.params.variant).toLowerCase();
    const definition = PLAYLISTS[variant];
    if (!definition) return res.status(404).json({ error: 'Lista desconocida' });
    const includePages = req.query.pages === '1';
    // `?dead=0` (por defecto) excluye los canales que el verificador dio por
    // caídos; `?dead=1` los incluye para depurar.
    const includeDead = req.query.dead === '1';
    const cacheKey = `${variant}:${includePages ? 'pages' : 'direct'}:${includeDead ? 'con-caidos' : 'sin-caidos'}`;
    const hit = playlistCache.get(cacheKey);
    if (hit && hit.expires > now()) {
      res.set('X-Channel-Count', String(hit.count));
      res.type('application/vnd.apple.mpegurl').send(hit.body);
      return undefined;
    }
    let loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    loaded = await ensureHealth(req, loaded);
    const channels = loaded.channels
      .filter(definition.filter)
      .filter(channel => includeDead || !channel.dead);
    const { body, count } = await buildM3u(channels, {
      // Se usa el resolutor inyectado (`resolve`), no el global, para que las
      // pruebas y los despliegues puedan sustituirlo.
      resolve: includePages ? resolve : null,
      siteName: SITE_NAME,
      siteUrl: `${req.protocol}://${req.get('host')}`
    });
    if (playlistCache.size > 32) playlistCache.delete(playlistCache.keys().next().value);
    playlistCache.set(cacheKey, { body, count, expires: now() + playlistTtlMs });
    res.set('X-Channel-Count', String(count));
    if (loaded.health && loaded.health.checkedAt) res.set('X-Checked-At', loaded.health.checkedAt);
    res.type('application/vnd.apple.mpegurl').send(body);
    return undefined;
  });

  app.get('/playlist.m3u', (req, res) => res.redirect(302, '/playlist/all.m3u'));

  app.get('/playlists.json', async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    res.json({
      updatedAt: new Date(loaded.loadedAt).toISOString(),
      counts: loaded.counts,
      health: loaded.health || null,
      playlists: Object.entries(PLAYLISTS).map(([id, definition]) => ({
        id,
        name: definition.label,
        url: `${base}/playlist/${id}.m3u`,
        channels: loaded.channels.filter(definition.filter)
          .filter(channel => channel.playable && !channel.dead).length,
        withDeadUrl: `${base}/playlist/${id}.m3u?dead=1`
      }))
    });
    return undefined;
  });

  app.get('/config', async (req, res) => {
    let loaded = catalog.peek();
    if (!loaded) {
      try {
        loaded = await catalog.load();
      } catch (error) {
        return res.status(503).json({ ok: false, error: error.message });
      }
    }
    return res.json({
      ok: true,
      siteName: SITE_NAME,
      catalog: {
        loadedAt: new Date(loaded.loadedAt).toISOString(),
        counts: loaded.counts,
        stale: Boolean(loaded.stale),
        staleReason: loaded.staleReason || null
      },
      health: loaded.health || null,
      sources: loaded.status
    });
  });

  // Estado del verificador: resumen y lista de canales caídos.
  app.get('/health.json', async (req, res) => {
    if (!checker) return res.status(404).json({ error: 'Verificador desactivado' });
    let loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    loaded = await ensureHealth(req, loaded);
    return res.json({
      ok: true,
      siteName: SITE_NAME,
      ...(loaded.health || {
        checkedAt: null, checked: 0, alive: 0, dead: 0, unknown: 0,
        unchecked: loaded.channels.length, deadChannels: []
      })
    });
  });

  // Lista de canales caídos en formato Stremio (solo los que el addon publica).
  app.get('/health/dead.json', async (req, res) => {
    if (!checker) return res.status(404).json({ error: 'Verificador desactivado' });
    let loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    loaded = await ensureHealth(req, loaded);
    const dead = loaded.channels.filter(channel => channel.dead);
    return res.json({
      checkedAt: (loaded.health && loaded.health.checkedAt) || null,
      total: dead.length,
      metas: dead.map(addon.toMeta)
    });
  });

  // Resolución explícita de una página de origen (mismo contrato que antes:
  // solo devuelve `{ streams }`, sin catálogos ni metadatos).
  app.get('/stream/page', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'Falta el parámetro url' });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'URL inválida' });
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return res.status(400).json({ error: 'Se requiere HTTPS sin credenciales' });
    }
    const allowed = Object.values(PAGE_RESOLVERS).map(entry => entry.host);
    if (!allowed.includes(parsed.hostname)) return res.status(400).json({ error: `Host no soportado: ${parsed.hostname}` });
    try {
      const stream = await resolve({ url: parsed.href, kind: 'page', source: parsed.hostname === 'thedaddy.li' ? 'thedaddy.li' : 'tvenvivo.org' });
      return res.json({ streams: stream ? [{ name: SITE_NAME, title: 'HLS', url: stream.url }] : [] });
    } catch (error) {
      return res.status(502).json({ error: 'No se pudo resolver el canal', detail: error.message });
    }
  });

  app.get('/', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8">
<title>${SITE_NAME} · Addon Stremio y listas M3U</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}</style>
<h1>${SITE_NAME}</h1>
<p>Canales de televisión en español (España y Latinoamérica) recopilados de
eja.tv, iptvcat, TV Garden, Global Free TV, TVEnVivo, DaddyLive y Live24.</p>
<h2>Stremio</h2>
<p>Instala el addon con <a href="/manifest.json">${base}/manifest.json</a>.</p>
<h2>Listas M3U</h2>
<ul>${Object.entries(PLAYLISTS).map(([id, definition]) => `<li>${definition.label}: <a href="/playlist/${id}.m3u">${base}/playlist/${id}.m3u</a></li>`).join('')}</ul>
<p>Añade <code>?pages=1</code> a una lista para resolver también las fuentes que
requieren una petición extra (TVEnVivo y DaddyLive); sin ese parámetro solo se
publican medios directos.</p>
<p class="nota">DaddyLive y Live24 funcionan como <strong>mejor esfuerzo</strong>: su CDN
solo entrega los tokens a un navegador real, así que esos canales pueden requerir
abrir la página del origen.</p>
<h2>Verificación de señales</h2>
<p>Los canales caídos se detectan sondeando cada medio y se excluyen de las listas.
Estado: <a href="/health.json">/health.json</a> · caídos: <a href="/health/dead.json">/health/dead.json</a>.
Añade <code>?check=1</code> a una lista o a <a href="/health.json?check=1">/health.json</a>
para verificar ahora mismo; con <code>?dead=1</code> se incluyen también los caídos.</p>
<p>El estado real de las fuentes está en <a href="/config">/config</a>.</p>
</html>`);
  });

  app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));

  // Permite a `npm start` lanzar la verificación inicial sin bloquear el listen.
  app.locals.verifyNow = verifyNow;
  app.locals.autoVerify = autoVerify;
  return app;
}

// Persistencia del informe de salud (`reports/health.json`, ignorado por git).
function fileHealthStore(file = path.join('reports', 'health.json')) {
  const fs = require('node:fs');
  return {
    path: file,
    read() {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    write(report) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report));
    }
  };
}

if (require.main === module) {
  const port = process.env.PORT || 8080;
  const app = createApp({ healthStore: fileHealthStore() });
  app.listen(port, '0.0.0.0', () => {
    console.log(`${SITE_NAME} addon escuchando en el puerto ${port}`);
    // Verificación inicial en segundo plano: no retrasa el arranque y, si falla
    // (sin red), el servidor sigue sirviendo el catálogo completo.
    if (app.locals.autoVerify) {
      setImmediate(async () => {
        try {
          const report = await app.locals.verifyNow();
          console.log(`[checker] verificación inicial: ${report.alive} vivos · ${report.dead} caídos · ${report.unknown} sin verificar`);
        } catch (error) {
          console.warn(`[checker] verificación inicial omitida: ${error.message}`);
        }
      });
    }
  });
}

module.exports = { createApp, parseRoute, PLAYLISTS, SITE_NAME, path, fileHealthStore };
