const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../index');

test('site stream route resolves a page URL to streams only, without demos', async t => {
  let received;
  const app = createApp({
    streams: {},
    sites: {
      resolve: async request => {
        received = request;
        return [{ name: 'FlixLatam', title: 'HLS / MP4', url: 'https://flixlatam.com/a.m3u8' }];
      }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = 'http://127.0.0.1:' + server.address().port;

  const response = await fetch(base + '/stream/site?url=https://flixlatam.com/watch/xyz');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await response.json(), {
    streams: [{ name: 'FlixLatam', title: 'HLS / MP4', url: 'https://flixlatam.com/a.m3u8' }]
  });
  assert.deepEqual(received, { url: 'https://flixlatam.com/watch/xyz' });
});

test('site stream route rejects missing URLs and unsupported hosts without fetching', async t => {
  let calls = 0;
  const app = createApp({
    streams: {},
    sites: {
      resolve: async () => { calls++; return []; }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;

  assert.equal((await fetch(base + '/stream/site')).status, 400);
  assert.equal((await fetch(base + '/stream/site?url=')).status, 400);
  const rejected = await fetch(base + '/stream/site?url=https://evil.example/watch');
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /no soportado/);
  assert.equal(calls, 0);
});

test('site stream route maps extraction failures to 502 and busy to 503', async t => {
  const app = createApp({
    streams: {},
    sites: {
      resolve: async () => {
        const error = new Error('provider down');
        error.code = 'EXTRACTOR_BUSY';
        throw error;
      }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;

  const busy = await fetch(base + '/stream/site?url=https://www.documaniatv.com/pelicula');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '10');

  const down = createApp({
    streams: {},
    sites: { resolve: async () => { throw new Error('boom'); } }
  });
  const server2 = down.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  t.after(() => new Promise(resolve => server2.close(resolve)));
  const downResponse = await fetch('http://127.0.0.1:' + server2.address().port + '/stream/site?url=https://www.poseidonhd2.co/pelicula');
  assert.equal(downResponse.status, 502);
});
