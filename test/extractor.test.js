const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtractor, parsePage, publicAddress } = require('../engines/sites/extractor');
const lookupImpl = async () => [{ address: '93.184.216.34' }];
test('parses escaped media URLs, relative sources and iframes without executing scripts', () => {
  const result = parsePage(`<source src="/a.mp4"><script>const x="https:\\/\\/cdn.example/a.m3u8?x=1&amp;y=2";</script><iframe src="/player"></iframe>`, 'https://example.com/f/a');
  assert.deepEqual(result.media, ['https://example.com/a.mp4', 'https://cdn.example/a.m3u8?x=1&y=2']);
  assert.deepEqual(result.frames, ['https://example.com/player']);
});
test('extracts verified HLS via nested iframe and rejects HTML disguised as MP4', async () => {
  const pages = {
    '/f/a': '<iframe src="/player"></iframe>',
    '/player': '<source src="/good.m3u8"><source src="/fake.mp4">',
    '/good.m3u8': '#EXTM3U\n#EXT-X-VERSION:3\n', '/fake.mp4': '<html>not media</html>'
  };
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, fetchImpl: async url => new Response(pages[url.pathname]) });
  const streams = await extractor.extract('https://example.com/f/a');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://example.com/good.m3u8');
});
test('recognizes MP4 file signature', async () => {
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, fetchImpl: async () => new Response(Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109])) });
  assert.equal(await extractor.verify('https://example.com/a.mp4'), true);
});
test('blocks untrusted hosts, credentials, private IPs and redirects', async () => {
  let calls = 0;
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, fetchImpl: async (_, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw new Error('redirect blocked');
  } });
  await assert.rejects(extractor.extract('https://evil.example/'), /not allowed/);
  await assert.rejects(extractor.extract('https://a:b@example.com/'), /not allowed/);
  await assert.rejects(extractor.extract('https://example.com/'), /redirect blocked/);
  assert.equal(calls, 1);
  const privateExtractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl: async () => [{ address: '127.0.0.1' }] });
  await assert.rejects(privateExtractor.extract('https://example.com/'), /Non-public/);
  for (const ip of ['10.1.2.3', '::1', '::ffff:127.0.0.1', '169.254.169.254']) assert.equal(publicAddress(ip), false);
});
test('enforces page size limit', async () => {
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, maxBytes: 4, fetchImpl: async () => new Response('too large') });
  await assert.rejects(extractor.extract('https://example.com/'), /size limit/);
});
