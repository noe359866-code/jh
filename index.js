// Agregador de listas M3U privadas (IPTV/Xtream).
//
// Junta varias listas propias en una sola y sirve el resultado como M3U. Por
// defecto **solo** se ven esas listas; el catálogo público de listas abiertas
// solo entra si se pide (`PUBLIC_LISTS=1` o `?publico=1` en una lista).
//
// Rutas:
//   GET /                       portada con enlaces
//   GET /playlist/:id.m3u       listas (combinada, por lista, por país…)
//   GET /playlists.json         índice con recuentos
//   GET /health.json            informe del verificador
//   GET /health/dead.json       canales caídos con su motivo
//   GET /config                 estado de cada fuente y tiempos
const express = require('express');
const path = require('node:path');
const { createCatalog } = require('./engines/live/catalog');
const { get } = require('./engines/live/http');
const { sources, byId, extra, buildSources, publicEnabled } = require('./engines/live/sources');
const { COUNTRIES } = require('./engines/live/countries');
const { slug } = require('./engines/live/text');
const { buildM3u } = require('./engines/live/m3u');
const { createChecker } = require('./engines/live/checker');

// Guía de programación de las listas M3U (opcional, `EPG_URL=` la desactiva).
const EPG_URL = process.env.EPG_URL === undefined
  ? 'https://www.tdtchannels.com/epg/TV.xml.gz'
  : process.env.EPG_URL;

const SITE_NAME = process.env.SITE_NAME || 'Agregador IPTV';

// TTL del catálogo configurable por entorno (`CACHE_TTL` en ms, mínimo 60 s).
function catalogTtl() {
  const value = Number(process.env.CACHE_TTL);
  return Number.isFinite(value) && value >= 60000 ? value : undefined;
}

/**
 * Extrae el id y los extras de una ruta tipo
 * `/playlist/nexon.m3u` o `/health.json?check=1`. Se conserva el parser del
 * proyecto anterior para no cambiar el contrato de `/config`.
 */
function parseRoute(raw, { withExtra = false } = {}) {
  const withoutJson = raw.replace(/\.(json|m3u)$/i, '');
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

// Listas por región y por país del catálogo.
const REGION_PLAYLISTS = {
  all: { label: 'Todos los canales', filter: () => true },
  es: { label: 'España', filter: channel => channel.country === 'ES' },
  latam: { label: 'Latinoamérica', filter: channel => channel.country === 'LATAM' },
  deportes: { label: 'Deportes', filter: channel => /deporte|sport/i.test(channel.category || '') }
};

const COUNTRY_PLAYLISTS = Object.fromEntries(COUNTRIES.map(country => [
  country.code.toLowerCase(),
  { label: country.name, filter: channel => (channel.origin || channel.country) === country.code }
]));

const PLAYLISTS = { ...REGION_PLAYLISTS, ...COUNTRY_PLAYLISTS };

/**
 * Listas que se sirven por HTTP. Además de las de región/país hay:
 *
 *   - una por cada lista configurada (`/playlist/<id-lista>.m3u`), para sacar
 *     solo esa lista, y
 *   - la **combinada** (`/playlist/nexon.m3u`), que junta todas las privadas en
 *     un único archivo, como el M3U del proveedor.
 *
 * `all` es todo lo recolectado. Si el nombre de la combinada choca con una lista
 * existente (`all`, `es`…), no se pisa: se publica como `mi-iptv`.
 */
function playlistDefinitions({ extraConfig = extra } = {}) {
  const definitions = { ...PLAYLISTS };
  const privateIds = new Set(extraConfig.mergeSourceIds || []);
  if (!privateIds.size) return definitions;

  // La combinada va primero: su nombre es el que eligió el usuario y manda.
  const merge = extraConfig.merge || { id: 'mi-iptv', name: 'Mi IPTV' };
  const combinedId = definitions[merge.id] ? 'mi-iptv' : merge.id;
  definitions[combinedId] = {
    label: merge.name,
    filter: channel => (channel.sources || []).some(source => privateIds.has(source)),
    private: true
  };

  // Y una lista por fuente privada, con el nombre de la lista (`nexon-iptv`),
  // para poder sacar una sola sin editar la configuración.
  for (const source of extraConfig.sources || []) {
    const candidates = [
      slug(String(source.name || ''), ''),
      String(source.id).replace(/^extra-/, '')
    ].filter(Boolean);
    const id = candidates.find(candidate => !definitions[candidate]);
    if (!id) continue;
    definitions[id] = {
      label: source.name,
      filter: channel => (channel.sources || []).includes(source.id),
      single: true
    };
  }
  return definitions;
}

function createApp({
  catalog = createCatalog({
    sources,
    ...(catalogTtl() ? { ttlMs: catalogTtl() } : {})
  }),
  // Configuración de listas privadas (inyectable en pruebas).
  extraConfig = extra,
  playlistTtlMs = 5 * 60 * 1000,
  now = Date.now,
  logger = console,
  // Verificador de señales. Se puede inyectar (pruebas) o desactivar con
  // `checker: null`; `channels` se resuelve perezosamente del catálogo.
  checker = createChecker({
    get,
    channels: async () => (await catalog.load()).channels,
    logger
  }),
  // Persistencia opcional del informe (`{ read, write }`).
  healthStore = null,
  // Verificación automática al arrancar (por defecto sí).
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

  /** Verifica el catálogo y deja el informe listo para las rutas. */
  async function verifyNow(list) {
    if (!checker) return null;
    const target = list || (await catalog.load()).channels;
    const report = await checker.run({ force: true, list: target });
    catalog.setHealth(report);
    playlistCache.clear();
    persistHealth(report);
    return report;
  }

  const CHECK_BUDGET_MS = Number(process.env.CHECK_BUDGET_MS) > 0 ? Number(process.env.CHECK_BUDGET_MS) : 25 * 1000;

  function verifyInBackground(list) {
    if (!checker) return;
    if (checker.fresh()) return;
    checker.run({ list }).then(report => {
      catalog.setHealth(report);
      playlistCache.clear();
      persistHealth(report);
    }).catch(error => {
      logger.warn(`[checker] no se pudo verificar: ${error.message}`);
    });
  }

  // `?check=1` fuerza verificación antes de responder; el resto responde al
  // instante con el último informe y refresca en segundo plano.
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

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\n');
  });

  // Listas M3U. `?dead=1` incluye los canales caídos; `?check=1` verifica antes
  // de responder; `?publico=1` añade el catálogo público a esa respuesta.
  app.get('/playlist/:variant.m3u', async (req, res) => {
    const variant = String(req.params.variant).toLowerCase();
    const definition = playlistDefinitions({ extraConfig })[variant];
    if (!definition) return res.status(404).json({ error: 'Lista desconocida' });
    const includeDead = req.query.dead === '1';
    const withPublic = publicEnabled() || req.query.publico === '1';
    const cacheKey = `${variant}:${includeDead ? 'con-caidos' : 'sin-caidos'}:${withPublic ? 'con-publico' : 'privado'}`;
    const hit = playlistCache.get(cacheKey);
    if (hit && hit.expires > now()) {
      res.set('X-Channel-Count', String(hit.count));
      res.type('application/vnd.apple.mpegurl').send(hit.body);
      return undefined;
    }
    let loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    loaded = await ensureHealth(req, loaded);

    // Con `?publico=1` se recolectan también las listas abiertas, solo para esta
    // petición: el catálogo cacheado no se toca.
    let pool = loaded.channels;
    if (withPublic && !publicEnabled()) {
      try {
        const publicCatalog = createCatalog({
          sources: buildSources({ env: { PUBLIC_LISTS: '1' } }).filter(source => !String(source.id).startsWith('extra-'))
        });
        pool = (await publicCatalog.load()).channels.concat(pool);
      } catch (error) {
        logger.warn(`[playlist] catálogo público no disponible: ${error.message}`);
      }
    }

    const channels = pool
      .filter(definition.filter)
      .filter(channel => includeDead || !channel.dead);
    const { body, count } = await buildM3u(channels, {
      siteName: SITE_NAME,
      epgUrl: EPG_URL,
      siteUrl: `${req.protocol}://${req.get('host')}`
    });
    if (playlistCache.size > 32) playlistCache.delete(playlistCache.keys().next().value);
    playlistCache.set(cacheKey, { body, count, expires: now() + playlistTtlMs });
    res.set('X-Channel-Count', String(count));
    if (loaded.health && loaded.health.checkedAt) res.set('X-Checked-At', loaded.health.checkedAt);
    res.type('application/vnd.apple.mpegurl').send(body);
    return undefined;
  });

  app.get('/playlist.m3u', (req, res) => {
    const definitions = playlistDefinitions({ extraConfig });
    const combined = Object.entries(definitions).find(([, definition]) => definition.private);
    return res.redirect(302, combined ? `/playlist/${combined[0]}.m3u` : '/playlist/all.m3u');
  });

  app.get('/playlists.json', async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    res.json({
      updatedAt: new Date(loaded.loadedAt).toISOString(),
      counts: loaded.counts,
      publicLists: publicEnabled(),
      health: loaded.health || null,
      playlists: Object.entries(playlistDefinitions({ extraConfig })).map(([id, definition]) => ({
        id,
        name: definition.label,
        url: `${base}/playlist/${id}.m3u`,
        private: Boolean(definition.private),
        channels: loaded.channels.filter(definition.filter)
          .filter(channel => !channel.dead).length,
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
      publicLists: publicEnabled(),
      health: loaded.health || null,
      // Listas privadas: solo id, nombre y host. Las URLs llevan usuario y
      // contraseña del proveedor y no se publican ni en este endpoint.
      extraPlaylists: {
        configured: (extraConfig.definitions || []).length,
        file: extraConfig.configFile ? path.basename(String(extraConfig.configFile)) : null,
        error: extraConfig.configError || null,
        lists: (extraConfig.definitions || []).map(({ id, name, label, country }) => ({ id, name, label, country }))
      },
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

  app.get('/health/dead.json', async (req, res) => {
    if (!checker) return res.status(404).json({ error: 'Verificador desactivado' });
    let loaded = await channelsOr503(res);
    if (!loaded) return undefined;
    loaded = await ensureHealth(req, loaded);
    const dead = loaded.channels.filter(channel => channel.dead);
    return res.json({
      checkedAt: (loaded.health && loaded.health.checkedAt) || null,
      total: dead.length,
      channels: dead.map(channel => ({
        id: channel.id,
        name: channel.name,
        country: channel.origin,
        category: channel.category,
        sources: channel.sources,
        reason: channel.deadReason || null,
        streams: channel.streams.map(stream => stream.url)
      }))
    });
  });

  app.get('/', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const definitions = Object.entries(playlistDefinitions({ extraConfig }));
    const configured = extraConfig.definitions || [];
    const rows = definitions.map(([id, definition]) =>
      `<li>${definition.label}${definition.private ? ' <em>(combinada)</em>' : ''}: <a href="/playlist/${id}.m3u">${base}/playlist/${id}.m3u</a></li>`
    ).join('');
    res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SITE_NAME} · listas M3U</title>
<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e5e5;padding:.35rem;text-align:left;font-size:.95rem}
.aviso{background:#fff7e6;border-left:4px solid #f0b429;padding:.6rem .8rem}</style>
<h1>${SITE_NAME}</h1>
<p>Agrega tus listas M3U privadas (IPTV/Xtream) en una sola lista, con verificador
de señales. ${configured.length
    ? `Listas configuradas: <strong>${configured.length}</strong>.`
    : 'No hay listas configuradas todavía.'}</p>
${configured.length ? `<table><tr><th>Lista</th><th>Host</th><th>País</th></tr>${
    configured.map(list => `<tr><td>${list.name}</td><td>${list.label}</td><td>${list.country || '—'}</td></tr>`).join('')
  }</table>` : `<p class="aviso">Crea <code>config/extra-playlists.json</code> (hay un
<code>config/extra-playlists.example.json</code>) o define <code>EXTRA_PLAYLISTS</code>.</p>`}
<h2>Listas M3U</h2>
<ul>${rows}</ul>
<p>La lista <strong>combinada</strong> junta todas tus listas privadas en un solo
archivo: es la URL que se pega en VLC, Kodi, TiviMate o IPTVnator.</p>
<p>Parámetros: <code>?dead=1</code> incluye los canales caídos ·
<code>?check=1</code> verifica antes de responder ·
<code>?publico=1</code> añade el catálogo público de listas abiertas (${publicEnabled() ? 'activado' : 'desactivado'} por defecto).</p>
<h2>Verificación</h2>
<p>Los canales caídos se excluyen de las listas. Estado: <a href="/health.json">/health.json</a> ·
detalle: <a href="/health/dead.json">/health/dead.json</a> ·
fuentes: <a href="/config">/config</a>.</p>
</html>`);
  });

  app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));

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
    console.log(`${SITE_NAME} escuchando en el puerto ${port}`);
    if (!extra.definitions.length) {
      console.warn('[config] no hay listas privadas: crea config/extra-playlists.json o define EXTRA_PLAYLISTS');
    } else {
      console.log(`[config] ${extra.definitions.length} lista(s) privada(s): ${extra.definitions.map(list => list.label).join(', ')}`);
    }
    console.log(`[config] catálogo público de listas abiertas: ${publicEnabled() ? 'activado' : 'desactivado'}`);
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

module.exports = { createApp, parseRoute, PLAYLISTS, playlistDefinitions, SITE_NAME, path, fileHealthStore };
