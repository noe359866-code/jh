const test = require('node:test');
const assert = require('node:assert/strict');
const snap = require('./helpers/snapshots');

const eja = require('../engines/live/sources/eja');
const iptvcat = require('../engines/live/sources/iptvcat');
const tvgarden = require('../engines/live/sources/tvgarden');
const globalfreetv = require('../engines/live/sources/globalfreetv');
const tvenvivo = require('../engines/live/sources/tvenvivo');
const thedaddy = require('../engines/live/sources/thedaddy');
const livelive24 = require('../engines/live/sources/livelive24');

const text = body => () => Promise.resolve({ status: 200, text: body, url: '' });

test('eja: lee tarjetas, quita el fragmento del snapshot y filtra idioma', async () => {
  const cards = eja.parseCards(snap.ejaPage);
  assert.equal(cards.length, 3);
  assert.equal(eja.parseCards('<div class="card h-100"><h5 class="card-title"><span class="text-muted">Sin fuente</span></h5></div>').length, 0);
  assert.equal(cards[0].name, 'La 1 Canarias');
  assert.equal(cards[0].url, 'https://rtvelivestream.rtve.es/rtvesec/can/la1_can_main.m3u8');
  assert.equal(cards[0].logo, 'https://eja.tv/snaps/70cb.png');
  assert.equal(cards[0].language, 'spa');
  assert.equal(cards[1].language, 'cat');

  const first = () => ({ status: 200, text: snap.ejaPage });
  const empty = () => ({ status: 200, text: '<html><body>sin tarjetas</body></html>' });
  let pages = 0;
  const entries = await eja.collect({ get: async () => (pages++ === 0 ? first() : empty()), maxPages: 3, onSource: () => {} });
  // Solo las tarjetas en español entran; el nombre pierde la marca de calidad.
  assert.deepEqual(entries.map(entry => entry.name), ['La 1 Canarias', 'Real Madrid TV']);
  assert.ok(entries.every(entry => entry.country === 'LATAM' || entry.country === 'ES'));
});

test('eja: las URLs de listado incluyen país, idioma y offset', () => {
  assert.equal(eja.listUrl('es', 0), 'https://eja.tv/?country=es&language=&category=&search=');
  assert.equal(eja.listUrl('mx', 6), 'https://eja.tv/?country=mx&language=&category=&search=&offset=6');
  assert.match(eja.listUrl('us', 0), /language=spa/);
});

test('iptvcat: lee nombre real, minilista firmada y omite filas sin lista', async () => {
  const rows = iptvcat.parseRows(snap.iptvcatPage);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, '101tv Antequera');
  assert.equal(rows[0].geoBlocked, true);
  assert.equal(rows[0].streams[0].url, 'https://list.iptvcat.net/my_list/s/aaa.m3u8');
  assert.equal(rows[1].name, 'La 1');
  assert.deepEqual(iptvcat.countrySlugs(snap.iptvcatPage).sort(), ['mexico__6', 'spain__1']);
});

test('tvgarden: lee JSON comprimido ya descomprimido y descarta canales sin medio', async () => {
  const parsed = tvgarden.parseCountry(snap.tvgardenJson);
  assert.deepEqual(parsed.map(channel => channel.name), ['28 kanala', 'La 1']);
  assert.equal(parsed[1].streams.length, 2);
  const seen = [];
  const entries = await tvgarden.collect({ get: async () => ({ status: 200, text: snap.tvgardenJson }), onSource: detail => seen.push(detail) });
  assert.equal(seen.length, tvgarden.COUNTRIES.length);
  assert.equal(entries[0].streams[0].url, 'https://streaming.28kanala.eus/hls/z.m3u8');
  assert.equal(entries[1].streams[0].url, 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8');
});

test('globalfreetv: extrae streams y referrer del payload SSR', async () => {
  const channel = globalfreetv.parseChannel(snap.globalFreeChannel);
  assert.equal(channel.name, 'La 1');
  assert.equal(channel.country, 'ES');
  assert.equal(channel.streams.length, 2);
  assert.equal(channel.streams[0].url, 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8');
  assert.equal(channel.streams[1].referer, 'https://www.rtve.es/');
  assert.deepEqual(globalfreetv.channelIds(snap.globalFreeListing), ['La1.es', '24Horas.es', 'RealMadridTV.es']);
});

test('tvenvivo: portada, core firmado y `var src` con barras escapadas', async () => {
  const channels = tvenvivo.parseHome(snap.tvenvivoHome);
  assert.deepEqual(channels.map(channel => channel.name), ['TUDN', 'Liga 1']);
  assert.equal(channels[0].slug, 'tudn');
  assert.equal(tvenvivo.canalFromPage(snap.tvenvivoCore), 'tudn');
  assert.equal(tvenvivo.iframeFromCore(snap.tvenvivoCore), 'https://deportes.example.com/stream.php?canal=tudn&target=1&sig=abc');
  assert.equal(tvenvivo.streamFromEmbed(snap.tvenvivoEmbed), 'https://deportes.example.com/playlist/1/index.m3u8?token=abc-def');

  const chain = async url => {
    if (url.endsWith('-en-vivo-online.php')) return { status: 200, text: snap.tvenvivoHome, url };
    if (url.includes('core.php')) return { status: 200, text: snap.tvenvivoCore, url };
    return { status: 200, text: snap.tvenvivoEmbed, url };
  };
  const resolved = await tvenvivo.resolve('https://www.tvenvivo.org/tudn-en-vivo-online.php', { get: chain });
  assert.equal(resolved.url, 'https://deportes.example.com/playlist/1/index.m3u8?token=abc-def');
  assert.equal(resolved.referer, 'https://deportes.example.com/');
});

test('thedaddy: filtra señales españolas y resuelve watch → player → embed', async () => {
  const listed = thedaddy.parseList(snap.daddyList);
  assert.deepEqual(listed.map(item => item.id), [51, 700, 701]);
  assert.equal(thedaddy.isSpanishSignal('ABC USA'), false);
  assert.equal(thedaddy.isSpanishSignal('LaLiga TV'), true);
  assert.equal(thedaddy.isSpanishSignal('DAZN F1'), true);
  assert.equal(thedaddy.srcFromEmbed(snap.daddyEmbed), 'https://edge.example.top/premium700/index.m3u8');

  const chain = async url => ({ status: 200, url, text: url.includes('watch.php') ? snap.daddyWatch : url.includes('stream-') ? snap.daddyPlayer : snap.daddyEmbed });
  const resolved = await thedaddy.resolve('https://thedaddy.li/watch.php?id=700', { get: chain });
  assert.equal(resolved.url, 'https://edge.example.top/premium700/index.m3u8');
  assert.equal(resolved.referer, 'https://dembed.st/');
});

test('livelive24: solo canales hispanohablantes y sin URL de medio', async () => {
  const parsed = livelive24.parseTvJson(snap.live24Json);
  assert.deepEqual(parsed.map(channel => channel.name), ['DAZN F1 ES', 'Azteca 7']);
  assert.equal(parsed[0].region, 'ES');
  assert.equal(parsed[1].region, 'LATAM');
  const entries = await livelive24.collect({ get: text(snap.live24Json) });
  assert.ok(entries.every(entry => entry.streams.length === 0));
  assert.ok(entries.every(entry => entry.externalUrl));
});
