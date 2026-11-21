const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtractor, parsePage, parseEmbeds, publicAddress, decode, firmaMedia } = require('../engines/sites/extractor');
const { createPublicLookup } = require('../engines/sites/network');
const { promisify } = require('node:util');

const lookupImpl = async () => [{ address: '93.184.216.34' }];
// Playlists con contenido real: una cabecera #EXTM3U sola ya no se acepta.
const HLS_MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8\n';
const HLS_MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n';
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

test('parses escaped media URLs, relative sources and iframes without executing scripts', () => {
  const result = parsePage(`<source src="/a.mp4"><script>const x="https:\\\\/\\\\/cdn.example/a.m3u8?x=1&amp;y=2";</script><iframe src="/player"></iframe>`, 'https://example.com/f/a');
  assert.deepEqual(result.media, ['https://example.com/a.mp4', 'https://cdn.example/a.m3u8?x=1&y=2']);
  assert.deepEqual(result.frames, ['https://example.com/player']);
});

test('decodes \\u002F, &#x2F;, &quot; and keeps fragments and unquoted attributes', () => {
  // Cada uno de estos formatos rompía el parser anterior: producía URLs
  // inventadas (sitio.example/u002F/...) o no encontraba nada.
  assert.deepEqual(parsePage('<script>u="https:\\u002F\\u002Fcdn.example\\u002Fb.m3u8"</script>', 'https://s.example/p').media,
    ['https://cdn.example/b.m3u8']);
  assert.deepEqual(parsePage('<source src="https:&#x2F;&#x2F;cdn.example&#x2F;c.m3u8">', 'https://s.example/p').media,
    ['https://cdn.example/c.m3u8']);
  assert.deepEqual(parsePage('<script>u=&quot;https://cdn.example/d.m3u8&quot;</script>', 'https://s.example/p').media,
    ['https://cdn.example/d.m3u8']);
  assert.deepEqual(parsePage('<video src="https://cdn.example/e.mp4#t=10"></video>', 'https://s.example/p').media,
    ['https://cdn.example/e.mp4#t=10']);
  assert.deepEqual(parsePage('<source src=https://cdn.example/f.m3u8>', 'https://s.example/p').media,
    ['https://cdn.example/f.m3u8']);
  assert.deepEqual(parsePage('<div data-embed="https://player.example/e/9"></div>', 'https://s.example/p').frames,
    ['https://player.example/e/9']);
  assert.equal(decode('&#47;&#x2F;'), '//');
});

test('extracts verified HLS via nested iframes and rejects HTML disguised as MP4', async () => {
  const pages = {
    '/f/a': '<iframe src="/embed/1"></iframe>',
    '/embed/1': '<iframe src="/player"></iframe>',
    '/player': '<source src="/good.m3u8"><source src="/fake.mp4">',
    '/good.m3u8': HLS_MASTER, '/fake.mp4': '<html>not media</html>'
  };
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, fetchImpl: async url => new Response(pages[url.pathname] ?? '') });
  const streams = await extractor.extract('https://example.com/f/a');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://example.com/good.m3u8');
});

test('recognizes MP4 file signature and rejects an #EXTM3U stub', async () => {
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, fetchImpl: async () => new Response(MP4) });
  assert.equal(await extractor.verificar('https://example.com/a.mp4'), true);
  assert.equal(firmaMedia(Buffer.from('#EXTM3U\n')), null);
  assert.equal(firmaMedia(Buffer.from(HLS_MASTER)), 'hls-master');
  assert.equal(firmaMedia(Buffer.from(HLS_MEDIA)), 'hls-media');
});

test('blocks untrusted hosts, credentials, private IPs and redirects', async () => {
  let calls = 0;
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, fetchImpl: async (_, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw new Error('redirect blocked');
  } });
  await assert.rejects(extractor.extract('https://evil.example/'), /no permitido/);
  await assert.rejects(extractor.extract('https://a:b@example.com/'), /no permitido/);
  await assert.rejects(extractor.extract('https://example.com/'), /redirect blocked/);
  assert.equal(calls, 1);
  const privateExtractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl: async () => [{ address: '127.0.0.1' }] });
  await assert.rejects(privateExtractor.extract('https://example.com/'), /no público/);
  for (const ip of ['10.1.2.3', '::1', '::ffff:127.0.0.1', '169.254.169.254']) assert.equal(publicAddress(ip), false);
});

test('enforces page size limit', async () => {
  const extractor = createExtractor({ allowedHosts: ['example.com'], lookupImpl, maxBytes: 4, fetchImpl: async () => new Response('too large') });
  await assert.rejects(extractor.extract('https://example.com/'), /límite de tamaño/);
});

test('stops at the total deadline instead of multiplying the per-request timeout', async () => {
  // Antes: 10 candidatos en serie, cada uno hasta timeoutMs => cientos de
  // segundos. Ahora hay un presupuesto total (deadlineMs).
  const html = Array.from({ length: 10 }, (_, i) => `<source src="https://example.com/v${i}.m3u8">`).join('');
  const extractor = createExtractor({
    allowedHosts: ['example.com'], lookupImpl, timeoutMs: 50, deadlineMs: 120,
    fetchImpl: async url => {
      if (url.pathname.endsWith('.m3u8')) await new Promise(r => setTimeout(r, 50));
      return new Response(html);
    }
  });
  const inicio = Date.now();
  const streams = await extractor.extract('https://example.com/p');
  const duracion = Date.now() - inicio;
  assert.deepEqual(streams, []);
  assert.ok(duracion < 1000, `la extracción tardó ${duracion} ms pese al deadline de 120 ms`);
});

test('the injected lookup is what the transport validates (no second DNS lookup)', async () => {
  // Antes el lookup de prueba se ignoraba: el dispatcher de producción hacía
  // su propio DNS y la validación anti-SSRF nunca se ejercitaba.
  const resolverDNS = promisify(createPublicLookup((host, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])));
  await assert.rejects(resolverDNS('evil.example', { all: true }), /Non-public/);
});

test('SSRF transport (undici) refuses a private address resolved at connect time', async () => {
  const { createPublicFetch } = require('../engines/sites/network');
  const traer = createPublicFetch({ lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 200 });
  await assert.rejects(traer('https://public.example/a.m3u8'), /Non-public|fetch failed|ECONNREFUSED/);
});

test('descubre reproductores enlazados (no solo iframes) de hosts conocidos', () => {
  // PoseidonHD2 lista sus servidores como enlaces/data-*, sin embeberlos:
  // antes el crawl no los veía nunca.
  const hosts = ['uqload.vc', 'voe.sx', 'streamwish.to'];
  const encontrados = parseEmbeds(
    '<a href="https://uqload.vc/embed-abc.html">1</a><div data-url="//voe.sx/e/xyz"></div>' +
    '<a href="https://otro.example/x">2</a><a href="https://voe.sx/hls/master.m3u8">media</a>',
    'https://flixlatam.com/pelicula/patton', new Set(hosts)
  );
  assert.deepEqual(encontrados, ['https://uqload.vc/embed-abc.html', 'https://voe.sx/e/xyz']);
  assert.deepEqual(parseEmbeds('<a href="https://voe.sx/e/1">x</a>', 'https://s.example/', new Set()), []);
});
