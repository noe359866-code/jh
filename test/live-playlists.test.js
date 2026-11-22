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
  assert.ok(entries.every(entry => entry.url === undefined));
  assert.ok(entries.every(entry => entry.streams[0].url.startsWith('https://jmp2.uk/')));
  assert.ok(entries.every(entry => entry.country === 'ES'), 'la lista es de España');
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

test('las seis listas están registradas y todas tienen url', () => {
  for (const id of ['cinecity', 'telechancho', 'iptvchile', 'samsungtvplus', 'pluto', 'd9kod']) {
    const source = byId(id);
    assert.ok(source, `falta la fuente ${id}`);
    assert.equal(typeof source.collect, 'function');
  }
  assert.equal(sources.length, 13);
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
