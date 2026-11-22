// Registro de fuentes del catálogo de TV en español.
//
// `direct`  : el HTML/JSON expone URLs de medio reproducibles tal cual.
// `page`    : requiere resolver una cadena al reproducir (bajo demanda).
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
