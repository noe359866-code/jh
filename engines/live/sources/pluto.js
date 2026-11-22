// Fuente M3U externa: Pluto TV.
// Pluto TV y agregados (Tubi, Plex, Stirr…) en una sola lista de 850 canales.
// Solo se incorporan los marcados con bandera o país hispano; el resto del
// catálogo (EE. UU., Brasil…) se descarta.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'pluto',
  name: 'Pluto TV',
  urls: [
    'https://raw.githubusercontent.com/iprtl/m3u/live/Pluto.m3u'
  ]
});
