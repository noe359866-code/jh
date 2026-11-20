const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../index');

test('Embed69 diagnostic route delegates discovery without advertising playback', async t => {
  let received;
  const app = createApp({
    streams: {},
    embed69: {
      discover: async request => {
        received = request;
        return {
          provider: 'embed69',
          available: true,
          pageUrl: 'https://embed69.org/f/tt0944947-1x05',
          playable: false,
          limitation: 'Embed69 page extraction is not implemented yet'
        };
      }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = 'http://127.0.0.1:' + server.address().port;

  const response = await fetch(base + '/providers/embed69/check/episode/tt0944947.json?season=1&episode=5');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'embed69');
  assert.equal(body.playable, false);
  assert.equal(received.type, 'episode');
  assert.equal(received.imdbId, 'tt0944947');
  assert.equal(received.season, '1');
  assert.equal(received.episode, '5');
});

test('Embed69 diagnostic route rejects unknown provider types', async t => {
  const app = createApp({ streams: {}, embed69: { discover: async () => ({}) } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/providers/embed69/check/anime/tt0944947.json');
  assert.equal(response.status, 400);
});

test('opt-in stream route resolves episodes, prioritizes configured streams and handles outages', async t => {
  let received;
  const app = createApp({
    streams: { 'movie:tt0137523': [{ url: 'https://media.example/a.mp4' }] },
    enableEmbed69: true,
    embed69: { resolve: async request => {
      received = request;
      if (request.imdbId === 'tt0000000') throw new Error('provider down');
      return [{ name: 'Embed69', url: 'https://media.example/a.m3u8' }];
    } }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const movie = await (await fetch(base + '/stream/movie/tt0137523.json')).json();
  assert.equal(movie.streams[0].url, 'https://media.example/a.mp4');
  assert.equal(received, undefined);
  const episode = await (await fetch(base + '/stream/series/tt0944947:1:5.json')).json();
  assert.equal(episode.streams.length, 1);
  assert.deepEqual(received, { type: 'episode', imdbId: 'tt0944947', season: '1', episode: '5' });
  assert.equal((await fetch(base + '/stream/movie/tt0000000.json')).status, 502);
});
