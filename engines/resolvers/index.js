const { Resolvedor, crearResolvedorGenerico, normalizarDominio } = require('./base');
const { crearResolvedorVoe } = require('./voe');
const { crearResolvedorStreamtape } = require('./streamtape');
const { crearResolvedorVidsrc } = require('./vidsrc');
const { crearResolvedoresPacked, SERVIDORES } = require('./packed');

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
  // Todos los dominios de los players con P.A.C.K.E.R. (incluye los rotados
  // que Embed69 devuelve: morencius.com, hglink.to, do7go.com...).
  ...Object.values(SERVIDORES).flatMap(s => s.dominios)
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

  const configuración = { allowedHosts: hosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent };
  const resolvers = [
    crearResolvedorVoe({ ...configuración, clave: voeKey, iv: voeIv }),
    crearResolvedorStreamtape(configuración),
    crearResolvedorVidsrc({ ...configuración, claves: vidsrcKeys }),
    // Players con P.A.C.K.E.R.: los que devuelve Embed69 en FlixLatam.
    ...crearResolvedoresPacked(configuración),
    crearResolvedorGenerico(configuración)
  ];

  function encontrarResolvedor(link, { soloGenerico = false } = {}) {
    const generico = resolvers[resolvers.length - 1];
    if (soloGenerico) return generico;
    let host = '';
    try { host = new URL(link).hostname; } catch { return generico; }
    const encontrado = resolvers.find(r => r.coincide(host)) || generico;
    // Cada petición puede venir de una página distinta (Embed69): el Referer
    // original se conserva y, si el resolvedor dedicado ya tiene uno propio
    // (Voe), no se pisa.
    return encontrado;
  }

  // Resuelve una URL de embed/player a streams verificados. Un resolvedor puede
  // delegar en este mismo registry (Vidsrc devuelve embeds de VOE/Streamtape),
  // pero solo un nivel: la profundidad evita bucles entre reproductores.
  async function resolver(link, ctx = {}) {
    const resolvedor = encontrarResolvedor(link, ctx);
    const profundidad = (ctx.profundidad || 0) + 1;
    const contexto = { ...ctx, profundidad };
    if (profundidad < 2) contexto.delegar = (url) => resolver(url, contexto);
    return resolvedor.resolver(link, contexto);
  }

  return { resolvers, encontrarResolvedor, resolver, hosts };
}

function hostsReproductores() { return [...HOSTS_REPRODUCTORES]; }

module.exports = { crearRegistry, Resolvedor, HOSTS_REPRODUCTORES, hostsReproductores, SERVIDORES };
