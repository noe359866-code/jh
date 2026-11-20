const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { parsePage, extractPage, isPublicAddress, fetchPage } = require('../extractor');
const { createApp, validateStreams } = require('../index');

test('extracts HTML sources, typed extensionless URLs and escaped player config', () => {
  const html = `<video src="/one.mp4?token=a&amp;b=2"></video>
    <source src="../live?id=1&amp;x=2" type="application/vnd.apple.mpegurl">
    <source src="/not-a-video" type="text/html">
    <iframe src="/embed"></iframe>
    <script>const player = {file: "https:\\/\\/cdn.example.com\\/master.m3u8?token=a\\u0026v=1", other: '/relative.mp4'};</script>`;
  assert.deepEqual(parsePage(html, 'https://example.com/watch/123'), {
    media: [
      'https://example.com/one.mp4?token=a&b=2',
      'https://example.com/live?id=1&x=2',
      'https://cdn.example.com/master.m3u8?token=a&v=1',
      'https://example.com/relative.mp4'
    ],
    frames: ['https://example.com/embed']
  });
});

test('follows nested frames, handles cycles and failed pages, and removes duplicates', async () => {
  const pages = {
    'https://example.com/watch': '<source src="/a.mp4"><iframe src="/broken"></iframe><iframe src="/embed"></iframe>',
    'https://example.com/embed': '<source src="/a.mp4"><source src="https://cdn.example.com/main.m3u8"><iframe src="/watch"></iframe>'
  };
  const visited = [];
  const fetcher = async (url, headers) => {
    visited.push(url);
    assert.equal(headers.Referer, 'https://example.com/');
    if (!pages[url]) throw new Error('unavailable');
    return { url, html: pages[url] };
  };
  assert.deepEqual(await extractPage({ url: 'https://example.com/watch', headers: { Referer: 'https://example.com/' } }, fetcher), [
    'https://example.com/a.mp4', 'https://cdn.example.com/main.m3u8'
  ]);
  assert.deepEqual(visited, ['https://example.com/watch', 'https://example.com/broken', 'https://example.com/embed']);
});

test('limits traversal and ignores unsupported or internal literal media URLs', async () => {
  let calls = 0;
  const urls = await extractPage({ url: 'https://example.com/0' }, async url => {
    calls++;
    return { url, html: `<video src="http://127.0.0.1/private.mp4"></video><source src="javascript:alert(1)"><iframe src="/${calls}"></iframe>` };
  });
  assert.deepEqual(urls, []);
  assert.equal(calls, 3); // root plus two levels
});

test('blocks private and mapped addresses before connecting', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const url of ['http://localhost/test', 'http://127.0.0.1/test', 'http://[::1]/test']) {
    await assert.rejects(fetchPage(url), /Non-public/);
  }
});

test('validates explicit types and safe headers', () => {
  for (const source of [
    { url: 'https://example.com/watch', type: 'page', headers: { Referer: 'https://example.com/' } },
    { url: 'https://example.com/video?id=1', type: 'mp4' },
    { url: 'https://example.com/live', type: 'hls' }
  ]) assert.doesNotThrow(() => validateStreams({ 'movie:tt0137523': [source] }));
  for (const source of [
    { url: 'https://example.com/watch' },
    { url: 'https://example.com/watch', type: 'unknown' },
    { url: 'https://example.com/watch', type: 'page', headers: { Cookie: 'secret' } },
    { url: 'https://example.com/watch', type: 'page', headers: { Referer: 'x\r\ny' } },
    { url: 'https://example.com/watch', type: 'page', headers: { Referer: 'a', referer: 'b' } }
  ]) assert.throws(() => validateStreams({ 'movie:tt0137523': [source] }));
});

test('stream endpoint resolves pages and directs, isolates failures, and sends playback headers', async () => {
  const streams = { 'movie:tt0137523': [
    { url: 'https://example.com/watch', type: 'page', name: 'Page', headers: { Referer: 'https://example.com/' } },
    { url: 'https://example.com/broken', type: 'page' },
    { url: 'https://example.com/direct?id=1', type: 'mp4', title: 'Directo' },
    { url: 'https://example.com/direct?id=1', type: 'mp4' }
  ] };
  const app = createApp({ streams, pageFetcher: async (url) => {
    if (url.endsWith('/broken')) throw new Error('offline');
    return { url, html: '<video src="https://cdn.example.com/movie.m3u8"></video>' };
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/stream/movie/tt0137523.json`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { streams: [
      { url: 'https://cdn.example.com/movie.m3u8', name: 'Page', behaviorHints: { proxyHeaders: { request: { Referer: 'https://example.com/' } } } },
      { url: 'https://example.com/direct?id=1', title: 'Directo' }
    ] });
  } finally { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
});

test('HTTP fetch pins validated DNS and blocks redirects to private hosts', async () => {
  const http = require('node:http');
  const dns = require('node:dns').promises;
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const originalLookup = dns.lookup;
  const originalGet = http.get;
  const requested = [];
  try {
    dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    http.get = (url, options, callback) => {
      requested.push(url.href);
      options.lookup(url.hostname, { all: true }, (err, addresses) => {
        assert.ifError(err);
        assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
      });
      const request = new EventEmitter();
      request.destroy = err => request.emit('error', err);
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = url.pathname === '/redirect' ? 302 : 200;
        response.headers = url.pathname === '/redirect'
          ? { location: 'http://127.0.0.1/internal' } : { 'content-type': 'text/html; charset=utf-8' };
        response.on('end', () => request.emit('close'));
        callback(response);
        response.end('<video src="/video.mp4"></video>');
      });
      return request;
    };
    const page = await fetchPage('http://media.example.com/watch');
    assert.equal(page.url, 'http://media.example.com/watch');
    assert.match(page.html, /video\.mp4/);
    await assert.rejects(fetchPage('http://media.example.com/redirect'), /Non-public/);
    assert.deepEqual(requested, ['http://media.example.com/watch', 'http://media.example.com/redirect']);
  } finally {
    dns.lookup = originalLookup;
    http.get = originalGet;
  }
});
