const { createFetcher } = require('./extractor');
const { crearProveedorFlixLatam } = require('./flixlatam');
const { crearProveedorGnula } = require('./gnula');
const { crearRegistry, hostsReproductores } = require('../resolvers');

// Proveedores de sitios: cada proveedor conoce el flujo real de su sitio y
// devuelve las páginas de reproductor o los servidores ya descifrados.
// Equivale a los *Provider.kt de Streamflix.
//
// DocumaniaTV y PoseidonHD2 se retiraron: el primero bloquea IPs de datacenter
// con HTTP 403 y el segundo no expone los servidores en el HTML estático.
//
// `flujo` decide qué descubridor se usa:
//   - 'embed69': el sitio incrusta Embed69 (lista de servidores cifrada + Anubis).
//   - 'gnula': WordPress con API propia (`/wp-json/gnrd/v1/...`); los
//     servidores llegan cifrados y se descifran en memoria (base64 + XOR).
//   - 'generico' (previsto): WordPress con modal sin API, donde solo las pistas
//     legibles del HTML se pueden pasar al registry.
const PROVEEDORES = [
  {
    clave: 'flixlatam',
    nombre: 'FlixLatam',
    titulo: 'HLS / MP4',
    flujo: 'embed69',
    hosts: ['www.flixlatam.com', 'flixlatam.com']
  },
  {
    clave: 'gnula',
    nombre: 'Gnula',
    titulo: 'HLS / MP4',
    flujo: 'gnula',
    hosts: ['ww3.gnulahd.nu', 'gnulahd.nu', 'www.gnulahd.nu']
  }
];

// Hosts confiables por defecto: el dominio del sitio, el reproductor Embed69 y
// los dominios de reproductor conocidos del registry. Son destinos legítimos
// del flujo de resolución, no se descubren desde el HTML. Los medios servidos
// desde CDN deben añadirse explícitamente con SITES_ALLOWED_HOSTS.
// Hosts de reproductor que el payload de Gnula declara y el registry resuelve
// (Voe ya está por `hostsReproductores`; los demás se añaden explícitamente).
// No se toman del HTML: son destinos declarados de este flujo.
const HOSTS_GNULA = ['savefiles.com', 'bysevepoin.com', 'vidara.to', 'vidaraa.cc'];

function hostsPermitidos(entorno = process.env) {
  const extras = (entorno.SITES_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([
    ...PROVEEDORES.flatMap(p => p.hosts.map(h => h.toLowerCase())),
    'embed69.org',
    ...HOSTS_GNULA,
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
  const emitir = typeof options.onEvent === 'function' ? options.onEvent : () => {};
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

  // Presupuesto total compartido: la ficha, Anubis y los players se reparten el
  // mismo deadline en lugar de encadenar esperas independientes.
  const PRESUPUESTO_SERVIDOR = 25000;
  const total = Math.max(Number(options.deadlineMs) || 20000, 15000);
  const limite = Date.now() + total;
  const consumo = { restante: () => limite - Date.now() };

  // Cada sitio tiene su propio flujo; el resto (registry, presupuesto,
  // etiquetas) es común.
  const descubridor = proveedor.flujo === 'gnula'
    ? crearProveedorGnula({ ...configuracion, entorno: options.entorno })
    : crearProveedorFlixLatam(configuracion);
  const { media, servidores, reproductor } = await descubridor.descubrir(url.href);

  // El registry fija su presupuesto al construirse (cada resolvedor crea su
  // fetcher con ese deadline), así que se construye uno por servidor con el
  // tiempo que queda: un player lento no puede dejar sin turno a los demás.
  const registryPara = (milisegundos) => crearRegistry({
    ...configuracion,
    deadlineMs: Math.max(3000, milisegundos),
    onEvent: options.onEvent,
    voeKey: options.voeKey,
    voeIv: options.voeIv,
    vidsrcKeys: options.vidsrcKeys
  });

  const streams = [];
  const yaVistos = new Set();
  // Qué servidor entregó cada stream: el reporte en vivo lo usa para decir
  // quién devolvió HLS y quién MP4, no solo cuántos medios hay en total.
  const entregados = [];
  const agregar = (stream, etiqueta, servidor) => {
    const limpia = sanitizarUrl(stream.url);
    if (!limpia || yaVistos.has(limpia)) return false;
    yaVistos.add(limpia);
    // La firma ya se verificó: la extensión de la URL dice el tipo. Si no
    // declara extensión, el medio es HLS (una playlist) salvo que sea MP4.
    let tipo = 'hls';
    try {
      const ruta = new URL(limpia).pathname;
      if (/\.mp4$/i.test(ruta)) tipo = 'mp4';
      else if (/\.m3u8$/i.test(ruta)) tipo = 'hls';
      else if (typeof stream.tipo === 'string') tipo = stream.tipo;
    } catch { /* URL ya validada */ }
    if (servidor) {
      entregados.push({
        servidor: servidor.servidor || '', idioma: servidor.idioma || '',
        host: (() => { try { return new URL(servidor.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
        tipo
      });
      emitir({ stage: 'fuente', host: entregados[entregados.length - 1].host, servidor: servidor.servidor, idioma: servidor.idioma, tipo });
    }
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
  //
  //    Presupuesto por servidor: todos comparten el deadline total, así que
  //    los primeros podían consumirlo y dejar a los siguientes con "tiempo
  //    agotado" sin haberlos probado. Cada servidor recibe su propio límite y
  //    se reducen los que se intentan cuando ya hay medios (basta uno por
  //    idioma para que el cliente pueda reproducir).
  const MAX_SERVIDORES = 8;
  // Orden de intento: primero los players que este extractor resuelve sin
  // ejecutar JavaScript (Voe descifra su JSON, Streamtape/Vidsrc piden su API).
  // Los que sirven una página "Loading..." que exige navegador van al final,
  // para que no consuman el turno de los que sí pueden dar medios.
  const SIN_JS = ['voe.sx', 'streamtape', 'vidsrc'];
  const prioridad = (url) => {
    const host = new URL(url).hostname;
    return SIN_JS.some(dominio => host === dominio || host.endsWith(`.${dominio}`)) ? 0 : 1;
  };
  const porIntentar = [...servidores].sort((a, b) => prioridad(a.url) - prioridad(b.url));
  for (const servidor of porIntentar.slice(0, MAX_SERVIDORES)) {
    const restante = consumo.restante();
    if (restante <= 0) {
      emitir({ stage: 'deadline', host: new URL(servidor.url).hostname });
      break;
    }
    try {
      // Los players comprueban el Referer de la página que los incrusta.
      const contexto = { pageReferer: reproductor };
      const presupuesto = Math.min(restante, PRESUPUESTO_SERVIDOR);
      const registry = registryPara(presupuesto);
      const resueltos = await registry.resolver(servidor.url, contexto);
      for (const stream of resueltos) agregar(stream, servidor.etiqueta, servidor);
      if (!resueltos.length && consumo.restante() > 0) {
        const generico = await registryPara(Math.min(consumo.restante(), PRESUPUESTO_SERVIDOR))
          .resolver(servidor.url, { ...contexto, soloGenerico: true });
        for (const stream of generico) agregar(stream, servidor.etiqueta, servidor);
      }
    } catch (error) {
      const host = new URL(servidor.url).hostname;
      // ENOTFOUND = el dominio del player ya no existe (mirror muerto): no es
      // un fallo de extracción ni algo que se arregle reintentando.
      if (/ENOTFOUND/i.test(error.message)) emitir({ stage: 'mirror-muerto', host });
      else emitir({ stage: 'resolver-failed', host, error: error.message });
    }
  }
  // `entregados` describe qué servidor dio qué tipo de media. Se expone en el
  // reporte en vivo; la lista de streams de Stremio sigue siendo `streams`.
  Object.defineProperty(streams, 'entregados', { value: entregados, enumerable: false });
  return streams;
}

module.exports = {
  PROVEEDORES, hostsPermitidos, encontrarProveedor, validarUrlSitio, resolver, sanitizarUrl
};
