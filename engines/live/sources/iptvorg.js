// Listas por país de `iptv-org` (`streams/<cc>.m3u`).
//
// Cada archivo trae los canales de un país con su `tvg-id` (`Mega.cl`). Es la
// fuente que rellena los países donde las demás listas llegan flojas (Cuba,
// Uruguay, Nicaragua, Panamá…) y, como el país viene en la URL, se etiqueta sin
// deducirlo del nombre.
//
// El idioma no viene en estos archivos. Se aplica la misma regla que en el resto
// del proyecto: se descarta lo que declare un idioma no hispano, y lo que no
// declara nada se queda (el verificador decide si sirve).
const { parsePlaylist } = require('./playlist');
const { COUNTRIES } = require('../countries');

const BASE = 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams';

async function collect({ get, onSource }) {
  const all = [];
  const counts = {};
  for (const country of COUNTRIES) {
    // España y Estados Unidos ya tienen fuente propia más completa.
    if (country.code === 'ES' || country.code === 'US') continue;
    const url = `${BASE}/${country.code.toLowerCase()}.m3u`;
    let text;
    try {
      text = await get(url, { allowHttp: true, maxBytes: 8 * 1024 * 1024, accept: 'application/x-mpegURL,text/plain,*/*' })
        .then(response => response.text);
    } catch (error) {
      counts[country.code] = `error: ${String(error.message).slice(0, 60)}`;
      continue;
    }
    const entries = parsePlaylist(text, { source: `iptv-org ${country.code}`, defaultCountry: country.code });
    counts[country.code] = entries.length;
    all.push(...entries);
  }
  if (onSource) onSource({ paises: counts });
  return all;
}

module.exports = { id: 'iptvorg', name: 'iptv-org (por país)', collect };
