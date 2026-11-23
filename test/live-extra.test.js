// Listas privadas (`config/extra-playlists.json` / `EXTRA_PLAYLISTS`).
const test = require('node:test');
const assert = require('node:assert/strict');
const extra = require('../engines/live/sources/extra');
const { parsePlaylist } = require('../engines/live/sources/playlist');

const XTREAM = 'http://nexon.example/get.php?username=ana&password=s3creta&type=m3u_plus&output=mpegts';

test('parseExtraConfig: acepta array de URLs y de objetos', () => {
  const list = extra.parseExtraConfig(JSON.stringify([
    XTREAM,
    { id: 'cine', name: 'Cine privado', url: 'https://lista.example/cine.m3u8', country: 'mx' }
  ]));
  assert.equal(list.length, 2);
  // La URL suelta se etiqueta con su host, sin credenciales.
  assert.equal(list[0].name, 'nexon.example');
  assert.equal(list[0].label, 'nexon.example');
  assert.equal(list[0].id, 'extra-nexon-example');
  assert.equal(list[0].assumeHls, true);       // Xtream: medios sin extensión
  assert.equal(list[0].maxEntries, 8000);
  assert.equal(list[1].id, 'extra-cine');
  assert.equal(list[1].country, 'MX');
  assert.equal(list[1].spanishOnly, false);
});

test('parseExtraConfig: tolera JSON roto, objetos sin URL y duplicados', () => {
  assert.deepEqual(extra.parseExtraConfig('{no es json'), []);
  assert.deepEqual(extra.parseExtraConfig(JSON.stringify([{ name: 'sin url' }, { url: 'ftp://x/y' }])), []);
  assert.equal(extra.parseExtraConfig(JSON.stringify([XTREAM, XTREAM])).length, 1);
  assert.equal(extra.parseExtraConfig(JSON.stringify({ playlists: [XTREAM] })).length, 1);
});

test('parseExtraEnv: separa por comas, admite Nombre=url y no parte la query', () => {
  const list = extra.parseExtraEnv(`${XTREAM}, Cine=https://lista.example/cine.m3u8`);
  assert.equal(list.length, 2);
  assert.equal(list[0].url, XTREAM);
  assert.equal(list[1].name, 'Cine');
  assert.equal(list[1].url, 'https://lista.example/cine.m3u8');
  assert.equal(extra.parseExtraEnv('').length, 0);
});

test('las credenciales no aparecen en ninguna etiqueta publicable', () => {
  const definition = extra.parseExtraConfig(JSON.stringify([XTREAM]))[0];
  assert.equal(definition.label, 'nexon.example');
  assert.ok(!JSON.stringify({ ...definition, url: undefined }).includes('s3creta'));
  const redacted = extra.redactUrl(XTREAM);
  assert.match(redacted, /username=\*\*\*/);
  assert.match(redacted, /password=\*\*\*/);
  assert.ok(!redacted.includes('s3creta'));
  assert.equal(extra.labelFor('https://usuario:clave@cdn.example/x.m3u8'), 'cdn.example');
});

test('loadDefinitions: file + entorno, sin lanzar si el archivo falla', () => {
  const loaded = extra.loadDefinitions({
    env: { EXTRA_PLAYLISTS: 'https://otra.example/a.m3u8' },
    file: '/no/existe.json',
    readFile: () => JSON.stringify([{ name: 'Privada', url: XTREAM }])
  });
  assert.equal(loaded.definitions.length, 2);
  assert.equal(loaded.error, null);
  // Un `readFile` que revienta deja el catálogo público intacto y lo informa.
  const roto = extra.loadDefinitions({ env: {}, readFile: () => { throw new Error('EACCES'); } });
  assert.equal(roto.definitions.length, 0);
  assert.match(roto.error, /EACCES/);
});

test('Xtream: los medios sin extensión se publican como directos (mpegts)', () => {
  const text = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="La1.es" tvg-name="La 1 HD" tvg-logo="http://logo.example/la1.png" group-title="ESPAÑA | GENERALISTAS",La 1 HD',
    'http://nexon.example/live/ana/s3creta/1234.ts',
    '#EXTINF:-1 tvg-name="Azteca 7" group-title="MEXICO | GENERALISTAS",Azteca 7',
    'http://nexon.example/ana/s3creta/5678',
    '#EXTINF:-1 tvg-name="Canal Sur" group-title="ESPAÑA | ANDALUCIA",Canal Sur',
    'http://nexon.example/live/ana/s3creta/9999.m3u8'
  ].join('\n');
  const entries = parsePlaylist(text, { source: 'Mi IPTV', assumeHls: true });
  assert.deepEqual(entries.map(entry => entry.name), ['La 1 HD', 'Azteca 7', 'Canal Sur']);
  assert.ok(entries.every(entry => entry.streams[0].kind === 'hls'));
  assert.equal(entries[0].origin, 'ES');
  assert.equal(entries[1].origin, 'MX');
  assert.equal(entries[0].epgId, 'La1.es');
  assert.equal(entries[0].streams[0].source, 'Mi IPTV');
  // Sin `assumeHls` la URL sin extensión sería una página a resolver.
  assert.equal(parsePlaylist(text, { source: 'Mi IPTV' })[1].streams[0].kind, 'page');
});

test('una lista privada se recolecta como cualquier otra fuente', async () => {
  const definition = extra.parseExtraConfig(JSON.stringify([XTREAM]))[0];
  const source = extra.createSource(definition);
  assert.equal(source.id, 'extra-nexon-example');
  const entries = await source.collect({
    get: async () => ({
      status: 200,
      text: '#EXTM3U\n#EXTINF:-1 group-title="ESPAÑA",La 1 HD\nhttp://nexon.example/live/ana/s3creta/1.ts\n'
    }),
    onSource: detail => {
      // El informe de `/config` usa el host, no la URL con contraseña.
      assert.deepEqual(Object.keys(detail.playlists), ['nexon.example']);
    }
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].streams[0].kind, 'hls');
});

test('lista combinada: varias listas privadas en un solo M3U', async () => {
  const { playlistDefinitions, PLAYLISTS } = require('../index');
  const { buildM3u } = require('../engines/live/m3u');
  const fakeExtra = {
    merge: { id: 'nexon', name: 'Nexon' },
    mergeSourceIds: ['extra-nexon', 'extra-otra']
  };
  const definitions = playlistDefinitions({ extraConfig: fakeExtra });
  assert.equal(definitions.nexon.label, 'Nexon');
  assert.equal(definitions.nexon.private, true);
  // `all` sigue siendo el catálogo completo, no solo las privadas.
  assert.deepEqual(PLAYLISTS.all.filter({}), true);
  assert.ok(!PLAYLISTS.nexon, 'la combinada no debe colarse en las listas públicas');

  const channels = [
    // Dos canales de dos listas privadas distintas, y uno público.
    { id: 'es-1', name: 'La 1', origin: 'ES', country: 'ES', category: 'Generalista', sources: ['extra-nexon'], streams: [{ url: 'https://a/1.m3u8', kind: 'hls', source: 'Nexon IPTV' }] },
    { id: 'mx-1', name: 'Azteca 7', origin: 'MX', country: 'LATAM', category: 'Generalista', sources: ['extra-otra'], streams: [{ url: 'https://a/2.m3u8', kind: 'hls', source: 'Otra lista' }] },
    { id: 'ar-1', name: 'Público', origin: 'AR', country: 'LATAM', category: 'Generalista', sources: ['cinecity'], streams: [{ url: 'https://a/3.m3u8', kind: 'hls', source: 'cinecity' }] }
  ];
  const merged = await buildM3u(channels.filter(definitions.nexon.filter), {});
  assert.equal(merged.count, 2, 'las dos listas privadas, en un archivo');
  assert.match(merged.body, /La 1/);
  assert.match(merged.body, /Azteca 7/);
  assert.ok(!merged.body.includes('Público'));

  // Un canal aportado por varias fuentes entra una vez sola en la combinada.
  const both = { ...channels[0], sources: ['extra-nexon', 'cinecity'] };
  assert.equal((await buildM3u([both].filter(definitions.nexon.filter), {})).count, 1);

  // Sin listas privadas no hay lista combinada.
  assert.equal(playlistDefinitions({ extraConfig: { mergeSourceIds: [] } }).nexon, undefined);
  // Un nombre que choca con una lista pública no la pisa.
  const choque = playlistDefinitions({ extraConfig: { merge: { id: 'es', name: 'España' }, mergeSourceIds: ['extra-nexon'] } });
  assert.equal(choque.es, PLAYLISTS.es);
  assert.equal(choque['mi-iptv'].private, true);
});

test('servidor: la combinada sale por HTTP y el público solo con ?publico=1', async () => {
  const { createApp } = require('../index');
  const { once } = require('node:events');
  const channels = [
    { id: 'es-1', name: 'La 1', origin: 'ES', country: 'ES', category: 'Generalista', sources: ['extra-nexon'], playable: true, dead: false, streams: [{ url: 'https://a/1.m3u8', kind: 'hls', source: 'Nexon IPTV' }] },
    { id: 'ar-1', name: 'Público', origin: 'AR', country: 'LATAM', category: 'Generalista', sources: ['cinecity'], playable: true, dead: false, streams: [{ url: 'https://a/3.m3u8', kind: 'hls', source: 'cinecity' }] }
  ];
  const loaded = { channels, loadedAt: Date.now(), counts: {}, status: {}, health: null };
  const catalog = {
    load: async () => loaded,
    peek: () => loaded,
    setHealth: () => {},
    health: () => null,
    reset: () => {}
  };
  const extraConfig = {
    sources: [{ id: 'extra-nexon', name: 'Nexon IPTV' }],
    merge: { id: 'nexon', name: 'Nexon' },
    mergeSourceIds: ['extra-nexon'],
    definitions: [{ id: 'extra-nexon', name: 'Nexon IPTV', label: 'nexon.example', country: null }]
  };
  const app = createApp({ catalog, checker: null, autoVerify: false, extraConfig });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // La combinada solo trae la lista privada.
    const combinada = await fetch(base + '/playlist/nexon.m3u');
    assert.equal(combinada.status, 200);
    assert.equal(combinada.headers.get('x-channel-count'), '1');
    assert.match(await combinada.text(), /La 1/);

    // `/playlist.m3u` redirige a la combinada, no a `all`.
    const raiz = await fetch(base + '/playlist.m3u', { redirect: 'manual' });
    assert.equal(raiz.headers.get('location'), '/playlist/nexon.m3u');

    // La lista de una sola fuente privada también existe.
    const suelta = await fetch(base + '/playlist/nexon-iptv.m3u');
    assert.equal(suelta.status, 200);

    const indice = await (await fetch(base + '/playlists.json')).json();
    assert.equal(indice.publicLists, false);
    assert.equal(indice.playlists.find(entry => entry.id === 'nexon').private, true);

    // `/config` informa de las listas sin enseñar la URL con credenciales.
    const config = await (await fetch(base + '/config')).json();
    assert.equal(config.extraPlaylists.configured, 1);
    assert.equal(config.extraPlaylists.lists[0].label, 'nexon.example');
    assert.ok(!JSON.stringify(config).includes('s3creta'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
