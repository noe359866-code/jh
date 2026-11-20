const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createProvider, validatePages } = require('../engines/flixlatam');
const { createApp } = require('../index');
const lookupImpl = async () => [{ address: '93.184.216.34' }];
function provider(pages, extra = {}) {
  return createProvider({ pages: {}, lookupImpl, allowedHosts: ['flixlatam.com', 'cdn.example'],
    fetchImpl: async url => {
      if (!(url.href in pages)) return new Response('missing', { status: 404 });
      return new Response(pages[url.href]);
    }, ...extra });
}
test('FlixLatam extracts verified HLS from iframe and MP4 literal from external script', async () => {
  const mp4 = Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109]);
  const p = provider({
    'https://flixlatam.com/pelicula/test': '<iframe src="/broken"></iframe><iframe src="/player"></iframe><script src="/player.js"></script>',
    'https://flixlatam.com/player': '<source type="application/x-mpegURL" src="https://cdn.example/playlist?token=private">',
    'https://flixlatam.com/player.js': 'player.setup({file:"https://cdn.example/video.mp4"})',
    'https://cdn.example/playlist?token=private': '#EXTM3U\n#EXT-X-VERSION:3\n',
    'https://cdn.example/video.mp4': mp4
  });
  const streams = await p.extract('https://flixlatam.com/pelicula/test');
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.name === 'FlixLatam'));
  assert.ok(streams.some(s => s.url.endsWith('video.mp4')));
});
test('FlixLatam rejects HTML disguised as video and untrusted media hosts', async () => {
  const p = provider({
    'https://flixlatam.com/test': '<source src="https://cdn.example/fake.mp4"><source src="https://evil.example/a.m3u8">',
    'https://cdn.example/fake.mp4': '<html>not video</html>'
  });
  assert.deepEqual(await p.extract('https://flixlatam.com/test'), []);
});
test('FlixLatam resolves exact movie and episode mappings and leaves unmapped IDs empty', async () => {
  const p = provider({
    'https://flixlatam.com/player-episode-2': '<source src="/ep2.m3u8">',
    'https://flixlatam.com/ep2.m3u8': '#EXTM3U\n',
    'https://flixlatam.com/movie': '<source src="/movie.m3u8">',
    'https://flixlatam.com/movie.m3u8': '#EXTM3U\n'
  }, { pages: {
    'movie:tt0137523': 'https://flixlatam.com/movie',
    'series:tt0944947:1:2': 'https://flixlatam.com/player-episode-2'
  } });
  assert.equal((await p.resolve({ type: 'movie', imdbId: 'tt0137523' })).length, 1);
  assert.equal((await p.resolve({ type: 'episode', imdbId: 'tt0944947', season: 1, episode: 2 })).length, 1);
  assert.deepEqual(await p.resolve({ type: 'episode', imdbId: 'tt0944947', season: 1, episode: 3 }), []);
});
test('FlixLatam refuses episode hash navigation and malformed mappings', async () => {
  const p = provider({});
  await assert.rejects(p.extract('https://flixlatam.com/serie/test#s1-e1'), /hash navigation/);
  assert.throws(() => validatePages({ 'movie:tt0137523': 'https://flixlatam.com/test#x' }), /fragment/);
  assert.throws(() => validatePages({ 'invalid': 'https://flixlatam.com/' }), /mapping key/);
  assert.throws(() => validatePages([]), /object/);
});
test('Stremio route selects FlixLatam, keeps configured sources first, and reports outages', async t => {
  let calls = 0;
  const app = createApp({ streams: { 'movie:tt0137523': [{ url: 'https://cdn.example/configured.mp4' }] },
    enableFlixlatam: true, enableEmbed69: true,
    embed69: { resolve: async () => { throw new Error('Wrong provider'); } },
    flixlatam: { resolve: async ({ imdbId }) => {
      calls++;
      if (imdbId === 'tt0000000') throw new Error('outage');
      return [{ name: 'FlixLatam', url: 'https://cdn.example/a.m3u8' }];
    } }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configured = await (await fetch(base + '/stream/movie/tt0137523.json')).json();
  assert.equal(configured.streams[0].url, 'https://cdn.example/configured.mp4');
  assert.equal(calls, 0);
  const extracted = await (await fetch(base + '/stream/movie/tt0816692.json')).json();
  assert.equal(extracted.streams[0].name, 'FlixLatam');
  assert.equal((await fetch(base + '/stream/movie/tt0000000.json')).status, 502);
});
