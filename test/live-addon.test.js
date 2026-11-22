const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../index');
const { createCatalog, mergeSources } = require('../engines/live/catalog');
const { buildM3u, parseM3u } = require('../engines/live/m3u');
const addon = require('../engines/live/addon');

const CHANNELS = [
  {
    id: 'es-la-1', key: 'ES:la-1', name: 'La 1', country: 'ES', origin: 'ES', category: 'Generalista',
    logo: 'https://logos.example/la1.png', geoBlocked: false, sources: ['eja', 'tvgarden'],
    streams: [
      { url: 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8', source: 'eja.tv' },
      { url: 'https://backup.example/la1.m3u8', source: 'tvgarden.world' }
    ], playable: true
  },
  {
    id: 'es-antena-3', key: 'ES:antena-3', name: 'Antena 3', country: 'ES', origin: 'ES', category: 'Deportes',
    logo: null, geoBlocked: true, sources: ['tvenvivo.org'],
    streams: [{ url: 'https://www.tvenvivo.org/antena-3-en-vivo-online.php', kind: 'page', source: 'tvenvivo.org' }],
    playable: false
  },
  {
    id: 'mx-canal-5', key: 'MX:canal-5', name: 'Canal 5', country: 'LATAM', origin: 'MX', category: 'Generalista',
    logo: null, geoBlocked: false, sources: ['livelive24.com'], streams: [], externalUrl: 'https://livelive24.com/?ch=5',
    info: 'Enlace solo en la web original', playable: false
  }
];

const fakeCatalog = () => createCatalog({
  sources: [{ id: 'eja', collect: async () => CHANNELS.slice(0, 2) }, { id: 'livelive24', collect: async () => CHANNELS.slice(2) }],
  fetchGet: async () => { throw new Error('no debe usarse'); }
});

async function withServer(catalog, callback, options = {}) {
  // Sin verificador salvo que la prueba lo pida: así no hay red ni esperas.
  // `options` va primero para que sus claves no pisen el `checker: null`.
  const app = createApp({ catalog, ...options, checker: options.checker ?? null });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('mergeSources agrupa el mismo canal de varias fuentes y conserva todos sus medios', () => {
  const merged = mergeSources([
    { id: 'eja', entries: [{ name: 'La 1', country: 'ES', key: 'ES:la-1', streams: [{ url: 'https://a.example/1.m3u8' }] }] },
    { id: 'tvgarden', entries: [{ name: 'La 1', country: 'ES', key: 'ES:la-1', streams: [{ url: 'https://a.example/1.m3u8' }, { url: 'https://b.example/1.m3u8' }] }] }
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ['eja', 'tvgarden']);
  assert.equal(merged[0].streams.length, 2);
  assert.equal(merged[0].playable, true);
});

test('el catálogo nunca lanza: una fuente caída no oculta las demás', async () => {
  const catalog = createCatalog({
    sources: [
      { id: 'rota', collect: async () => { throw new Error('boom'); } },
      { id: 'eja', collect: async () => CHANNELS.slice(0, 1) }
    ],
    fetchGet: async () => ({ text: '' })
  });
  const loaded = await catalog.load();
  assert.equal(loaded.channels.length, 1);
  assert.equal(loaded.status.rota.ok, false);
  assert.match(loaded.status.rota.error, /boom/);
  assert.equal(loaded.status.eja.ok, true);
});

test('mergeSources: unifica el país venga como venga (`cl`, `CL`, `Chile`)', () => {
  const merged = mergeSources([
    { id: 'a', entries: [{ name: 'Mega', country: 'LATAM', origin: 'cl', streams: [{ url: 'https://a/1.m3u8', kind: 'hls' }] }] },
    { id: 'b', entries: [{ name: 'TVN', country: 'LATAM', origin: 'CL', streams: [{ url: 'https://a/2.m3u8', kind: 'hls' }] }] },
    { id: 'c', entries: [{ name: 'Canal 13', country: 'LATAM', origin: 'Chile', streams: [{ url: 'https://a/3.m3u8', kind: 'hls' }] }] },
    { id: 'd', entries: [{ name: 'La Red', country: 'LATAM', origin: 'Chile', streams: [{ url: 'https://a/4.m3u8', kind: 'hls' }] }] }
  ]);
  assert.ok(merged.every(channel => channel.origin === 'CL'));
  assert.ok(merged.every(channel => channel.id.startsWith('cl-')), 'el id usa el país real');
  assert.deepEqual(merged.map(channel => channel.country), ['LATAM', 'LATAM', 'LATAM', 'LATAM']);
  // Un canal sin país en la fuente pero con bandera en el nombre también se etiqueta.
  const flagged = mergeSources([{ id: 'e', entries: [{ name: 'Azteca 🇲🇽', country: 'LATAM', streams: [{ url: 'https://a/5.m3u8', kind: 'hls' }] }] }]);
  assert.equal(flagged[0].origin, 'MX');
});

test('manifest: cabe en 8 KB e incluye el prefijo de las regiones', () => {
  const manifest = addon.manifest();
  // Stremio puede rechazar un manifiesto demasiado grande.
  assert.ok(JSON.stringify(manifest).length < 8192, `pesa ${JSON.stringify(manifest).length} bytes`);
  // Los canales sin país llevan id `latam-…`: sin ese prefijo sus enlaces fallan.
  assert.ok(manifest.idPrefixes.includes('latam-'));
  // Un género por país en «Todos», no 126 combinaciones país·categoría.
  const genres = manifest.catalogs[0].extra[0].options;
  assert.ok(genres.includes('México'));
  assert.ok(!genres.includes('México · Deportes'));
  assert.equal(new Set(manifest.catalogs.map(catalog => catalog.id)).size, manifest.catalogs.length);
});

test('manifest: tipo tv, un catálogo por país y prefijos de país', () => {
  const manifest = addon.manifest();
  assert.deepEqual(manifest.types, ['tv']);
  // Prefijo por país: los ids de canal empiezan por su país real.
  assert.ok(manifest.idPrefixes.includes('mx-'));
  assert.ok(manifest.idPrefixes.includes('us-'));
  assert.ok(manifest.idPrefixes.includes('es-'));
  assert.ok(manifest.catalogs.every(catalog => catalog.type === 'tv'));
  assert.ok(manifest.catalogs[0].extra.some(extra => extra.name === 'skip'));
  // Una entrada por país más las generales.
  const byId = Object.fromEntries(manifest.catalogs.map(catalog => [catalog.id, catalog]));
  assert.equal(byId['pais-mx'].name, 'TV · México');
  assert.equal(byId['pais-us'].name, 'TV · Estados Unidos');
  assert.ok(byId['pais-mx'].extra[0].options.includes('México · Deportes'));
  assert.ok(byId.sinpais, 'los canales sin país tienen su propio catálogo');
  assert.ok(byId.todos && byId.deportes && byId.caidos);
});

test('catálogo por país: filtra por el país real del canal', () => {
  const channels = [
    ...CHANNELS,
    { id: 'mx-canal-5', key: 'MX:canal-5', name: 'Canal 5', country: 'LATAM', origin: 'MX', category: 'Generalista',
      sources: ['x'], streams: [{ url: 'https://mx.example/5.m3u8', kind: 'hls' }], playable: true },
    { id: 'us-univision', key: 'US:univision', name: 'Univision', country: 'US', origin: 'US', category: 'Generalista',
      language: 'es', sources: ['x'], streams: [{ url: 'https://us.example/1.m3u8', kind: 'hls' }], playable: true },
    { id: 'us-cnn', key: 'US:cnn', name: 'CNN', country: 'US', origin: 'US', category: 'Noticias',
      language: 'en', sources: ['x'], streams: [{ url: 'https://us.example/cnn.m3u8', kind: 'hls' }], playable: true }
  ];
  assert.deepEqual(addon.catalog(channels, 'pais-mx', '', 0).metas.map(meta => meta.name), ['Canal 5']);
  assert.deepEqual(addon.catalog(channels, 'pais-us', '', 0).metas.map(meta => meta.name).sort(), ['CNN', 'Univision']);
  assert.equal(addon.catalog(channels, 'us', '', 0).metas.length, 2, 'la región US incluye los dos');
  assert.equal(addon.catalog(channels, 'pais-us', 'Estados Unidos · Noticias', 0).metas.length, 1);
  assert.equal(addon.catalog(channels, 'pais-us', 'Estados Unidos · Deportes', 0).metas.length, 0);
  // El género de un país no debe arrastrar canales de otro.
  assert.equal(addon.catalog(channels, 'pais-mx', 'Estados Unidos · Generalista', 0).metas.length, 0);
  // `sinpais` deja fuera lo que sí tiene país.
  const sinPais = addon.catalog([...channels,
    { id: 'latam-x', key: 'LATAM:x', name: 'X', country: 'LATAM', origin: 'Internacional', category: 'Generalista',
      sources: ['pluto'], streams: [{ url: 'https://x/x.m3u8', kind: 'hls' }], playable: true }], 'sinpais', '', 0);
  assert.deepEqual(sinPais.metas.map(meta => meta.name), ['X']);
});

test('catálogo Stremio: solo canales publicables, paginado y filtros', () => {
  const all = addon.catalog(CHANNELS, 'todos', '', 0);
  assert.equal(all.metas.length, 2); // Canal 5 no tiene ninguna vía de reproducción
  assert.deepEqual(all.metas.map(meta => meta.id), ['es-la-1', 'es-antena-3']);
  assert.equal(all.metas[0].type, 'tv');
  assert.equal(all.metas[0].poster, 'https://logos.example/la1.png');

  assert.deepEqual(addon.catalog(CHANNELS, 'espana', '', 0).metas.length, 2);
  assert.equal(addon.catalog(CHANNELS, 'latinoamerica', '', 0).metas.length, 0);
  assert.equal(addon.catalog(CHANNELS, 'deportes', '', 0).metas.length, 1);
  assert.equal(addon.catalog(CHANNELS, 'todos', 'España', 0).metas.length, 2);
  assert.equal(addon.catalog(CHANNELS, 'todos', '', 1).metas.length, 1);
});

test('streams: directos tal cual, `page` resuelto y sin URL inventada', async () => {
  const direct = await addon.streams(CHANNELS[0], {});
  assert.equal(direct.length, 2);
  assert.equal(direct[0].url, 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8');

  let calls = 0;
  const resolved = await addon.streams(CHANNELS[1], {
    resolvePage: async () => { calls++; return { url: 'https://deportes.example/1/index.m3u8?token=x', referer: 'https://deportes.example/' }; }
  });
  assert.equal(calls, 1);
  assert.equal(resolved[0].url, 'https://deportes.example/1/index.m3u8?token=x');
  assert.equal(resolved[0].behaviorHints.proxyHeaders.request.Referer, 'https://deportes.example/');

  const unresolved = await addon.streams(CHANNELS[1], { resolvePage: async () => null });
  assert.deepEqual(unresolved, []);

  const catalogOnly = await addon.streams(CHANNELS[2], {});
  assert.equal(catalogOnly[0].externalUrl, 'https://livelive24.com/?ch=5');
  assert.equal(catalogOnly[0].url, undefined);
});

test('M3U: solo medios publicables, atributos IPTV y resolución opcional', async () => {
  const direct = await buildM3u(CHANNELS, {});
  assert.equal(direct.count, 2);
  const items = parseM3u(direct.body);
  assert.equal(items.length, 2);
  assert.equal(items[0].attrs['group-title'], 'España · Generalista');
  assert.equal(items[0].attrs['tvg-logo'], 'https://logos.example/la1.png');
  assert.equal(items[0].attrs.source, 'eja.tv');
  assert.ok(direct.body.startsWith('#EXTM3U'));
  assert.ok(!direct.body.includes('tvenvivo.org'));

  const withPages = await buildM3u(CHANNELS, { resolve: async () => ({ url: 'https://deportes.example/1/index.m3u8', referer: 'https://deportes.example/' }) });
  assert.equal(withPages.count, 3);
  assert.ok(withPages.body.includes('#EXTVLCOPT:http-referrer=https://deportes.example/'));
});

test('rutas HTTP: manifest, catálogo, meta, stream, M3U y config', async () => {
  await withServer(fakeCatalog(), async base => {
    const manifest = await (await fetch(base + '/manifest.json')).json();
    assert.equal(manifest.id, 'org.tvespanol.live');
    assert.ok(manifest.catalogs.some(catalog => catalog.id === 'pais-mx'));

    const catalog = await (await fetch(base + '/catalog/tv/todos.json')).json();
    assert.equal(catalog.metas.length, 2);

    const paged = await (await fetch(base + '/catalog/tv/todos/skip=1.json')).json();
    assert.equal(paged.metas.length, 1);

    const genre = await (await fetch(base + '/catalog/tv/todos/genre=' + encodeURIComponent('España') + '.json')).json();
    assert.equal(genre.metas.length, 2);

    const meta = await (await fetch(base + '/meta/tv/es-la-1.json')).json();
    assert.equal(meta.meta.name, 'La 1');

    const streams = await (await fetch(base + '/stream/tv/es-la-1.json')).json();
    assert.equal(streams.streams.length, 2);

    const unknown = await (await fetch(base + '/stream/tv/xx-nada.json')).json();
    assert.deepEqual(unknown, { streams: [] });

    const bad = await fetch(base + '/stream/tv/INVALID!.json');
    assert.equal(bad.status, 400);

    const playlist = await fetch(base + '/playlist/es.m3u');
    assert.match(playlist.headers.get('content-type'), /mpegurl/);
    assert.equal(playlist.headers.get('x-channel-count'), '2');

    const latam = await fetch(base + '/playlist/latam.m3u');
    assert.equal(latam.headers.get('x-channel-count'), '0');

    // Una lista M3U por país; `mx` no debe traer canales de España.
    const mexico = await fetch(base + '/playlist/mx.m3u');
    assert.match(playlist.headers.get('content-type'), /mpegurl/);
    assert.equal(mexico.headers.get('x-channel-count'), '0');

    // Un catálogo de país desconocido devuelve 404, no una lista vacía.
    const unknownCountry = await fetch(base + '/catalog/tv/pais-zz.json');
    assert.equal(unknownCountry.status, 404);

    const listed = await (await fetch(base + '/playlists.json')).json();
    assert.equal(listed.playlists.find(entry => entry.id === 'es').channels, 2);

    const config = await (await fetch(base + '/config')).json();
    assert.equal(config.ok, true);
    assert.equal(config.catalog.counts.total, 3);
  }, { resolve: async () => ({ url: 'https://deportes.example/1/index.m3u8', referer: null }) });
});

test('stream/page valida el host antes de cualquier petición', async () => {
  await withServer(fakeCatalog(), async base => {
    let calls = 0;
    const resolve = async () => { calls++; return { url: 'https://x.example/a.m3u8' }; };
    const app = createApp({ catalog: fakeCatalog(), resolve });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const localBase = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(localBase + '/stream/page')).status, 400);
      assert.equal((await fetch(localBase + '/stream/page?url=http://evil.example/x')).status, 400);
      assert.equal((await fetch(localBase + '/stream/page?url=https://evil.example/x')).status, 400);
      assert.equal(calls, 0);
    } finally {
      await new Promise(done => server.close(done));
    }
  });
});

test('CORS y 404 consistente', async () => {
  await withServer(fakeCatalog(), async base => {
    const preflight = await fetch(base + '/manifest.json', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(base + '/catalog/movie/x.json')).status, 404);
    assert.equal((await fetch(base + '/playlist/otra.m3u')).status, 404);
    assert.equal((await fetch(base + '/meta/movie/es-la-1.json')).status, 404);
  });
});

test('fallo total de fuentes: 503 en vez de playlist vacía', async () => {
  const failing = createCatalog({
    sources: [{ id: 'eja', collect: async () => { throw new Error('caída simulada'); } }],
    fetchGet: async () => { throw new Error('sin red'); }
  });
  await withServer(failing, async base => {
    for (const path of ['/playlist/all.m3u', '/catalog/tv/todos.json', '/playlists.json']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get('retry-after'), '30', path);
    }
  });
});

test('catálogo vacío no sustituye a la copia buena y se marca stale', async () => {
  let empty = false;
  const flaky = createCatalog({
    ttlMs: 0,
    sources: [{ id: 'eja', collect: async () => (empty ? [] : CHANNELS.slice(0, 2)) }],
    fetchGet: async () => { throw new Error('sin red'); }
  });
  const first = await flaky.load();
  assert.equal(first.counts.total, 2);
  empty = true;
  const second = await flaky.load();
  assert.equal(second.stale, true);
  assert.equal(second.counts.total, 2);
  assert.match(second.staleReason, /Ninguna fuente devolvió canales/);
});
