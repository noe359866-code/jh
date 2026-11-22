// Registro de fuentes del catálogo de TV en español.
//
// `direct`  : el HTML/JSON expone URLs de medio reproducibles tal cual.
// `page`    : el HLS sale de un embed. Se extrae al recolectar (engines/live/
//             extract.js); si el embed falla, queda como enlace resoluble.
// `catalog` : solo catálogo/búsqueda; no hay URL de medio verificada.
const sources = [
  require('./tvgarden'),
  require('./eja'),
  require('./iptvcat'),
  require('./globalfreetv'),
  require('./tvenvivo'),
  require('./thedaddy'),
  require('./livelive24')
];

const MODE = { tvgarden: 'direct', eja: 'direct', iptvcat: 'direct', globalfreetv: 'direct', tvenvivo: 'page', thedaddy: 'page', livelive24: 'catalog' };

function byId(id) {
  return sources.find(source => source.id === id) || null;
}

module.exports = { sources, byId, MODE };
