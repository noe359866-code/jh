// Países, regiones y fuente de Estados Unidos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const countries = require('../engines/live/countries');
const usa = require('../engines/live/sources/usa');
const { groupFor } = require('../engines/live/text');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('países: códigos, nombres y regiones coherentes', () => {
  assert.equal(countries.COUNTRIES.length, 21);
  assert.equal(countries.countryOf('MX'), 'MX');
  assert.equal(countries.countryOf('México'), 'MX', 'acepta el nombre con tilde');
  assert.equal(countries.countryOf('estados unidos'), 'US');
  assert.equal(countries.countryOf('LATAM'), null, 'una región no es un país');
  assert.equal(countries.countryOf(''), null);

  assert.equal(countries.regionOf('ES'), 'ES');
  assert.equal(countries.regionOf('US'), 'US');
  assert.equal(countries.regionOf('MX'), 'LATAM');

  assert.equal(countries.countryName('MX'), 'México');
  assert.equal(countries.countryName('US'), 'Estados Unidos');
  assert.equal(countries.countryName('LATAM'), null);
  assert.ok(countries.isCountry('AR'));
  assert.ok(!countries.isCountry('LATAM'));
  // Todos los códigos son únicos.
  const codes = countries.COUNTRIES.map(country => country.code);
  assert.equal(new Set(codes).size, codes.length);
});

test('groupFor: el grupo M3U usa el país real, no la región', () => {
  assert.equal(groupFor('MX'), 'México');
  assert.equal(groupFor('US'), 'Estados Unidos');
  assert.equal(groupFor('LATAM'), 'Latinoamérica');
  assert.equal(groupFor('MX', 'Deportes'), 'México · Deportes');
  assert.equal(groupFor(null), 'Internacional');
});

test('iptv-org: solo los canales con emisión principal en español', () => {
  // `ABC.us` emite casi todo en inglés y solo alguna repetidora local en
  // español: no debe entrar como canal en español.
  const feeds = [
    'channel,id,name,alt_names,is_main,broadcast_area,timezones,languages,format',
    'Univision.us,E,East,,TRUE,c/US,America/New_York,spa,1080i',
    'ABC.us,E,East,,TRUE,c/US,America/New_York,eng,720p',
    'ABC.us,KH,Local,,FALSE,ct/USA,America/New_York,spa,720p',
    'Telemundo.us,E,East,,TRUE,c/US,America/New_York,spa,1080i',
    'Telemundo.us,W,West,,FALSE,c/US,America/Los_Angeles,eng,720p'
  ].join('\n');
  const { spanish, secondary } = usa.spanishFeeds(feeds);
  assert.ok(spanish.has('Univision.us'), 'con `spa` de verdad entra');
  assert.ok(!spanish.has('ABC.us'), 'ABC emite en inglés');
  // iptv-org marca el feed principal de Univision/Telemundo como inglés por
  // error; la fuente tiene una lista de canales que siempre son en español.
  assert.ok(usa.ALWAYS_SPANISH.has('Univision.us'));
  assert.ok(usa.ALWAYS_SPANISH.has('Telemundo.us'));
  assert.ok(secondary.has('ABC.us'), 'pero tiene alguna emisión local en español');
});

test('fuente USA: separa español de inglés y descarta el resto', async () => {
  const streams = fixture('iptvorg_us.m3u');
  const feeds = fixture('iptvorg_feeds.csv');
  const get = async url => ({ text: url.includes('feeds') ? feeds : streams });
  let stats = null;
  const entries = await usa.collect({ get, onSource: value => { stats = value; } });

  assert.ok(entries.length > 0);
  assert.ok(entries.every(entry => entry.origin === 'US'));
  assert.ok(entries.every(entry => entry.country === 'US'), 'región Estados Unidos');
  assert.ok(entries.every(entry => entry.language === 'es' || entry.language === 'en'));

  const names = entries.map(entry => entry.name);
  assert.ok(names.includes('Univision'), 'entra el canal en español');
  // Galavisión y ESPN Deportes tienen feed principal `spa` en el fixture.
  assert.ok(names.some(name => /Galavision/i.test(name)));
  assert.ok(names.some(name => /ESPN Deportes/i.test(name)));
  // Univision figura como inglés en la base: la lista de siempre-español lo salva.
  assert.equal(entries.find(entry => entry.name === 'Univision').language, 'es');
  assert.ok(names.includes('CNN'), 'entra una cadena mayoritaria en inglés');
  assert.ok(!names.includes('Local Access'), 'un canal local en inglés se descarta');
  assert.equal(stats.usDiscarded > 0, true);
  // Sin URLs repetidas.
  const urls = entries.map(entry => entry.streams[0].url);
  assert.equal(new Set(urls).size, urls.length);
});

test('fuente USA: sin conexión no inventa canales', async () => {
  const get = async () => { throw new Error('fetch failed'); };
  await assert.rejects(() => usa.collect({ get }), /fetch failed/);
});
