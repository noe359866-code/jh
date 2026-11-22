// Fuente M3U externa: cinecity.
// Lista de CineCity (Argentina): canales en español de cine, deportes,
// noticias y regionales, con `group-title` por país. Se publica como está: el
// verificador descarta lo que no responde.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'cinecity',
  name: 'cinecity',
  urls: [
    'https://raw.githubusercontent.com/CINECITY2023/cinecity/cinecity.net/principal.m3u'
  ]
});
