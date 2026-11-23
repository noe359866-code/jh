// Registro de fuentes del catálogo de TV en español.
//
// `direct`  : el HTML/JSON expone URLs de medio reproducibles tal cual.
// `page`    : el HLS sale de un embed. Se extrae al recolectar (engines/live/
//             extract.js); si el embed falla, queda como enlace resoluble.
// `catalog` : solo catálogo/búsqueda; no hay URL de medio verificada.
// Las fuentes `direct` incluyen las listas M3U externas (playlist.js).
const extra = require('./extra');

const sources = [
  require('./tvgarden'),
  require('./eja'),
  require('./iptvcat'),
  require('./globalfreetv'),
  require('./tvenvivo'),
  require('./thedaddy'),
  require('./livelive24'),
  // Listas M3U publicadas por terceros (medios directos ya listos).
  require('./cinecity'),
  require('./telechancho'),
  require('./iptvchile'),
  require('./samsungtvplus'),
  require('./pluto'),
  require('./d9kod'),
  // Estados Unidos: canales en español + cadenas mayoritarias (iptv-org).
  require('./usa'),
  // Listas por país de iptv-org: rellenan los países con pocas fuentes.
  require('./iptvorg'),
  // TDT española y lista mundial con filtro estricto de español.
  require('./tdtchannels'),
  require('./freetv'),
  // Listas privadas del usuario (`config/extra-playlists.json` o
  // `EXTRA_PLAYLISTS`). Van al final y no existen por defecto: sin configuración
  // el catálogo es exactamente el público.
  ...extra.sources
];

const MODE = {
  tvgarden: 'direct',
  eja: 'direct',
  iptvcat: 'direct',
  globalfreetv: 'direct',
  tvenvivo: 'page',
  thedaddy: 'page',
  livelive24: 'catalog',
  // Listas M3U: medio directo ya incluido en la lista.
  cinecity: 'direct',
  telechancho: 'direct',
  iptvchile: 'direct',
  samsungtvplus: 'direct',
  pluto: 'direct',
  d9kod: 'direct',
  usa: 'direct',
  iptvorg: 'direct',
  tdtchannels: 'direct',
  freetv: 'direct',
  // Las listas privadas publican medios directos (Xtream/`mpegts`).
  ...Object.fromEntries(extra.sources.map(source => [source.id, 'direct']))
};

function byId(id) {
  return sources.find(source => source.id === id) || null;
}

module.exports = { sources, byId, MODE, extra };
