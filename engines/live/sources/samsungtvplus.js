// Fuente M3U externa: Samsung TV Plus ES.
// Canales FAST de Samsung TV Plus en español (194), generados por
// BuddyChewChew a partir del EPG de Samsung. Las URLs son redirecciones
// `jmp2.uk` que resuelven al `.m3u8` real.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'samsungtvplus',
  name: 'Samsung TV Plus ES',
  urls: [
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/samsungtvplus_es.m3u'
  ],
  // La lista es de España: el nombre del canal no siempre trae la bandera.
  defaultCountry: 'ES'
});
