const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('./manifest.json');
const sitesProvider = require('./engines/sites');
const { createResolverCache } = require('./engines/sites/cache');

// Sample metadata only; these entries do not imply that a stream is available.
const catalogs = {
  movies: [
    { id: 'tt0137523', type: 'movie', name: 'Fight Club', releaseInfo: '1999' },
    { id: 'tt0816692', type: 'movie', name: 'Interstellar', releaseInfo: '2014' }
  ],
  series: [
    { id: 'tt0944947', type: 'series', name: 'Game of Thrones', releaseInfo: '2011–2019' },
    { id: 'tt8111088', type: 'series', name: 'The Mandalorian', releaseInfo: '2019–' }
  ],
  anime: [
    { id: 'tt4644488', type: 'series', name: 'Dragon Ball Super', releaseInfo: '2015–2018' },
    { id: 'tt13616990', type: 'series', name: 'Chainsaw Man', releaseInfo: '2022–' }
  ]
};

function validId(type, id) {
  return type === 'movie' ? /^tt\d{7,}$/.test(id)
    : type === 'series' && /^tt\d{7,}:[1-9]\d*:[1-9]\d*$/.test(id);
}

// Explicit administrator-supplied media, not guessed player-page URLs.
function validateStreams(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Stream configuration must be an object');
  }
  for (const [key, streams] of Object.entries(config)) {
    const separator = key.indexOf(':');
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (separator < 0 || !validId(type, id) || !Array.isArray(streams)) {
      throw new Error(`Invalid stream configuration key or list: ${key}`);
    }
    for (const stream of streams) {
      if (!stream || typeof stream !== 'object' || Array.isArray(stream) || typeof stream.url !== 'string') {
        throw new Error(`Invalid stream entry for ${key}`);
      }
      let url;
      try { url = new URL(stream.url); } catch { /* Handled below. */ }
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || !/\.(m3u8|mp4)$/i.test(url.pathname)
        || (stream.name !== undefined && typeof stream.name !== 'string')
        || (stream.title !== undefined && typeof stream.title !== 'string')) {
        throw new Error(`Expected a direct HTTP(S) HLS/MP4 URL for ${key}`);
      }
    }
  }
  return config;
}

function loadStreams() {
  const filename = process.env.STREAMS_FILE || path.join(__dirname, 'streams.json');
  return validateStreams(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

function createApp({ streams = loadStreams(), sites = sitesProvider } = {}) {
  validateStreams(streams);
  const app = express();
  const resolveSites = createResolverCache(request => sites.resolve(request), {
    keyFn: request => JSON.stringify([request.type || 'site', request.url])
  });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.options('*', (req, res) => res.sendStatus(204));
  app.get('/manifest.json', (req, res) => res.json(manifest));

  app.get('/catalog/:type/:id.json', (req, res) => {
    const catalog = manifest.catalogs.find(c => c.type === req.params.type && c.id === req.params.id);
    if (!catalog) return res.status(404).json({ error: 'Unknown catalog' });
    return res.json({ metas: catalogs[catalog.id] });
  });

  app.get('/meta/:type/:id.json', (req, res) => {
    const meta = Object.values(catalogs).flat().find(m => m.type === req.params.type && m.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'Unknown title' });
    if (meta.type === 'series') {
      const prefix = `series:${meta.id}:`;
      const videos = Object.entries(streams)
        .filter(([key, sources]) => key.startsWith(prefix) && sources.length > 0)
        .map(([key]) => {
          const id = key.slice('series:'.length);
          const [, season, episode] = id.split(':');
          return {
            id,
            title: `Temporada ${season}, episodio ${episode}`,
            season: Number(season),
            episode: Number(episode)
          };
        })
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
      return res.json({ meta: { ...meta, videos } });
    }
    return res.json({ meta });
  });

  // Direct site resolution: stream-only. Validates the page URL, extracts
  // verified HLS/MP4 candidates and returns { streams }. No catalogs, no
  // metadata, no demo entries: an empty list means nothing verifiable found.
  app.get('/stream/site', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'Expected a url query parameter' });
    }
    // Validate before extraction so only request errors map to 400; network
    // or provider failures during extraction map to 502.
    const validarUrlSitio = sites.validarUrlSitio || sitesProvider.validarUrlSitio;
    try {
      validarUrlSitio(url);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const streams = await resolveSites({ url });
      return res.json({ streams });
    } catch (error) {
      if (error.code === 'EXTRACTOR_BUSY') return res.status(503).set('Retry-After', '10').json({ error: 'Extractor busy' });
      return res.status(502).json({ error: 'Extracción de stream del sitio fallida' });
    }
  });

  app.get('/stream/:type/:id.json', (req, res) => {
    const { type, id } = req.params;
    if (!manifest.types.includes(type)) return res.status(404).json({ error: 'Unsupported type' });
    if (!validId(type, id)) return res.status(400).json({ error: 'Expected IMDb ID; series require :season:episode' });
    const configured = (streams[`${type}:${id}`] || []).map(({ url, name, title }) => ({ url, name, title }));
    return res.json({ streams: configured });
  });

  app.get(['/', '/config'], (req, res) => {
    res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Addon Latino Stream</title><h1>Addon Latino Stream</h1><p>Catálogos de ejemplo: películas, series y anime (tipo series).</p><p>Incluye resolución de streams (mp4/HLS verificados) para documaniatv.com, flixlatam.com y poseidonhd2.co, con proveedores y resolvedores de reproductores: GET /stream/site?url=&lt;página del sitio&gt;. Solo devuelve streams, sin catálogos, metas ni demos.</p><p>El administrador puede configurar enlaces directos HLS/MP4 autorizados en streams.json o STREAMS_FILE. Consulta README.md.</p><a href="/manifest.json">Ver manifiesto para Stremio</a></html>');
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 8080;
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`Latino Stream Addon running on port ${port}`);
  });
}

// Importing the app must not bind a port (tests and embedding).
module.exports = { createApp, validateStreams };
