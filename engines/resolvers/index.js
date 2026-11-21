const { Resolvedor, crearResolvedorGenerico, normalizarDominio } = require('./base');
const { crearResolvedorVoe } = require('./voe');
const { crearResolvedorStreamtape } = require('./streamtape');
const { crearResolvedorVidsrc } = require('./vidsrc');

// Dominios de reproductor conocidos: se autorizan explícitamente (además de los
// hosts de sitio) porque son destinos legítimos de embed. Ampliar esta lista es
// una decisión de configuración, nunca automática a partir del HTML.
const HOSTS_REPRODUCTORES = [
  'voe.sx', 'jilliandescribecompany.com', 'mikaylaarealike.com', 'christopheruntilpoint.com',
  'walterprettytheir.com', 'crystaltreatmenteast.com', 'lauradaydo.com', 'lancewhosedifficult.com',
  'dianaavoidthey.com', 'jefferycontrolmodel.com', 'charlestoughrace.com', 'richardquestionbuilding.com',
  'jessicayeahcatch.com', 'juliewomanwish.com', 'rebeccapracticeloss.com', 'johnbeyondnation.com',
  'jamesbornmain.com', 'goofy-banana.com',
  'streamtape.com', 'streamta.site', 'streamtape.to', 'strtape.cloud',
  'vidsrc.to', 'vidsrc.net', 'vidsrc.icu', 'vidsrc.me', 'vidsrc.in', 'vidsrc.pm', 'vidsrc.xyz',
  'doodstream.com', 'dood.watch', 'dood.to', 'dood.so', 'dood.cx', 'dood.la', 'dood.pm', 'dood.ws',
  'filemoon.sx', 'filemoon.to', 'filemoon.in',
  'vidhide.com', 'vidhidepro.com', 'vidhidevip.com', 'streamwish.to', 'streamwish.com',
  'sfastwish.com', 'wishembed.pro', 'embedwish.com', 'awish.pro', 'strwish.com', 'swhoi.com',
  'vidoza.net', 'vidoza.org', 'ok.ru', 'mixdrop.co', 'mixdrop.to', 'mixdrop.sx', 'mixdrop.bz',
  'upstream.to', 'vudeo.net', 'vudeo.io', 'embed69.org', 'netu.tv', 'waaw.to', 'pelisplus.lat',
  // Vistos en la extracción real: FlixLatam sirve su reproductor desde uqload.
  'uqload.vc', 'uqload.com', 'uqload.co', 'uqload.to', 'uqload.su', 'uqload.io'
];

// Registry de resolvedores de reproductores. Equivale al listado de extractors
// y al dispatcher de Extractor.kt de Streamflix: dada una URL de embed/player,
// localiza el resolvedor cuyo dominio coincida y lo invoca. Si ningún
// resolvedor coincide, usa el resolvedor genérico (barrido literal).
//
// Cada resolvedor devuelve streams verificados (HLS/MP4) o una lista vacía.
function crearRegistry({
  allowedHosts = [],
  fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent,
  voeKey, voeIv, vidsrcKeys
} = {}) {
  const hosts = [...new Set([...allowedHosts.map(normalizarDominio), ...HOSTS_REPRODUCTORES])];

  const resolvers = [
    crearResolvedorVoe({ allowedHosts: hosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent, clave: voeKey, iv: voeIv }),
    crearResolvedorStreamtape({ allowedHosts: hosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent }),
    crearResolvedorVidsrc({ allowedHosts: hosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent, claves: vidsrcKeys }),
    crearResolvedorGenerico({ allowedHosts: hosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent })
  ];

  function encontrarResolvedor(link) {
    let host = '';
    try { host = new URL(link).hostname; } catch { return resolvers[resolvers.length - 1]; }
    return resolvers.find(r => r.coincide(host)) || resolvers[resolvers.length - 1];
  }

  // Resuelve una URL de embed/player a streams verificados. Un resolvedor puede
  // delegar en este mismo registry (Vidsrc devuelve embeds de VOE/Streamtape),
  // pero solo un nivel: la profundidad evita bucles entre reproductores.
  async function resolver(link, ctx = {}) {
    const resolvedor = encontrarResolvedor(link);
    const profundidad = (ctx.profundidad || 0) + 1;
    const contexto = { ...ctx, profundidad };
    if (profundidad < 2) contexto.delegar = (url) => resolver(url, contexto);
    return resolvedor.resolver(link, contexto);
  }

  return { resolvers, encontrarResolvedor, resolver, hosts };
}

function hostsReproductores() { return [...HOSTS_REPRODUCTORES]; }

module.exports = { crearRegistry, Resolvedor, HOSTS_REPRODUCTORES, hostsReproductores };
