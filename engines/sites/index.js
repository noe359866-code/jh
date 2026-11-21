const { createFetcher } = require('./extractor');
const { crearRegistry } = require('../resolvers');

// Proveedores de sitios: cada proveedor descubre las URLs de servidores
// (players/embeds) en una página de contenido. Equivale a los *Provider.kt
// de Streamflix (FlixLatamProvider, PoseidonHD2Provider, ...). La diferencia
// es que aquí solo nos interesa la resolución de stream: no catálogos, no
// metadatos, no demos.
const PROVEEDORES = [
  {
    clave: 'documaniatv',
    nombre: 'DocumaniaTV',
    titulo: 'HLS / MP4',
    hosts: ['www.documaniatv.com', 'documaniatv.com']
  },
  {
    clave: 'flixlatam',
    nombre: 'FlixLatam',
    titulo: 'HLS / MP4',
    hosts: ['www.flixlatam.com', 'flixlatam.com']
  },
  {
    clave: 'poseidonhd2',
    nombre: 'PoseidonHD2',
    titulo: 'HLS / MP4',
    hosts: ['www.poseidonhd2.co', 'poseidonhd2.co']
  }
];

// Solo los tres dominios de sitio son confiables por defecto. Los hosts de
// medios/CDN adicionales deben añadirse explícitamente via SITES_ALLOWED_HOSTS.
function hostsPermitidos() {
  const extras = (process.env.SITES_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...PROVEEDORES.flatMap(p => p.hosts.map(h => h.toLowerCase())), ...extras])];
}

function encontrarProveedor(host) {
  const normalizado = String(host).toLowerCase();
  return PROVEEDORES.find(p => p.hosts.includes(normalizado)) || null;
}

function validarUrlSitio(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('Se requiere una URL de sitio');
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('La URL del sitio no es una URL válida'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('La URL del sitio debe ser HTTPS sin credenciales');
  }
  const proveedor = encontrarProveedor(url.hostname);
  if (!proveedor) throw new TypeError(`Host de sitio no soportado: ${url.hostname}`);
  return { url, proveedor };
}

// Proveedor base: fetchea la página del sitio, extrae las URLs de servidor
// (iframes, enlaces a player, candidatos .m3u8/.mp4) y las deja listas para
// que el registry de resolvedores las resuelva.
function crearProveedorBase({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent }) {
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent });
  return {
    // Devuelve una lista de URLs de servidor (players/embeds) a resolver.
    async descubrirServidores(pageUrl) {
      const html = await fetcher.getText(pageUrl);
      const { media, frames } = fetcher.parsePage(html, pageUrl);
      const servidores = new Set();
      // Los candidatos literales .m3u8/.mp4 ya son streams directos.
      for (const url of media) servidores.add(url);
      // Los iframes son potentiales jugadores a resolver.
      for (const frame of frames) {
        if (allowedHosts.includes(new URL(frame).hostname.toLowerCase())) servidores.add(frame);
      }
      return [...servidores];
    }
  };
}

// Resolución de stream: valida la URL del sitio, descubre los servidores
// con el proveedor y resuelve cada uno mediante el registry de resolvedores.
// Devuelve [{ nombre, titulo, url }] verificados; lista vacía = nada verificable.
async function resolver(request, options = {}) {
  const { url, proveedor } = validarUrlSitio(request && request.url);
  const allowed = hostsPermitidos();
  const fetcher = createFetcher({
    allowedHosts: allowed,
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    pageReferer: url.origin + '/',
    onEvent: options.onEvent
  });
  const proveedorBase = crearProveedorBase({
    allowedHosts: allowed,
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    pageReferer: url.origin + '/',
    onEvent: options.onEvent
  });
  const servidores = await proveedorBase.descubrirServidores(url.href);

  // El registry de resolvedores necesita los hosts de reproductor permitidos.
  // Como los servidores pueden estar en dominios de reproductor distintos
  // (voe.sx, streamtape.com, ...), se autorizan los hosts de los servidores
  // descubrios, siempre que sean públicos (el fetch ya valida eso).
  const resolverHosts = [...allowed, ...servidores.map(s => new URL(s).hostname.toLowerCase())];
  const registry = crearRegistry({
    allowedHosts: resolverHosts,
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    pageReferer: url.origin + '/',
    onEvent: options.onEvent,
    voeKey: options.voeKey,
    voeIv: options.voeIv,
    vidsrcKeys: options.vidsrcKeys
  });

  const streams = [];
  const yaVistos = new Set();
  for (const servidor of servidores.slice(0, 10)) {
    try {
      const resueltos = await registry.resolver(servidor);
      for (const stream of resueltos) {
        if (!yaVistos.has(stream.url)) {
          yaVistos.add(stream.url);
          // Etiquetas en español: el nombre del sitio (proveedor) como
          // contexto principal; el resolvedor que lo encontró como detalle.
          streams.push({ nombre: proveedor.nombre, titulo: stream.titulo || 'HLS / MP4', url: stream.url });
        }
      }
    } catch (error) {
      if (options.onEvent) options.onEvent({ stage: 'resolver-failed', host: new URL(servidor).hostname, error: error.message });
    }
  }
  return streams;
}

module.exports = { PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver };
