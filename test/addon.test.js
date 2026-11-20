const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp, validateStreams } = require('../index');
const manifest = require('../manifest.json');
let server;
let base;
before(async () => {
  server = createApp({ streams: {
    'movie:tt0137523': [{ url: 'https://media.example.com/movie.m3u8?token=test', name: 'Test fixture' }],
    'series:tt0944947:2:1': [{ url: 'https://media.example.com/season2.mp4' }],
    'series:tt0944947:1:10': [{ url: 'https://media.example.com/episode10.mp4' }],
    'series:tt0944947:1:2': [{ url: 'https://media.example.com/episode.mp4' }],
    'series:tt0944947:1:1': [],
    'series:tt8111088:1:1': [{ url: 'https://media.example.com/other-series.mp4' }]
  } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
async function get(route, status = 200) {
  const response = await fetch(base + route);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  return response.json();
}
test('manifest matches single source and advertises supported resources', async () => {
  assert.deepEqual(await get('/manifest.json'), manifest);
  assert.deepEqual(manifest.resources, ['catalog', 'meta', 'stream']);
  assert.deepEqual(manifest.types, ['movie', 'series']);
});
test('every advertised catalog and metadata endpoint follows Stremio schema', async () => {
  for (const catalog of manifest.catalogs) {
    const { metas } = await get(`/catalog/${catalog.type}/${catalog.id}.json`);
    assert.ok(metas.length);
    for (const meta of metas) {
      assert.equal(meta.type, catalog.type);
      assert.match(meta.id, /^tt\d{7,}$/);
      assert.ok(meta.name);
      const { meta: detail } = await get(`/meta/${meta.type}/${meta.id}.json`);
      const { videos, ...basic } = detail;
      assert.deepEqual(basic, meta);
      if (meta.type === 'series') assert.ok(Array.isArray(videos));
    }
  }
});
test('configured movie stream is returned without fabricated URLs', async () => {
  const { streams } = await get('/stream/movie/tt0137523.json');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://media.example.com/movie.m3u8?token=test');
});
test('episode IDs resolve independently', async () => {
  const { streams } = await get('/stream/series/tt0944947:1:2.json');
  assert.equal(streams[0].url, 'https://media.example.com/episode.mp4');
  assert.deepEqual(await get('/stream/series/tt0944947:1:3.json'), { streams: [] });
});
test('unavailable streams are successful empty results', async () => {
  assert.deepEqual(await get('/stream/movie/tt0816692.json'), { streams: [] });
  const empty = createApp({ streams: {} });
  assert.equal(typeof empty, 'function');
});
test('invalid IDs, unsupported types and missing routes are rejected', async () => {
  await get('/stream/movie/invalid.json', 400);
  await get('/stream/series/tt0944947.json', 400);
  await get('/stream/series/tt0944947:0:1.json', 400);
  await get('/stream/anime/tt4644488.json', 404);
  await get('/catalog/movie/unknown.json', 404);
  await get('/catalog/series/movies.json', 404);
  await get('/meta/movie/tt0000000.json', 404);
  await get('/missing', 404);
});
test('CORS preflight works', async () => {
  const res = await fetch(base + '/manifest.json', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
test('configuration rejects player pages, unsafe schemes and invalid entries', () => {
  for (const config of [null, [], { bad: [] }, { 'movie:tt0137523': {} },
    ...['https://example.com/player.php?id=1', 'file:///movie.mp4', 'javascript:alert(1)', 'https://user:pass@example.com/file.mp4']
      .map(url => ({ 'movie:tt0137523': [{ url }] }))]) {
    assert.throws(() => validateStreams(config));
  }
  assert.deepEqual(validateStreams(require('../streams.json')), {});
});
test('series metadata lists only configured playable episodes in numeric order', async () => {
  const { meta } = await get('/meta/series/tt0944947.json');
  assert.deepEqual(meta.videos, [
    { id: 'tt0944947:1:2', title: 'Temporada 1, episodio 2', season: 1, episode: 2 },
    { id: 'tt0944947:1:10', title: 'Temporada 1, episodio 10', season: 1, episode: 10 },
    { id: 'tt0944947:2:1', title: 'Temporada 2, episodio 1', season: 2, episode: 1 }
  ]);
  for (const video of meta.videos) {
    const result = await get(`/stream/series/${video.id}.json`);
    assert.ok(result.streams.length);
  }
});
test('series without configured episodes expose an empty video list', async () => {
  const { meta } = await get('/meta/series/tt4644488.json');
  assert.deepEqual(meta.videos, []);
});
