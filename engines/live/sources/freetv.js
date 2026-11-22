// Free-TV/IPTV: lista mundial de canales en abierto (2.200 entradas).
//
// Es mundial, no en español, así que se aplica el filtro estricto: solo entra lo
// que declara idioma español o país hispano. Sin ese filtro se colarían dos mil
// canales en albanés, italiano, árabe o ruso. Aporta sobre todo cadenas públicas
// de Latinoamérica y España que no están en las otras listas.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'freetv',
  name: 'Free-TV',
  urls: [
    'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'
  ],
  spanishOnly: true
});
