const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { validateHeaderValue } = require('node:http');
const { extractPage } = require('./extractor');
const manifest = require('./manifest.json');

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

// Sources are supplied by the administrator, never guessed from an IMDb ID.
function validateStreams(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Stream configuration must be an object');
  }
  for (const [key, streams] of Object.entries(config)) {
    const separator = key.indexOf(':');
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (separator < 0 || !validId(type, id) || !Array.isArray(streams) || streams.length > 25) {
      throw new Error(`Invalid stream configuration key or list: ${key}`);
    }
    for (const stream of streams) {
      if (!stream || typeof stream !== 'object' || Array.isArray(stream) || typeof stream.url !== 'string') {
        throw new Error(`Invalid stream entry for ${key}`);
      }
      let url;
      try { url = new URL(stream.url); } catch { /* Handled below. */ }
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || (stream.type !== undefined && !['page', 'hls', 'mp4'].includes(stream.type))
        || (stream.type === undefined && !/\.(m3u8|mp4)$/i.test(url.pathname))
        || (stream.name !== undefined && typeof stream.name !== 'string')
        || (stream.title !== undefined && typeof stream.title !== 'string')) {
        throw new Error(`Expected an HTTP(S) page or direct HLS/MP4 URL for ${key}`);
      }
      if (stream.headers !== undefined) {
        if (!stream.headers || typeof stream.headers !== 'object' || Array.isArray(stream.headers)) {
          throw new Error(`Invalid headers for ${key}`);
        }
        const seen = new Set();
        for (const [header, value] of Object.entries(stream.headers)) {
          const normalized = header.toLowerCase();
          if (!['referer', 'origin', 'user-agent'].includes(normalized) || seen.has(normalized) || typeof value !== 'string' || value.length > 2048) {
            throw new Error(`Invalid header for ${key}`);
          }
          seen.add(normalized);
          try { validateHeaderValue(header, value); } catch { throw new Error(`Invalid header for ${key}`); }
        }
      }
    }
  }
  return config;
}

function loadStreams() {
  const filename = process.env.STREAMS_FILE || path.join(__dirname, 'streams.json');
  return validateStreams(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

function createApp({ streams = loadStreams(), pageFetcher } = {}) {
  validateStreams(streams);
  const app = express();
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

  app.get('/stream/:type/:id.json', async (req, res, next) => {
    const { type, id } = req.params;
    if (!manifest.types.includes(type)) return res.status(404).json({ error: 'Unsupported type' });
    if (!validId(type, id)) return res.status(400).json({ error: 'Expected IMDb ID; series require :season:episode' });
    try {
      const groups = await Promise.all((streams[`${type}:${id}`] || []).map(async source => {
        const urls = source.type === 'page' ? await extractPage(source, pageFetcher) : [source.url];
        return urls.map(url => ({
          url,
          ...(source.name !== undefined ? { name: source.name } : {}),
          ...(source.title !== undefined ? { title: source.title } : {}),
          ...(source.headers && Object.keys(source.headers).length ? { behaviorHints: { proxyHeaders: { request: source.headers } } } : {})
        }));
      }));
      const seen = new Set();
      const result = groups.flat().filter(stream => {
        const key = JSON.stringify([stream.url, stream.behaviorHints || null]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return res.json({ streams: result });
    } catch (error) { return next(error); }
  });

  app.get(['/', '/config'], (req, res) => {
    res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Latino Stream Addon</title><h1>Latino Stream Addon</h1><p>Catálogos de ejemplo: películas, series y anime (tipo series).</p><p>El administrador puede configurar enlaces directos o páginas autorizadas en streams.json o STREAMS_FILE. Sin fuentes devuelve streams vacíos. Consulta README.md.</p><a href="/manifest.json">Ver manifiesto para Stremio</a></html>');
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
