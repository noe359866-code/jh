// TDTChannels: la TDT española en abierto (La 1, La 2, 24h, Teledeporte,
// autonómicas y locales), mantenida por LaQuay/TDTChannels.
//
// El `group-title` de la lista es la categoría real (Generalistas, Informativos,
// Deportivos…), no el país, así que se mapea a las categorías del addon. La
// lista repite cada canal con varias señales (DVR, Rakuten, Ottera…) y el
// catálogo las agrupa por nombre.
const { createPlaylistSource } = require('./playlist');

module.exports = createPlaylistSource({
  id: 'tdtchannels',
  name: 'TDTChannels',
  urls: [
    'https://www.tdtchannels.com/lists/tv.m3u8'
  ],
  // Es una lista nacional: todo lo que no declare otro país es de España.
  defaultCountry: 'ES'
});
