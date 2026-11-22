// Fuente M3U externa: D9Kod.
// Lista corta servida por un acortador (`s.id`). Se sigue la redirección y se
// publica lo que contenga: el verificador decide qué se queda.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'd9kod',
  name: 'D9Kod',
  urls: [
    'https://s.id/d9Kod'
  ]
});
