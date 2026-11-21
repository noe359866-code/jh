const { createFetcher } = require('./extractor');
const { crearProveedorFlixLatam } = require('./flixlatam');
const { crearRegistry, hostsReproductores } = require('../resolvers');

// Proveedores de sitios: cada proveedor conoce el flujo real de su sitio y
// devuelve las páginas de reproductor o los servidores ya descifrados.
// Equivale a los *Provider.kt de Streamflix.
//
// Solo FlixLatam: DocumaniaTV y PoseidonHD2 se retiraron (el primero bloquea
// IPs de datacenter con HTTP 403 y el segundo no expone los servidores en el
// HTML estático).
const PROVEEDORES = [
  {
    clave: 'flixlatam',
    nombre: 'FlixLatam',
    titulo: 'HLS / MP4',
    hosts: ['www.flixlatam.com', 'flixlatam.com']
  }
];

// Hosts confiables por defecto: el dominio del sitio, el reproductor Embed69 y
// los dominios de reproductor conocidos del registry. Son destinos legítimos
// del flujo de resolución, no se descubren desde el HTML. Los medios servidos
// desde CDN deben añadirse explícitamente con SITES_ALLOWED_HOSTS.
function hostsPermitidos(entorno = process.env) {
  const extras = (entorno.SITES_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([
    ...PROVEEDORES.flatMap(p => p.hosts.map(h => h.toLowerCase())),
    'embed69.org',
    ...hostsReproductores(),
    ...extras
  ])];
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

function sanitizarUrl(raw, quitarQuery = false) {
  try {
    const url = new URL(raw);
    if (quitarQuery) url.search = '';
    return url.href;
  } catch { return null; }
}

// Resolución de stream: valida la URL, deja que el proveedor descubra los
// servidores y resuelve cada uno con el registry de reproductores. Devuelve
// [{ name, title, url }] verificados (objeto Stream de Stremio); lista vacía =
// nada verificable.
async function resolver(request, options = {}) {
  const { url, proveedor } = validarUrlSitio(request && request.url);
  const allowed = options.allowedHosts || hostsPermitidos();
  const configuracion = {
    allowedHosts: allowed,
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs: options.timeoutMs,
    deadlineMs: options.deadlineMs,
    maxBytes: options.maxBytes,
    pageReferer: url.origin + '/',
    onEvent: options.onEvent
  };

  const descubridor = crearProveedorFlixLatam(configuracion);
  const { media, servidores, reproductor } = await descubridor.descubrir(url.href);

  const registry = crearRegistry({
    ...configuracion,
    onEvent: options.onEvent,
    voeKey: options.voeKey,
    voeIv: options.voeIv,
    vidsrcKeys: options.vidsrcKeys
  });

  const streams = [];
  const yaVistos = new Set();
  const agregar = (stream, etiqueta) => {
    const limpia = sanitizarUrl(stream.url);
    if (!limpia || yaVistos.has(limpia)) return false;
    yaVistos.add(limpia);
    streams.push({
      name: proveedor.nombre,
      title: etiqueta || stream.titulo || proveedor.titulo || 'HLS / MP4',
      url: limpia
    });
    return true;
  };

  // 1) Medios literales de la ficha o del reproductor, verificados por firma.
  const fetcherMedios = createFetcher(configuracion);
  for (const candidato of media.slice(0, 10)) {
    try {
      if (await fetcherMedios.verificar(candidato)) agregar({ url: candidato });
    } catch (error) {
      if (options.onEvent) options.onEvent({ stage: 'candidate-failed', host: new URL(candidato).hostname, error: error.message });
    }
  }

  // 2) Servidores descifrados de Embed69: cada uno es un embed externo que el
  //    registry resuelve a HLS/MP4. La etiqueta indica idioma y servidor.
  //    Si el resolvedor dedicado falla, se intenta el genérico: los players
  //    rotan de dominio y el mismo motor (P.A.C.K.E.R.) sirve sin etiqueta.
  for (const servidor of servidores.slice(0, 12)) {
    try {
      // Los players comprueban el Referer de la página que los incrusta.
      const contexto = { pageReferer: reproductor };
      const resueltos = await registry.resolver(servidor.url, contexto);
      for (const stream of resueltos) agregar(stream, servidor.etiqueta);
      if (!resueltos.length) {
        const generico = await registry.resolver(servidor.url, { ...contexto, soloGenerico: true });
        for (const stream of generico) agregar(stream, servidor.etiqueta);
      }
    } catch (error) {
      if (options.onEvent) options.onEvent({ stage: 'resolver-failed', host: new URL(servidor.url).hostname, error: error.message });
    }
  }
  return streams;
}

module.exports = {
  PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver, sanitizarUrl
};
