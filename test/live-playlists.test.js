// Fuentes de lista M3U externa: parser, clasificación por país e integración.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsePlaylist, countryFromText } = require('../engines/live/sources/playlist');
const { sources, byId } = require('../engines/live/sources');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('detecta el país por bandera, sufijo, nombre y región', () => {
  assert.equal(countryFromText('🇲🇽 Novelas México'), 'MX');
  assert.equal(countryFromText('Mega [CL]'), 'CL');
  assert.equal(countryFromText('La 1 (ES)'), 'ES');
  assert.equal(countryFromText('🌍 Mexico'), 'MX');
  assert.equal(countryFromText('🏙️ Buenos Aires'), 'AR');
  assert.equal(countryFromText('🇨🇴 Bogotá'), 'CO');
  assert.equal(countryFromText('🎬 Cine'), null);
  // Grupos compuestos y códigos delante, como los publican las listas Xtream.
  assert.equal(countryFromText('ESPAÑA | GENERALISTAS'), 'ES');
  assert.equal(countryFromText('MEXICO | GENERALISTAS'), 'MX');
  assert.equal(countryFromText('Mexico - Deportes'), 'MX');
  assert.equal(countryFromText('Chile · Noticias'), 'CL');
  assert.equal(countryFromText('ES - La 1'), 'ES');
  assert.equal(countryFromText('MX: Canal 5'), 'MX');
});

test('parsePlaylist: descarta idiomas no hispanos y URLs no http', () => {
  const entries = parsePlaylist([
    '#EXTM3U',
    '#EXTINF:-1 tvg-language="por" group-title="Brasil",TV Brasil',
    'https://cdn.example/br.m3u8',
    '#EXTINF:-1 tvg-language="eng",US News',
    'https://cdn.example/us.m3u8',
    '#EXTINF:-1 group-title="🌍 Mexico",Azteca 🇲🇽',
    'https://cdn.example/mx.m3u8',
    '#EXTINF:-1,Sin url',
    '',
    '#EXTINF:-1 rtmp://x/y,Fuera de http',
    'rtmp://x/y'
  ].join('\n'), { source: 'prueba' });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Azteca');
  assert.equal(entries[0].origin, 'MX');
  assert.equal(entries[0].country, 'LATAM');
  assert.equal(entries[0].streams[0].kind, 'hls');
});

test('lista chilena real: 23 canales LATAM, 22 HLS y 1 sin extensión', () => {
  const entries = parsePlaylist(fixture('iptvchile.m3u'), { source: 'iptv-chile' });
  assert.equal(entries.length, 23);
  assert.equal(entries.filter(entry => entry.streams[0].kind === 'hls').length, 22);
  // Canal 13 publica una URL sin `.m3u8`; se guarda como página, no se descarta.
  assert.deepEqual(entries.filter(entry => entry.streams[0].kind === 'page').map(entry => entry.name), ['Canal 13']);
  assert.ok(entries.every(entry => entry.country === 'LATAM'));
  assert.ok(entries.some(entry => entry.name === 'Mega'));
  // El tvg-id numérico no debe colarse como país.
  assert.ok(entries.every(entry => entry.origin !== '455'));
});

test('lista Samsung ES real: canales españoles aunque la URL sea un redirector', () => {
  const entries = parsePlaylist(fixture('samsungtvplus_es.m3u'), { source: 'Samsung TV Plus ES', defaultCountry: 'ES' });
  assert.ok(entries.length > 100);
  assert.ok(entries.every(entry => entry.streams[0].url.startsWith('https://jmp2.uk/')));
  assert.ok(entries.every(entry => entry.country === 'ES'), 'la lista es de España');
  // `jmp2.uk/stvp-…` no acaba en `.m3u8` pero redirige a un HLS: no es una página.
  assert.ok(entries.every(entry => entry.streams[0].kind === 'hls'));
});

test('los redirectores conocidos se marcan como HLS, no como página', () => {
  const entries = parsePlaylist([
    '#EXTM3U',
    '#EXTINF:-1 tvg-country="ES",La 1',
    'https://jmp2.uk/stvp-abc123',
    '#EXTINF:-1,Documental',
    'https://ejemplo.example/ver/canal',
    '#EXTINF:-1,Acortado',
    'https://s.id/xyz'
  ].join('\n'), { source: 'prueba' });
  const kindOf = name => entries.find(entry => entry.name === name).streams[0].kind;
  assert.equal(kindOf('La 1'), 'hls');
  assert.equal(kindOf('Acortado'), 'hls');
  // Una URL normal sin extensión de medio sigue siendo página.
  assert.equal(kindOf('Documental'), 'page');
});

test('lista Pluto real: descarta el catálogo no hispano', () => {
  const entries = parsePlaylist(fixture('pluto.m3u'), { source: 'Pluto TV' });
  assert.ok(entries.length > 0);
  // Brasil y EE. UU. no deben aparecer como países hispanos.
  assert.ok(!entries.some(entry => entry.origin === 'BR'));
  assert.ok(!entries.some(entry => entry.origin === 'US'));
});

test('lista CineCity real: tolera líneas EXTINF sin `#`', () => {
  const full = fs.readFileSync(path.join(__dirname, 'fixtures', 'cinecity.m3u'), 'utf8');
  const entries = parsePlaylist(full, { source: 'cinecity' });
  assert.ok(entries.length > 100);
  assert.ok(entries.every(entry => /^https?:/.test(entry.streams[0].url)));
  // La lista agrupa por país en `group-title` (🌍 Mexico, 🏙️ Buenos Aires…).
  assert.ok(entries.some(entry => entry.origin === 'AR'));
  // Y no debe quedarse ninguna entrada con la línea rota (`EXTINF:` sin `#`).
  assert.ok(entries.every(entry => !entry.name.startsWith('EXTINF')));
  assert.ok(entries.every(entry => !entry.name.includes('tvg-logo')));
});

test('las listas externas están registradas', () => {
  for (const id of ['cinecity', 'telechancho', 'iptvchile', 'samsungtvplus', 'pluto', 'd9kod', 'usa', 'iptvorg', 'tdtchannels', 'freetv']) {
    const source = byId(id);
    assert.ok(source, `falta la fuente ${id}`);
    assert.equal(typeof source.collect, 'function');
  }
  // Siete sitios, seis listas, USA, iptv-org por país, TDT y Free-TV.
  assert.equal(sources.length, 17);
});

test('group-title se convierte en categoría y no en país', () => {
  const { categoryFromGroup } = require('../engines/live/sources/playlist');
  assert.equal(categoryFromGroup('⚽ Deportes'), 'Deportes');
  assert.equal(categoryFromGroup('🎬 Cine'), 'Cine y series');
  assert.equal(categoryFromGroup('Novelas 🌎'), 'Cine y series');
  assert.equal(categoryFromGroup('News'), 'Noticias');
  assert.equal(categoryFromGroup('News (AR)'), 'Noticias');
  assert.equal(categoryFromGroup('Informativos'), 'Noticias');
  assert.equal(categoryFromGroup('Generalistas'), 'Generalista');
  // Un país no es una categoría.
  assert.equal(categoryFromGroup('Italy'), null);
  assert.equal(categoryFromGroup('🏙️ Buenos Aires'), null);
});

test('un nombre que solo es código se descarta', () => {
  const entries = parsePlaylist([
    '#EXTM3U',
    '#EXTINF:-1 tvg-country="MX",<script>alert(1)</script>',
    'https://x/1.m3u8',
    '#EXTINF:-1 tvg-country="MX",Canal 5',
    'https://x/2.m3u8'
  ].join('\n'), { source: 's' });
  assert.deepEqual(entries.map(entry => entry.name), ['Canal 5']);
});

test('los símbolos de plataforma se quitan del nombre', () => {
  // Free-TV marca YouTube con `Ⓨ` y Google con `Ⓖ`; salían en Stremio y el M3U.
  const entries = parsePlaylist([
    '#EXTM3U',
    '#EXTINF:-1 tvg-country="AR",TN Todo Noticias Ⓨ',
    'https://x/1.m3u8',
    '#EXTINF:-1 tvg-country="AR",Encuentro Ⓨ Ⓖ',
    'https://x/2.m3u8',
    '#EXTINF:-1 tvg-country="ES",La 1 🇪🇸',
    'https://x/3.m3u8'
  ].join('\n'), { source: 's' });
  assert.deepEqual(entries.map(entry => entry.name), ['TN Todo Noticias', 'Encuentro', 'La 1']);
});

test('lista mundial: solo entra lo que es español', () => {
  const mundial = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-country="IT" group-title="Italy",Rai 1',
    'https://it.example/1.m3u8',
    '#EXTINF:-1 tvg-country="ES" group-title="Generalistas",La 1',
    'https://es.example/1.m3u8',
    '#EXTINF:-1 tvg-language="spa",Canal Hispano',
    'https://x.example/h.m3u8',
    '#EXTINF:-1,アルバニア TV',
    'https://x.example/al.m3u8'
  ].join('\n');
  const entries = parsePlaylist(mundial, { source: 'mundial', spanishOnly: true });
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['Canal Hispano', 'La 1']);
  // Sin el filtro, la misma lista mete canales de cualquier país.
  assert.equal(parsePlaylist(mundial, { source: 'mundial' }).length, 4);
});

test('TDTChannels: cadena pública española con su categoría y su EPG', () => {
  const entries = parsePlaylist(fixture('tdtchannels.m3u'), { source: 'TDTChannels', defaultCountry: 'ES' });
  const names = entries.map(entry => entry.name);
  assert.ok(names.includes('La 1'));
  assert.ok(entries.every(entry => entry.origin === 'ES'), 'es una lista nacional');
  const la1 = entries.filter(entry => entry.name === 'La 1');
  assert.equal(la1.length, 2, 'La 1 trae dos señales');
  assert.ok(la1.every(entry => entry.epgId === 'La1.TV'), 'conserva el id de la EPG');
  const byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));
  assert.equal(byName['24h'].category, 'Noticias');
  assert.equal(byName.Teledeporte.category, 'Deportes');
  assert.equal(byName['ETB Deportes'].streams[0].httpReferrer, 'https://kirolakeitb.eus/es/kirolak-360/en-directo/');
});

test('Free-TV: lista mundial reducida a los canales en español', () => {
  const entries = parsePlaylist(fixture('freetv.m3u'), { source: 'Free-TV', spanishOnly: true });
  const names = entries.map(entry => entry.name).sort();
  assert.deepEqual(names, ['CNN en Español', 'La 1', 'Telefe']);
  assert.ok(!names.includes('Rai 1'), 'el canal italiano se descarta');
  assert.ok(!names.includes('Kanali 7'), 'el albanés se descarta');
  // `tvg-country` en mayúsculas debe reconocerse.
  assert.equal(entries.find(entry => entry.name === 'Telefe').origin, 'AR');
  assert.equal(entries.find(entry => entry.name === 'CNN en Español').category, 'Noticias');
});

test('collect deduplica por URL de medio y tolera listas caídas', async () => {
  const { createPlaylistSource } = require('../engines/live/sources/playlist');
  const source = createPlaylistSource({
    id: 'x', name: 'x', urls: ['https://ok.example/a.m3u', 'https://caida.example/b.m3u']
  });
  const get = async url => {
    if (url.includes('caida')) throw new Error('HTTP 500');
    return {
      status: 200,
      text: [
        '#EXTM3U',
        '#EXTINF:-1,La 1 (ES)', 'https://cdn.example/1.m3u8',
        '#EXTINF:-1,La 1 HD (ES)', 'https://cdn.example/1.m3u8'
      ].join('\n')
    };
  };
  const entries = await source.collect({ get });
  assert.equal(entries.length, 1, 'misma URL → una sola entrada');
  assert.equal(entries[0].origin, 'ES');
});

test('las 24 listas de PLAYLISTS generan M3U', async () => {
  const { PLAYLISTS } = require('../index');
  const { buildM3u } = require('../engines/live/m3u');
  const channels = [
    { id: 'es-1', name: 'A', country: 'ES', origin: 'ES', category: 'Generalista', sources: ['x'], streams: [{ url: 'https://x/1.m3u8', kind: 'hls' }] },
    { id: 'ar-1', name: 'B', country: 'LATAM', origin: 'AR', category: 'Deportes', sources: ['x'], streams: [{ url: 'https://x/2.m3u8', kind: 'hls' }] }
  ];
  for (const [id, definition] of Object.entries(PLAYLISTS)) {
    // `filter` tiene que ser la función: pasarla mal dejaba las 24 listas vacías.
    assert.equal(typeof definition.filter, 'function', `${id} sin filtro`);
    const { count } = await buildM3u(channels.filter(definition.filter), {});
    assert.ok(count >= 0, `${id} no generó lista`);
  }
  assert.equal(await buildM3u(channels.filter(PLAYLISTS.es.filter), {}).then(r => r.count), 1);
  assert.equal(await buildM3u(channels.filter(PLAYLISTS.deportes.filter), {}).then(r => r.count), 1);
});
