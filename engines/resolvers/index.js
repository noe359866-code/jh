const { Resolvedor, crearResolvedorGenerico } = require('./base');
const { crearResolvedorVoe } = require('./voe');
const { crearResolvedorStreamtape } = require('./streamtape');
const { crearResolvedorVidsrc } = require('./vidsrc');

// Registry de resolvedores de reproductores. Equivale al listado de extractors
// y al dispatcher de Extractor.kt de Streamflix: dada una URL de embed/player,
// localiza el resolvedor cuyo dominio coincida y lo invoca. Si ningún
// resolvedor coincide, usa el resolvedor genérico (barrido literal).
//
// Cada resolvedor devuelve streams verificados (HLS/MP4) o una lista vacía.
function crearRegistry({
  allowedHosts = [],
  fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent,
  voeKey, voeIv, vidsrcKeys
} = {}) {
  const resolvers = [
    crearResolvedorVoe({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent, clave: voeKey, iv: voeIv }),
    crearResolvedorStreamtape({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent }),
    crearResolvedorVidsrc({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent, claves: vidsrcKeys }),
    crearResolvedorGenerico({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent })
  ];

  function encontrarResolvedor(link) {
    let host = '';
    try { host = new URL(link).hostname; } catch { return resolvers[resolvers.length - 1]; }
    return resolvers.find(r => r.coincide(host)) || resolvers[resolvers.length - 1];
  }

  // Resuelve una URL de embed/player a streams verificados.
  async function resolver(link, ctx) {
    const resolvedor = encontrarResolvedor(link);
    return resolvedor.resolver(link, ctx);
  }

  return { resolvers, encontrarResolvedor, resolver };
}

module.exports = { crearRegistry, Resolvedor };
