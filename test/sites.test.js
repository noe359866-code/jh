const test = require('node:test');
const assert = require('node:assert/strict');
const { SITES, allowedHosts, findSite, validateSiteUrl, resolve } = require('../engines/sites');
const lookupImpl = async () => [{ address: '93.184.216.34' }];

test('supports exactly the three configured sites with www and bare hosts', () => {
  assert.deepEqual(SITES.map(site => site.key), ['documaniatv', 'flixlatam', 'poseidonhd2']);
  assert.equal(findSite('www.documaniatv.com').key, 'documaniatv');
  assert.equal(findSite('documaniatv.com').key, 'documaniatv');
  assert.equal(findSite('www.flixlatam.com').key, 'flixlatam');
  assert.equal(findSite('www.poseidonhd2.co').key, 'poseidonhd2');
  assert.equal(findSite('evil.example'), null);
});

test('allowedHosts trusts only the site domains by default', () => {
  const hosts = allowedHosts();
  assert.ok(hosts.includes('www.documaniatv.com'));
  assert.ok(hosts.includes('flixlatam.com'));
  assert.ok(hosts.includes('poseidonhd2.co'));
  assert.equal(hosts.includes('evil.example'), false);
});

test('validates https site URLs without credentials and rejects other hosts', () => {
  const { url, site } = validateSiteUrl('https://www.documaniatv.com/pelicula/xyz');
  assert.equal(url.hostname, 'www.documaniatv.com');
  assert.equal(site.key, 'documaniatv');
  assert.throws(() => validateSiteUrl('http://www.documaniatv.com/'), /HTTPS/);
  assert.throws(() => validateSiteUrl('https://user:pass@www.documaniatv.com/'), /credentials/);
  assert.throws(() => validateSiteUrl('https://evil.example/pelicula'), /Unsupported site host/);
  assert.throws(() => validateSiteUrl('not a url'), /valid URL/);
  assert.throws(() => validateSiteUrl(''), /required/);
});

test('resolve extracts verified HLS and MP4 from a site page, stream-only', async () => {
  const pages = {
    '/pelicula/xyz': '<source src="https://www.documaniatv.com/cdn/a.m3u8?t=1">' +
      '<script>var v="https:\\/\\/www.documaniatv.com\\/files\\/b.mp4";</script>',
    '/cdn/a.m3u8': '#EXTM3U\n#EXT-X-VERSION:3\n',
    '/files/b.mp4': Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
  };
  const streams = await resolve({ url: 'https://www.documaniatv.com/pelicula/xyz' }, {
    lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  });
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map(s => s.url), [
    'https://www.documaniatv.com/cdn/a.m3u8?t=1',
    'https://www.documaniatv.com/files/b.mp4'
  ]);
  for (const stream of streams) {
    assert.equal(stream.name, 'DocumaniaTV');
    assert.equal(stream.title, 'HLS / MP4');
  }
});

test('resolve returns an empty list when nothing verifiable is found', async () => {
  const streams = await resolve({ url: 'https://flixlatam.com/watch/xyz' }, {
    lookupImpl,
    fetchImpl: async () => new Response('<html>no media here</html>')
  });
  assert.deepEqual(streams, []);
});

test('resolve rejects unsupported hosts before fetching', async () => {
  let calls = 0;
  await assert.rejects(
    resolve({ url: 'https://evil.example/watch' }, {
      lookupImpl,
      fetchImpl: async () => { calls++; return new Response('x'); }
    }),
    /Unsupported site host/
  );
  assert.equal(calls, 0);
});

test('resolve skips media on untrusted hosts and blocks private destinations', async () => {
  const pages = { '/pelicula': '<source src="https://cdn.evil.example/a.m3u8">' };
  const streams = await resolve({ url: 'https://www.poseidonhd2.co/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  });
  assert.deepEqual(streams, []);
  await assert.rejects(
    resolve({ url: 'https://www.flixlatam.com/pelicula' }, {
      lookupImpl: async () => [{ address: '127.0.0.1' }],
      fetchImpl: async () => new Response('<source src="https://www.flixlatam.com/a.m3u8">')
    }),
    /Non-public/
  );
});
