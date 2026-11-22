// Fuente M3U externa: iptv-chile.
// Lista de TV chilena mantenida por Orieus-lesauce: 23 canales nacionales
// (Mega, CHV, TVN, La Red…) con HLS directo.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'iptvchile',
  name: 'iptv-chile',
  urls: [
    'https://orieus-lesauce.github.io/iptv-chile/CL.m3u'
  ],
  // Lista nacional: todo lo que no declare otro país es de Chile.
  defaultCountry: 'CL'
});
