// Fuente M3U externa: telechancho.
// Lista "Infinity" de Telechancho (Argentina): generalistas, noticias,
// repetidoras y radios. La página de GitHub Pages sirve el M3U generado por
// Jekyll a partir de sus YAML; se consume la lista ya publicada.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'telechancho',
  name: 'telechancho',
  urls: [
    'https://telechancho.github.io/infinity.m3u'
  ]
});
