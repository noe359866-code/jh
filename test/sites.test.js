const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver } = require('../engines/sites');
const lookupImpl = async () => [{ address: '93.184.216.34' }];
const HLS = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8\n';
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

test('exactamente los tres sitios configurados con hosts www y sin www', () => {
  assert.deepEqual(PROVEEDORES.map(site => site.clave), ['documaniatv', 'flixlatam', 'poseidonhd2']);
  assert.equal(encontrarProveedor('www.documaniatv.com').clave, 'documaniatv');
  assert.equal(encontrarProveedor('documaniatv.com').clave, 'documaniatv');
  assert.equal(encontrarProveedor('www.flixlatam.com').clave, 'flixlatam');
  assert.equal(encontrarProveedor('www.poseidonhd2.co').clave, 'poseidonhd2');
  assert.equal(encontrarProveedor('evil.example'), null);
});

test('hostsPermitidos confía en los dominios del sitio y de reproductor conocidos, no en internet', () => {
  const hosts = hostsPermitidos({});
  assert.ok(hosts.includes('www.documaniatv.com'));
  assert.ok(hosts.includes('flixlatam.com'));
  assert.ok(hosts.includes('poseidonhd2.co'));
  // Los dominios de reproductor deben estar permitidos para que sus
  // resolvedores sean alcanzables, pero de forma explícita y acotada.
  assert.ok(hosts.includes('voe.sx'));
  assert.ok(hosts.includes('streamtape.com'));
  assert.equal(hosts.includes('evil.example'), false);
  // SITES_ALLOWED_HOSTS solo añade lo indicado, sin comodines.
  assert.deepEqual(hostsPermitidos({ SITES_ALLOWED_HOSTS: 'cdn.example.com, otro.example' })
    .filter(h => h.includes('example')), ['cdn.example.com', 'otro.example']);
});

test('valida URLs HTTPS del sitio sin credenciales y rechaza otros hosts', () => {
  const { url, proveedor } = validarUrlSitio('https://www.documaniatv.com/pelicula/xyz');
  assert.equal(url.hostname, 'www.documaniatv.com');
  assert.equal(proveedor.clave, 'documaniatv');
  assert.throws(() => validarUrlSitio('http://www.documaniatv.com/'), /HTTPS/);
  assert.throws(() => validarUrlSitio('https://user:pass@www.documaniatv.com/'), /credenciales/);
  assert.throws(() => validarUrlSitio('https://evil.example/pelicula'), /no soportado/);
  assert.throws(() => validarUrlSitio('not a url'), /URL válida/);
  assert.throws(() => validarUrlSitio(''), /requiere/);
});

test('resolver extrae HLS y MP4 verificados de una página del sitio, con formato Stremio', async () => {
  const pages = {
    '/pelicula/xyz': '<source src="https://www.documaniatv.com/cdn/a.m3u8?t=1">' +
      '<script>var v="https:\\\\/\\\\/www.documaniatv.com\\\\/files\\\\/b.mp4";</script>',
    '/cdn/a.m3u8': HLS,
    '/files/b.mp4': MP4
  };
  const streams = await resolver({ url: 'https://www.documaniatv.com/pelicula/xyz' }, {
    lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  });
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map(s => s.url), [
    'https://www.documaniatv.com/cdn/a.m3u8?t=1',
    'https://www.documaniatv.com/files/b.mp4'
  ]);
  for (const stream of streams) {
    // Claves del objeto Stream de Stremio: antes se devolvían nombre/titulo,
    // que el cliente ignora.
    assert.equal(stream.name, 'DocumaniaTV');
    assert.equal(stream.title, 'HLS / MP4');
    assert.equal(stream.nombre, undefined);
    assert.equal(stream.titulo, undefined);
    assert.doesNotThrow(() => new URL(stream.url));
  }
});

test('resolver sigue los iframes del sitio hasta el reproductor (antes solo miraba la página)', async () => {
  const pedidos = [];
  const pages = {
    '/pelicula': '<iframe src="/embed/1"></iframe>',
    '/embed/1': '<iframe src="/player/2"></iframe>',
    '/player/2': '<source src="/cdn/a.m3u8">',
    '/cdn/a.m3u8': HLS
  };
  const streams = await resolver({ url: 'https://flixlatam.com/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => { pedidos.push(new URL(url).pathname); return new Response(pages[new URL(url).pathname] ?? ''); }
  });
  assert.deepEqual(streams.map(s => s.url), ['https://flixlatam.com/cdn/a.m3u8']);
  assert.ok(pedidos.includes('/player/2'), 'debe recorrer los iframes anidados');
});

test('resolver resuelve un iframe de reproductor conocido con su resolvedor dedicado', async () => {
  const pages = {
    '/pelicula': '<iframe src="https://voe.sx/e/abc"></iframe>',
    '/e/abc': '<script type="application/json">{"source":"https://voe.sx/hls/master.m3u8"}</script>',
    '/hls/master.m3u8': HLS
  };
  const streams = await resolver({ url: 'https://www.documaniatv.com/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname] ?? '')
  });
  assert.deepEqual(streams.map(s => s.url), ['https://voe.sx/hls/master.m3u8']);
  assert.equal(streams[0].name, 'DocumaniaTV');
});

test('resolver NUNCA autoriza hosts descubiertos en el HTML (SSRF)', async () => {
  // Antes bastaba con que la página "confiable" incluyera un src a cualquier
  // host para que el servidor lo descargara y lo devolviera como stream.
  const pedidos = [];
  const pages = { '/pelicula': '<source src="https://cdn-atacante.example/robar.m3u8">' };
  const streams = await resolver({ url: 'https://www.documaniatv.com/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => { pedidos.push(new URL(url).hostname); return new Response(pages[new URL(url).pathname] ?? 'x'); }
  });
  assert.deepEqual(streams, []);
  assert.deepEqual(pedidos, ['www.documaniatv.com']);
});

test('resolver devuelve lista vacía cuando no hay nada verificable', async () => {
  const streams = await resolver({ url: 'https://flixlatam.com/watch/xyz' }, {
    lookupImpl,
    fetchImpl: async () => new Response('<html>no media here</html>')
  });
  assert.deepEqual(streams, []);
});

test('resolver rechaza hosts no soportados antes de hacer fetch', async () => {
  let calls = 0;
  await assert.rejects(
    resolver({ url: 'https://evil.example/watch' }, {
      lookupImpl,
      fetchImpl: async () => { calls++; return new Response('x'); }
    }),
    /no soportado/
  );
  assert.equal(calls, 0);
});

test('resolver omite medios en hosts no confiables y bloquea destinos privados', async () => {
  const pages = { '/pelicula': '<source src="https://cdn.evil.example/a.m3u8">' };
  const allowedHosts = hostsPermitidos({});
  const streams = await resolver({ url: 'https://www.poseidonhd2.co/pelicula' }, {
    allowedHosts, lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  });
  assert.deepEqual(streams, []);
  await assert.rejects(
    resolver({ url: 'https://www.flixlatam.com/pelicula' }, {
      allowedHosts,
      lookupImpl: async () => [{ address: '127.0.0.1' }],
      fetchImpl: async () => new Response('<source src="https://www.flixlatam.com/a.m3u8">')
    }),
    /no público/
  );
});
