const { createFetcher, createExtractor } = require('./extractor');
const { crearRegistry, hostsReproductores } = require('../resolvers');

// Proveedores de sitios: cada proveedor descubre las páginas de reproductor
// (players/embeds) de una página de contenido y las resuelve con el registry.
// Equivale a los *Provider.kt de Streamflix (FlixLatamProvider,
// PoseidonHD2Provider, ...). La diferencia es que aquí solo nos interesa la
// resolución de stream: no catálogos, no metadatos, no demos.
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

// Hosts confiables por defecto: los dominios del sitio y los dominios de
// reproductor conocidos del registry. Son destinos legítimos de embed, no se
// descubren desde el HTML. Los medios servidos desde CDN deben añadirse
// explícitamente con SITES_ALLOWED_HOSTS y nunca se autorizan automáticamente.
function hostsPermitidos(entorno = process.env) {
  const extras = (entorno.SITES_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([
    ...PROVEEDORES.flatMap(p => p.hosts.map(h => h.toLowerCase())),
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

// Limpieza mínima para no publicar tokens de sesión ni fragmentos.
function sanitizarUrl(raw, quitarQuery = false) {
  try {
    const url = new URL(raw);
    if (quitarQuery) url.search = '';
    return url.href;
  } catch { return null; }
}

// Resolución de stream: valida la URL del sitio, descubre los reproductores y
// los medios directos, y resuelve cada reproductor con el registry. Devuelve
// [{ name, title, url }] verificados (formato de objeto Stream de Stremio);
// lista vacía = nada verificable.
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

  // El extractor recorre la página y sus iframes del mismo sitio (o de hosts
  // autorizados) y verifica los candidatos .m3u8/.mp4 por firma.
  const extractor = createExtractor({ ...configuracion, maxPages: options.maxPages || 5, name: proveedor.nombre });
  const { media, embeds } = await extractor.descubrir(url.href);

  // Los reproductores se resuelven con su resolvedor dedicado; el registry no
  // amplía la lista de hosts con lo que aparezca en el HTML.
  const registry = crearRegistry({
    allowedHosts: allowed,
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs: options.timeoutMs,
    deadlineMs: options.deadlineMs,
    maxBytes: options.maxBytes,
    pageReferer: url.origin + '/',
    onEvent: options.onEvent,
    voeKey: options.voeKey,
    voeIv: options.voeIv,
    vidsrcKeys: options.vidsrcKeys
  });

  const streams = [];
  const yaVistos = new Set();
  const agregar = (stream) => {
    const limpia = sanitizarUrl(stream.url);
    if (!limpia || yaVistos.has(limpia)) return false;
    yaVistos.add(limpia);
    streams.push({
      name: proveedor.nombre,
      title: stream.titulo || proveedor.titulo || 'HLS / MP4',
      url: limpia
    });
    return true;
  };

  // 1) Medios literales de la página del sitio, verificados por firma (con
  //    concurrencia acotada y el mismo presupuesto de tiempo total).
  const fetcherMedios = createFetcher(configuracion);
  for (const candidato of media.slice(0, 10)) {
    try {
      if (await fetcherMedios.verificar(candidato)) agregar({ url: candidato });
    } catch (error) {
      if (options.onEvent) options.onEvent({ stage: 'candidate-failed', host: new URL(candidato).hostname, error: error.message });
    }
  }

  // 2) Reproductores descubiertos (iframes/embeds autorizados).
  for (const servidor of embeds.slice(0, 10)) {
    try {
      const resueltos = await registry.resolver(servidor);
      for (const stream of resueltos) agregar(stream);
    } catch (error) {
      if (options.onEvent) options.onEvent({ stage: 'resolver-failed', host: new URL(servidor).hostname, error: error.message });
    }
  }
  return streams;
}

module.exports = {
  PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver, sanitizarUrl
};
