// Extracción de HLS de fuentes con embeds: cadena de iframes, firma del medio y
// degradación a enlace de página cuando el embed no coopera.
const test = require('node:test');
const assert = require('node:assert/strict');
const { enrich, extractChannel, extractable, genericResolve, findHlsLiteral, resolveSource } = require('../engines/live/extract');
const { createCatalog } = require('../engines/live/catalog');

const PAGE_CHANNEL = {
  id: 'es-antena-3',
  name: 'Antena 3',
  country: 'ES',
  sources: ['tvenvivo.org'],
  streams: [{ url: 'https://www.tvenvivo.org/antena-3-en-vivo-online.php', kind: 'page', source: 'tvenvivo.org' }]
};

const HLS = 'https://edge.example/live/antena3/index.m3u8?token=abc';

// Fuente falsa con `resolve` programable.
const fakeSource = resolved => ({
  id: 'tvenvivo',
  name: 'tvenvivo.org',
  resolve: async () => resolved
});
const byId = resolved => () => fakeSource(resolved);
const HLS_PROBE = async () => ({ ok: true, status: 200, signature: true, contentType: 'application/vnd.apple.mpegurl' });

test('findHlsLiteral: escapado, atributo, query y porcentaje; nada de inventar', () => {
  assert.equal(findHlsLiteral(String.raw`var u = "https:\/\/cdn.example\/1\/i.m3u8?t=1";`), 'https://cdn.example/1/i.m3u8?t=1');
  assert.equal(findHlsLiteral('<source src="https://cdn.example/2/i.m3u8">'), 'https://cdn.example/2/i.m3u8');
  assert.equal(findHlsLiteral(String.raw`{"file":"https://x/a.m3u8?tk=9\u0026b=2"}`), 'https://x/a.m3u8?tk=9&b=2');
  assert.equal(findHlsLiteral('var u = "https%3A%2F%2Fcdn.example%2F5%2Fi.m3u8%3Ft%3D3";'), 'https://cdn.example/5/i.m3u8?t=3');
  assert.equal(findHlsLiteral('<script src="https://cdn.example/app.js"></script>'), null);
  assert.equal(findHlsLiteral('<p>sin medio</p>'), null);
});

test('genericResolve sigue el iframe del reproductor y saca el HLS', async () => {
  const get = async url => (url.includes('player.example')
    ? { status: 200, text: String.raw`<script>hls.load("https:\/\/cdn.example\/vivo\/1\/i.m3u8")</script>`, url }
    : { status: 200, text: '<iframe src="https://player.example/e/1"></iframe>', url });
  const resolved = await genericResolve('https://blog.example/p/x.html?id=1', { get });
  assert.equal(resolved.url, 'https://cdn.example/vivo/1/i.m3u8');
  assert.equal(resolved.referer, 'https://player.example/');
});

test('extractChannel publica el HLS solo si el medio responde con firma', async () => {
  const canal = structuredClone(PAGE_CHANNEL);
  const ok = await extractChannel(canal, { get: async () => ({}), byId: byId({ url: HLS, referer: 'https://edge.example/' }), probe: HLS_PROBE });
  assert.equal(ok, 'extracted');
  assert.equal(canal.streams[0].kind, 'hls');
  assert.equal(canal.streams[0].url, HLS);
  assert.equal(canal.streams[0].referer, 'https://edge.example/');
  assert.equal(canal.streams[1].kind, 'page', 'se conserva el enlace de página');

  // El CDN responde 403: no se publica un medio que no reproduce.
  const blocked = structuredClone(PAGE_CHANNEL);
  const fail = await extractChannel(blocked, {
    get: async () => ({}),
    byId: byId({ url: HLS }),
    probe: async () => ({ ok: false, status: 403, error: 'HTTP 403' })
  });
  assert.equal(fail, 'failed');
  assert.equal(blocked.streams.length, 1);
  assert.equal(blocked.streams[0].kind, 'page');

  // Embed roto: tampoco se inventa nada.
  const roto = structuredClone(PAGE_CHANNEL);
  assert.equal(await extractChannel(roto, { get: async () => ({}), byId: byId(null), probe: HLS_PROBE }), 'failed');
  assert.equal(roto.streams.length, 1);
});

test('enrich solo mira canales sin medio directo y respeta el presupuesto', async () => {
  assert.equal(extractable([PAGE_CHANNEL]).length, 1);
  assert.equal(extractable([{ streams: [{ url: HLS }] }]).length, 0);
  assert.equal(extractable([{ streams: [] }]).length, 0);

  const canal = structuredClone(PAGE_CHANNEL);
  let reloj = 0;
  const counts = await enrich([canal], {
    get: async () => ({}),
    byId: byId({ url: HLS }),
    probe: HLS_PROBE,
    now: () => { reloj += 1000; return reloj; },
    budgetMs: 10
  });
  assert.deepEqual(counts, { targets: 1, extracted: 0, failed: 0, skipped: 1 });
  assert.equal(canal.streams.length, 1, 'sin presupuesto no se toca');
});

test('el catálogo extrae tras recolectar y lo deja en status._extract', async () => {
  const catalog = createCatalog({
    sources: [{ id: 'tvenvivo', collect: async () => [structuredClone(PAGE_CHANNEL)] }],
    fetchGet: async () => { throw new Error('no debe usarse'); },
    extract: async channels => enrich(channels, {
      get: async () => ({}),
      byId: byId({ url: HLS }),
      probe: HLS_PROBE
    })
  });
  const loaded = await catalog.load();
  assert.equal(loaded.channels.length, 1);
  assert.equal(loaded.channels[0].streams[0].kind, 'hls');
  assert.equal(loaded.channels[0].playable, true);
  assert.equal(loaded.status._extract.extracted, 1);
});

test('un extractor que revienta no tumba la recolección', async () => {
  const catalog = createCatalog({
    sources: [{ id: 'tvenvivo', collect: async () => [structuredClone(PAGE_CHANNEL)] }],
    fetchGet: async () => { throw new Error('no debe usarse'); },
    extract: async () => { throw new Error('embed caído'); }
  });
  const loaded = await catalog.load();
  assert.equal(loaded.channels.length, 1);
  assert.equal(loaded.status._extract.ok, false);
  assert.match(loaded.status._extract.error, /embed caído/);
});


test('la fuente se resuelve por nombre visible y no por id (regresión)', () => {
  const byId = id => (id === 'tvenvivo' ? { id: 'tvenvivo', name: 'tvenvivo.org', resolve: async () => null } : null);
  // Los streams guardan el host (`tvenvivo.org`), no el id del registro.
  assert.equal(resolveSource(byId, 'tvenvivo.org').id, 'tvenvivo');
  assert.equal(resolveSource(byId, 'tvenvivo').id, 'tvenvivo');
  assert.equal(resolveSource(byId, 'desconocido.tv'), null);
  assert.equal(resolveSource(byId, null), null);
});
