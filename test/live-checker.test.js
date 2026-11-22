// Verificador de señales: sondeo, clasificación y efecto en M3U/Stremio.
// Todas las pruebas inyectan `probe`/`get`, así que no tocan la red.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../index');
const { createCatalog } = require('../engines/live/catalog');
const addon = require('../engines/live/addon');
const {
  createChecker, checkChannel, probeMedia, looksPlayable, summarize, applyReport, checkable
} = require('../engines/live/checker');

const CHANNELS = [
  {
    id: 'es-la-1', key: 'ES:la-1', name: 'La 1', country: 'ES', origin: 'ES', category: 'Generalista',
    sources: ['eja'], playable: true,
    streams: [{ url: 'https://ok.example/la1.m3u8', source: 'eja.tv' }]
  },
  {
    id: 'es-viva', key: 'ES:viva', name: 'Viva', country: 'ES', origin: 'ES', category: 'Generalista',
    sources: ['tvgarden'], playable: true,
    streams: [{ url: 'https://muerto.example/viva.m3u8', source: 'tvgarden.world' }]
  },
  {
    id: 'latam-canal-5', key: 'LATAM:canal-5', name: 'Canal 5', country: 'LATAM', origin: 'Mexico',
    category: 'Generalista', sources: ['livelive24.com'], playable: false, streams: [],
    externalUrl: 'https://livelive24.com/?ch=5'
  },
  {
    id: 'latam-solo-pagina', key: 'LATAM:solo-pagina', name: 'Solo Página', country: 'LATAM', origin: 'Peru',
    category: 'Generalista', sources: ['tvenvivo.org'], playable: false,
    streams: [{ url: 'https://www.tvenvivo.org/x-en-vivo-online.php', kind: 'page', source: 'tvenvivo.org' }]
  }
];

// Sonda falsa: `caidos` contiene las URLs que deben fallar.
function fakeProbe(caidos = []) {
  return async (url, options) => {
    const falla = caidos.some(entry => url.includes(entry));
    return falla
      ? { ok: false, status: 404, signature: false, error: 'HTTP 404' }
      : { ok: true, status: 200, signature: true, contentType: 'application/vnd.apple.mpegurl', error: null };
  };
}

const fakeCatalog = () => createCatalog({
  sources: [{ id: 'eja', collect: async () => CHANNELS }],
  fetchGet: async () => { throw new Error('no debe usarse'); }
});

async function withServer(catalog, callback, options = {}) {
  const app = createApp({ catalog, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('looksPlayable distingue HLS, MP4 y páginas HTML', () => {
  assert.equal(looksPlayable('#EXTM3U\n#EXT-X-VERSION:3'), true);
  assert.equal(looksPlayable('  \uFEFF#EXTM3U'), true);
  assert.equal(looksPlayable('\u001aE\ufffd\ufffdftypisom'), true);
  assert.equal(looksPlayable('<!doctype html><html>'), false);
  assert.equal(looksPlayable('<html>'), false);
  assert.equal(looksPlayable(''), false);
});

test('probeMedia: éxito, 404 y caída de red se clasifican sin lanzar', async () => {
  const ok = await probeMedia('https://ok.example/a.m3u8', { get: async () => ({ status: 200, text: '#EXTM3U\n', contentType: 'x' }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.signature, true);

  const html = await probeMedia('https://ok.example/a.php', { get: async () => ({ status: 200, text: '<!doctype html>hola' }) });
  assert.equal(html.ok, false);
  assert.match(html.error, /sin firma/);

  const http404 = await probeMedia('https://ok.example/x', { get: async () => { throw new Error('HTTP 404'); } });
  assert.deepEqual([http404.ok, http404.status], [false, 404]);

  const red = await probeMedia('https://ok.example/x', { get: async () => { throw new Error('fetch failed'); } });
  assert.deepEqual([red.ok, red.status], [false, 'red']);

  const timeouts = await probeMedia('https://ok.example/x', { get: async () => { throw new Error('The operation was aborted due to timeout'); } });
  assert.equal(timeouts.status, 'timeout');
});

test('checkChannel: basta un medio directo vivo; si no, prueba la página', async () => {
  const channel = {
    id: 'x', streams: [
      { url: 'https://muerto.example/a.m3u8', source: 'eja.tv' },
      { url: 'https://ok.example/b.m3u8', source: 'tvgarden.world' }
    ]
  };
  const result = await checkChannel(channel, { get: async () => {}, probe: fakeProbe(['muerto.example']) });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'direct');
  assert.equal(result.attempts.length, 2);

  const page = {
    id: 'y',
    streams: [{ url: 'https://www.tvenvivo.org/x-en-vivo-online.php', kind: 'page', source: 'tvenvivo.org' }]
  };
  let resuelto = 0;
  const conPagina = await checkChannel(page, {
    get: async () => {},
    probe: fakeProbe(),
    resolvePage: async () => { resuelto++; return { url: 'https://edge.example/y.m3u8', referer: 'https://www.tvenvivo.org/' }; }
  });
  assert.deepEqual([conPagina.ok, conPagina.via, resuelto], [true, 'page', 1]);

  const sinResolver = await checkChannel(page, { get: async () => {}, probe: fakeProbe(), resolvePage: async () => null });
  assert.equal(sinResolver.ok, true, 'no se puede afirmar que esté caído');
  assert.equal(sinResolver.unconfirmed, true);
  assert.equal(sinResolver.attempts[0].error, 'no resuelto');
});

test('crear informe: caídos exactos, desconocidos y catálogo no verificable', async () => {
  const checker = createChecker({ get: async () => {}, channels: CHANNELS, probe: fakeProbe(['muerto.example']) });
  const report = await checker.run();
  assert.equal(report.total, 3, 'no se verifica el canal de catálogo');
  assert.equal(report.alive, 1);
  assert.equal(report.dead, 1);
  assert.equal(report.unknown, 1, 'página sin resolutor = desconocido, no caído');
  assert.equal(report.results['es-viva'].dead, true);
  assert.equal(report.results['es-la-1'].dead, false);
  assert.equal(report.results['latam-solo-pagina'].ok, null);
  assert.equal(report.results['latam-solo-pagina'].dead, false);
  assert.equal(report.results['latam-canal-5'], undefined);
  assert.equal(report.selfCheck.inconclusive, false);
});

test('un entorno sin red marca el informe como no concluyente (solo con muestra suficiente)', async () => {
  const muchos = Array.from({ length: 8 }, (_, index) => ({
    id: `es-${index}`,
    name: `Canal ${index}`,
    country: 'ES',
    sources: ['eja'],
    streams: [{ url: `https://caido.example/${index}.m3u8`, source: 'eja.tv' }]
  }));
  const sinRed = createChecker({
    get: async () => {},
    channels: muchos,
    probe: async () => ({ ok: false, status: 'red', error: 'fetch failed' })
  });
  const informe = await sinRed.run();
  assert.equal(informe.dead, 8);
  assert.equal(informe.selfCheck.inconclusive, true);
  assert.equal(informe.selfCheck.ratio, 0);

  // Con una muestra pequeña no se declara nada: puede haber 3 canales caídos de verdad.
  const pocos = createChecker({
    get: async () => {},
    channels: CHANNELS,
    resolvePage: async () => ({ url: 'https://edge.example/x.m3u8' }),
    probe: async () => ({ ok: false, status: 'red', error: 'fetch failed' })
  });
  const corto = await pocos.run();
  assert.equal(corto.dead, 3);
  assert.equal(corto.selfCheck.inconclusive, false);
});

test('applyReport y summarize: dead, health y listado de caídos', () => {
  const report = {
    checkedAt: '2026-01-01T00:00:00.000Z',
    results: {
      'es-la-1': { ok: true, dead: false, via: 'direct', attempts: [{ status: 200 }] },
      'es-viva': { ok: false, dead: true, via: 'direct', attempts: [{ status: 404, error: 'HTTP 404' }] }
    }
  };
  const applied = applyReport(CHANNELS, report);
  assert.equal(applied[0].dead, false);
  assert.equal(applied[1].dead, true);
  assert.equal(applied[2].dead, undefined, 'sin informe no se toca');
  assert.equal(applied[1].health.checkedAt, report.checkedAt);

  const summary = summarize(CHANNELS, report);
  assert.deepEqual([summary.checked, summary.alive, summary.dead, summary.unchecked], [2, 1, 1, 2]);
  assert.equal(summary.deadChannels.length, 1);
  assert.equal(summary.deadChannels[0].id, 'es-viva');
  assert.equal(summary.deadChannels[0].status, 404);

  assert.equal(checkable(CHANNELS).length, 3);
});

test('el informe se reutiliza mientras sea fresco y se puede forzar', async () => {
  let sondeos = 0;
  const checker = createChecker({
    get: async () => {},
    channels: CHANNELS,
    probe: async () => { sondeos++; return { ok: true, status: 200 }; },
    now: () => 1000,
    resultTtlMs: 60000
  });
  await checker.run();
  const primera = sondeos;
  const cacheada = await checker.run();
  assert.equal(cacheada.cached, true);
  assert.equal(sondeos, primera, 'no vuelve a sondear');
  await checker.run({ force: true });
  assert.ok(sondeos > primera, 'forzar sí vuelve a sondear');
  assert.equal(checker.fresh(), true);
});

test('M3U excluye los caídos y ?dead=1 los recupera', async () => {
  const catalog = fakeCatalog();
  const checker = createChecker({
    get: async () => {},
    channels: CHANNELS,
    resolvePage: async () => ({ url: 'https://edge.example/p.m3u8' }),
    probe: fakeProbe(['muerto.example'])
  });
  // El servidor real lanza la verificación al arrancar; aquí se precalienta.
  catalog.setHealth(await checker.run());
  await withServer(catalog, async base => {
    const sinCaidos = await fetch(base + '/playlist/es.m3u');
    const cuerpo = await sinCaidos.text();
    assert.equal(sinCaidos.headers.get('x-channel-count'), '1');
    assert.match(cuerpo, /La 1/);
    assert.doesNotMatch(cuerpo, /Viva/);

    const conCaidos = await fetch(base + '/playlist/es.m3u?dead=1');
    assert.equal(conCaidos.headers.get('x-channel-count'), '2');
    assert.match(await conCaidos.text(), /Viva/);

    const listado = await (await fetch(base + '/playlists.json')).json();
    assert.equal(listado.playlists.find(entry => entry.id === 'es').channels, 1);
    assert.equal(listado.health.dead, 1);

    // Las páginas resueltas tampoco desaparecen de la lista de Latinoamérica.
    const latam = await (await fetch(base + '/playlist/latam.m3u?pages=1')).text();
    assert.match(latam, /Solo Página/);
  }, { checker, resolve: async () => ({ url: 'https://edge.example/p.m3u8', referer: null }) });
});

test('rutas de salud: resumen con recuento, caídos en formato Stremio y ?check=1', async () => {
  const catalog = fakeCatalog();
  let sondeos = 0;
  const checker = createChecker({
    get: async () => {},
    channels: CHANNELS,
    resolvePage: async () => ({ url: 'https://edge.example/p.m3u8' }),
    probe: async url => { sondeos++; return url.includes('muerto') ? { ok: false, status: 404 } : { ok: true, status: 200 }; }
  });
  await withServer(catalog, async base => {
    // Sin informe previo la respuesta no espera al sondeo...
    const primero = await (await fetch(base + '/health.json')).json();
    assert.equal(primero.checked, 0);
    const previos = sondeos;

    // ...y `?check=1` verifica antes de responder.
    const fresco = await (await fetch(base + '/health.json?check=1')).json();
    assert.equal(fresco.checked, 3);
    assert.equal(fresco.dead, 1);
    assert.equal(fresco.alive, 2, 'La 1 y la página resuelta están vivas');
    assert.equal(fresco.unknown, 0);
    assert.equal(fresco.unchecked, 1);
    assert.ok(sondeos > previos);

    const muertos = await (await fetch(base + '/health/dead.json')).json();
    assert.equal(muertos.total, 1);
    assert.equal(muertos.metas[0].id, 'es-viva');
    assert.equal(muertos.metas[0].type, 'tv');

    // Los canales caídos siguen visibles en Stremio, pero marcados.
    const meta = await (await fetch(base + '/meta/tv/es-viva.json')).json();
    assert.equal(meta.meta.id, 'es-viva');
  }, { checker });
});

test('un verificador que revienta no rompe el servidor', async () => {
  const catalog = fakeCatalog();
  const checker = createChecker({
    get: async () => {},
    channels: CHANNELS,
    probe: async () => { throw new Error('sonda rota'); }
  });
  await withServer(catalog, async base => {
    const response = await fetch(base + '/playlist/es.m3u?check=1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-channel-count'), '2', 'ningún canal se marca caído');
    const health = await (await fetch(base + '/health.json')).json();
    assert.equal(health.dead, 0);
    assert.equal(health.unknown, 3);
  }, { checker });
});


test('Stremio: catálogo de caídos con motivo y ocultos en el catálogo normal', () => {
  const report = {
    checkedAt: '2026-01-01T00:00:00.000Z',
    results: {
      'es-la-1': { ok: true, dead: false, via: 'direct', attempts: [{ status: 200 }] },
      'es-viva': { ok: false, dead: true, via: 'direct', attempts: [{ status: 404, error: 'HTTP 404' }] }
    }
  };
  const channels = applyReport(CHANNELS, report);

  const todos = addon.catalog(channels, 'todos', '', 0);
  assert.ok(!todos.metas.some(meta => meta.id === 'es-viva'), 'los caídos no salen en el catálogo normal');

  const caidos = addon.catalog(channels, 'caidos', '', 0);
  assert.equal(caidos.metas.length, 1);
  assert.equal(caidos.metas[0].id, 'es-viva');
  assert.match(caidos.metas[0].description, /señal caída/);

  const manifest = addon.manifest();
  assert.ok(manifest.catalogs.some(entry => entry.id === 'caidos'));
});


test('clasificación: 404/410 y DNS son caída; 403/429 no; timeout tampoco', async () => {
  const caso = status => ({
    id: 'x',
    streams: [{ url: 'https://a.example/x.m3u8', source: 'eja.tv' }]
  });
  const probar = async resultado => {
    const report = await createChecker({
      get: async () => {},
      channels: [caso()],
      probe: async () => resultado
    }).run();
    return report.results.x;
  };

  const muerto = await probar({ ok: false, status: 404, error: 'HTTP 404' });
  assert.deepEqual([muerto.dead, muerto.ok], [true, false]);
  assert.equal(muerto.reason, 'caído');

  const borrado = await probar({ ok: false, status: 410, error: 'HTTP 410' });
  assert.equal(borrado.dead, true, '410 Gone también es caída');

  const dns = await probar({ ok: false, status: 'red', error: 'fetch failed' });
  assert.equal(dns.dead, true, 'un dominio que no resuelve está caído');

  for (const status of [403, 429, 401, 503]) {
    const bloqueado = await probar({ ok: false, status, error: `HTTP ${status}` });
    assert.equal(bloqueado.dead, false, `${status} no debe eliminar el canal`);
    assert.equal(bloqueado.blocked, true);
  }

  const lento = await probar({ ok: false, status: 'timeout', error: 'timeout' });
  assert.equal(lento.dead, false, 'un timeout no confirma la caída');
  assert.equal(lento.unconfirmed, true);

  const mixto = await createChecker({
    get: async () => {},
    channels: [{
      id: 'y',
      streams: [
        { url: 'https://a.example/1.m3u8', source: 'eja.tv' },
        { url: 'https://b.example/1.m3u8', source: 'tvgarden.world' }
      ]
    }],
    probe: async url => (url.includes('a.example')
      ? { ok: false, status: 404, error: 'HTTP 404' }
      : { ok: false, status: 429, error: 'HTTP 429' })
  }).run();
  assert.equal(mixto.results.y.dead, false, 'con un intento bloqueado no hay certeza');
});

test('el informe incluye recuento de bloqueados y no confirmados', async () => {
  const muyLento = async () => ({ ok: false, status: 'timeout', error: 'timeout' });
  const checker = createChecker({
    get: async () => {},
    channels: CHANNELS,
    resolvePage: async () => ({ url: 'https://edge.example/p.m3u8' }),
    probe: muyLento
  });
  const report = await checker.run();
  const resumen = summarize(CHANNELS, report);
  assert.equal(resumen.dead, 0, 'nada se elimina sin certeza');
  assert.equal(resumen.blocked, 0);
  assert.equal(resumen.unconfirmed, resumen.checked);
  assert.equal(resumen.ratio, 0);
});
