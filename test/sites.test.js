const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver } = require('../engines/sites');
const lookupImpl = async () => [{ address: '93.184.216.34' }];
const HLS = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8\n';

// Página de Embed69 (el reproductor real de FlixLatam) con dataLink cifrado.
function paginaEmbed69({ challenge = 'ch-1', salt = 'sa-1', grupos = [] } = {}) {
  const { claveEmbed69 } = require('../engines/resolvers/crypto');
  const clave = claveEmbed69(challenge, salt);
  const cifrar = (url) => {
    const iv = crypto.randomBytes(16);
    const cifrar2 = crypto.createCipheriv('aes-256-cbc', clave, iv);
    return Buffer.concat([iv, cifrar2.update(Buffer.from(url)), cifrar2.final()]).toString('base64');
  };
  const dataLink = grupos.map(({ idioma, servidores }) => ({
    video_language: idioma,
    sortedEmbeds: servidores.map(([servername, url]) => ({ servername, link: cifrar(url) }))
  }));
  return `<html><script>let dataLink = ${JSON.stringify(dataLink)};</script>` +
    `<script>const LINK_CHALLENGE = '${challenge}'; const LINK_SALT = '${salt}';</script></html>`;
}
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

test('solo FlixLatam está configurado, con hosts www y sin www', () => {
  assert.deepEqual(PROVEEDORES.map(site => site.clave), ['flixlatam']);
  assert.equal(encontrarProveedor('www.flixlatam.com').clave, 'flixlatam');
  assert.equal(encontrarProveedor('flixlatam.com').clave, 'flixlatam');
  // Sitios retirados: ya no se aceptan.
  assert.equal(encontrarProveedor('www.documaniatv.com'), null);
  assert.equal(encontrarProveedor('www.poseidonhd2.co'), null);
  assert.equal(encontrarProveedor('evil.example'), null);
});

test('hostsPermitidos confía en los dominios del sitio y de reproductor conocidos, no en internet', () => {
  const hosts = hostsPermitidos({});
  assert.ok(hosts.includes('flixlatam.com'));
  assert.equal(hosts.includes('www.documaniatv.com'), false);
  assert.equal(hosts.includes('poseidonhd2.co'), false);
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
  const { url, proveedor } = validarUrlSitio('https://www.flixlatam.com/pelicula/xyz');
  assert.equal(url.hostname, 'www.flixlatam.com');
  assert.equal(proveedor.clave, 'flixlatam');
  assert.throws(() => validarUrlSitio('http://www.flixlatam.com/'), /HTTPS/);
  assert.throws(() => validarUrlSitio('https://user:pass@www.flixlatam.com/'), /credenciales/);
  assert.throws(() => validarUrlSitio('https://evil.example/pelicula'), /no soportado/);
  assert.throws(() => validarUrlSitio('not a url'), /URL válida/);
  assert.throws(() => validarUrlSitio(''), /requiere/);
});

test('resolver extrae HLS y MP4 verificados de una página del sitio, con formato Stremio', async () => {
  // Ruta con guion incluida a propósito: el normalizador de barras no debe
  // convertir 'a-b.mp4' en 'a/b.mp4' (bug real corregido en parsePage).
  const pages = {
    '/pelicula/xyz': '<source src="https://www.flixlatam.com/cdn/a.m3u8?t=1">' +
      '<script>var v="https:\\\\/\\\\/www.flixlatam.com\\\\/files\\\\/b-c.mp4";</script>',
    '/cdn/a.m3u8': HLS,
    '/files/b-c.mp4': MP4
  };
  const streams = await resolver({ url: 'https://www.flixlatam.com/pelicula/xyz' }, {
    lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  });
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map(s => s.url), [
    'https://www.flixlatam.com/cdn/a.m3u8?t=1',
    'https://www.flixlatam.com/files/b-c.mp4'
  ]);
  for (const stream of streams) {
    // Claves del objeto Stream de Stremio: antes se devolvían nombre/titulo,
    // que el cliente ignora.
    assert.equal(stream.name, 'FlixLatam');
    assert.equal(stream.title, 'HLS / MP4');
    assert.equal(stream.nombre, undefined);
    assert.equal(stream.titulo, undefined);
    assert.doesNotThrow(() => new URL(stream.url));
  }
});

test('resolver sigue el flujo real: ficha → Embed69 → servidor → HLS', async () => {
  // FlixLatam no publica .m3u8 en su HTML: entrega un iframe del reproductor
  // Embed69, que sí trae los servidores (cifrados). El test cubre esa cadena.
  const pedidos = [];
  const embed = paginaEmbed69({ grupos: [{ idioma: 'LAT', servidores: [['voe', 'https://voe.sx/e/abc']] }] });
  const paginas = {
    'flixlatam.com/pelicula': '<iframe src="https://embed69.org/f/tt1/"></iframe>',
    'embed69.org/f/tt1/': embed,
    'voe.sx/e/abc': '<script type="application/json">{"source":"https://voe.sx/hls/master.m3u8"}</script>'
  };
  const streams = await resolver({ url: 'https://flixlatam.com/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => {
      pedidos.push(url.hostname + url.pathname);
      return new Response(url.pathname.endsWith('.m3u8') ? HLS : (paginas[url.hostname + url.pathname] ?? ''));
    }
  });
  assert.deepEqual(streams.map(s => s.url), ['https://voe.sx/hls/master.m3u8']);
  assert.deepEqual(streams.map(s => s.title), ['LAT · Voe']);
  assert.equal(streams[0].name, 'FlixLatam');
  assert.ok(pedidos.includes('embed69.org/f/tt1/'), 'debe abrir el reproductor de Embed69');
});

test('resolver NUNCA autoriza hosts descubiertos en el HTML (SSRF)', async () => {
  // Antes bastaba con que la página "confiable" incluyera un src a cualquier
  // host para que el servidor lo descargara y lo devolviera como stream.
  const pedidos = [];
  const pages = { '/pelicula': '<source src="https://cdn-atacante.example/robar.m3u8">' };
  const streams = await resolver({ url: 'https://www.flixlatam.com/pelicula' }, {
    lookupImpl,
    fetchImpl: async url => { pedidos.push(new URL(url).hostname); return new Response(pages[new URL(url).pathname] ?? 'x'); }
  });
  assert.deepEqual(streams, []);
  assert.deepEqual(pedidos, ['www.flixlatam.com']);
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
  assert.deepEqual(await resolver({ url: 'https://www.flixlatam.com/pelicula' }, {
    allowedHosts, lookupImpl,
    fetchImpl: async url => new Response(pages[new URL(url).pathname])
  }), []);
  await assert.rejects(
    resolver({ url: 'https://www.flixlatam.com/pelicula' }, {
      allowedHosts,
      lookupImpl: async () => [{ address: '127.0.0.1' }],
      fetchImpl: async () => new Response('<source src="https://www.flixlatam.com/a.m3u8">')
    }),
    /no público/
  );
});

test('resuelve un servidor uqload descifrado de Embed69', async () => {
  // Embed69 también devuelve uqload; el registry debe resolverlo con su
  // resolvedor (P.A.C.K.E.R.) y no descartarlo.
  const embed = paginaEmbed69({ grupos: [{ idioma: 'LAT', servidores: [['uqload', 'https://uqload.com/embed-abc.html']] }] });
  const packed = `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};` +
    `while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}` +
    `('0="1://uq.example/e/abc/index.m3u8";',36,2,'sources|https'.split('|'),0,{}))`;
  const paginas = {
    'flixlatam.com/pelicula/patton': '<iframe src="https://embed69.org/f/tt9/"></iframe>',
    'embed69.org/f/tt9/': embed,
    'uqload.com/embed-abc.html': packed
  };
  const streams = await resolver({ url: 'https://flixlatam.com/pelicula/patton' }, {
    lookupImpl,
    allowedHosts: [...hostsPermitidos({}), 'uq.example'],
    fetchImpl: async url => new Response(url.pathname.endsWith('.m3u8') ? HLS : (paginas[url.hostname + url.pathname] ?? ''))
  });
  assert.deepEqual(streams.map(s => s.url), ['https://uq.example/e/abc/index.m3u8']);
  assert.equal(streams[0].title, 'LAT · Uqload');
});