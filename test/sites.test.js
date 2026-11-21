const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver } = require('../engines/sites');
const lookupImpl = async () => [{ address: '93.184.216.34' }];

test('exactamente los tres sitios configurados con hosts www y sin www', () => {
  assert.deepEqual(PROVEEDORES.map(site => site.clave), ['documaniatv', 'flixlatam', 'poseidonhd2']);
  assert.equal(encontrarProveedor('www.documaniatv.com').clave, 'documaniatv');
  assert.equal(encontrarProveedor('documaniatv.com').clave, 'documaniatv');
  assert.equal(encontrarProveedor('www.flixlatam.com').clave, 'flixlatam');
  assert.equal(encontrarProveedor('www.poseidonhd2.co').clave, 'poseidonhd2');
  assert.equal(encontrarProveedor('evil.example'), null);
});

test('hostsPermitidos confía solo en los dominios del sitio por defecto', () => {
  const hosts = hostsPermitidos();
  assert.ok(hosts.includes('www.documaniatv.com'));
  assert.ok(hosts.includes('flixlatam.com'));
  assert.ok(hosts.includes('poseidonhd2.co'));
  assert.equal(hosts.includes('evil.example'), false);
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

test('resolver extrae HLS y MP4 verificados de una página del sitio, solo stream', async () => {
  const pages = {
    '/pelicula/xyz': '<source src="https://www.documaniatv.com/cdn/a.m3u8?t=1">' +
      '<script>var v="https:\\/\\/www.documaniatv.com\\/files\\/b.mp4";</script>',
    '/cdn/a.m3u8': '#EXTM3U\n#EXT-X-VERSION:3\n',
    '/files/b.mp4': Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
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
    assert.equal(stream.nombre, 'DocumaniaTV');
    assert.equal(stream.titulo, 'HLS / MP4');
  }
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
  const streams = await resolver({ url: 'https://www.poseidonhd2.co/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  });
  assert.deepEqual(streams, []);
  await assert.rejects(
    resolver({ url: 'https://www.flixlatam.com/pelicula' }, {
      lookupImpl: async () => [{ address: '127.0.0.1' }],
      fetchImpl: async () => new Response('<source src="https://www.flixlatam.com/a.m3u8">')
    }),
    /no público/
  );
});
