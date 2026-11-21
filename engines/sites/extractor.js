const { lookup } = require('node:dns').promises;
const { publicAddress, createPublicFetch, resolveAddresses } = require('./network');

// ---------------------------------------------------------------------------
// Decodificación de la página
// ---------------------------------------------------------------------------

// Los sitios publican las URLs de media dentro de JSON/JS, así que aparecen
// escapadas de varias formas: \\/ , \\u002F , &#x2F; , &#47; , &amp; , &quot; ...
// Sin normalizarlas, una URL relativa se convierte en una ruta inventada
// (p. ej. https://sitio.example/u002F/u002Fcdn...) y el candidato se pierde.
const ENTIDADES_NOMBRADAS = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', colon: ':', sol: '/'
};

function decodificarTexto(texto) {
  return texto
    // Escapes de cadena JSON/JavaScript
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':')
    // Entidades HTML numéricas (&#47; &#x2F; &#38; ...)
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (original, hex, dec) => {
      const codigo = parseInt(hex === undefined ? dec : hex, hex === undefined ? 10 : 16);
      return Number.isFinite(codigo) && codigo > 0 ? String.fromCodePoint(codigo) : original;
    })
    // Entidades HTML con nombre
    .replace(/&([a-z]+);/gi, (original, nombre) => ENTIDADES_NOMBRADAS[nombre.toLowerCase()] ?? original);
}

function decode(texto) {
  // Las barras escapadas se resuelven al final para no deshacer los \\u002F ya
  // convertidos en el paso anterior.
  return decodificarTexto(texto).replace(/\\\//g, '/');
}

// ---------------------------------------------------------------------------
// Análisis del HTML
// ---------------------------------------------------------------------------

const EXTENSION_MEDIA = /\.(?:m3u8|mp4)(?![a-z0-9])/i;

function parseAttributes(tag) {
  const atributos = {};
  for (const match of String(tag).matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-\w:.]*)\s*=\s*'([^']*)'/g)) {
    const nombre = (match[1] || match[3]).toLowerCase();
    if (!(nombre in atributos)) atributos[nombre] = match[1] ? match[2] : match[4];
  }
  return atributos;
}

// Devuelve las URLs de media (.m3u8/.mp4) y las páginas de reproductor
// (iframes y data-embed) que aparecen literalmente en el HTML. No ejecuta JS:
// solo lee lo que ya está en el documento, incluido lo escapado en scripts.
function parsePage(html, base) {
  const media = new Set();
  const frames = new Set();
  const texto = decode(String(html));

  const agregar = (raw) => {
    if (!raw) return;
    let url;
    try {
      // Las páginas mezclan \\/ y \/ (: https:\\/\\/host\\/files ...), lo que
      // deja barras duplicadas dentro de la ruta. Se colapsan solo en la ruta:
      // el "//" del esquema y la query se conservan intactos.
      const limpia = raw.trim().replace(/([^:])\/{2,}/g, '$1/');
      url = new URL(limpia, base).href;
      const parsed = new URL(url);
      parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
      url = parsed.href;
    } catch { return; /* candidato malformado */ }
    if (!/^https?:/i.test(url)) return;
    // Una URL de media nunca es una página de reproductor, y viceversa.
    if (EXTENSION_MEDIA.test(new URL(url).pathname)) media.add(url);
    else frames.add(url);
  };

  // 1) Valores entrecomillados que contienen la extensión (admite query y #fragmento).
  for (const match of texto.matchAll(/["']([^"'<>\s]+\.(?:m3u8|mp4)(?:[^"'<>\s]*))["']/gi)) agregar(match[1]);

  // 2) Atributos sin comillas: src=https://cdn.example/a.m3u8
  for (const match of texto.matchAll(/\b(?:src|href|data-[\w-]+)\s*=\s*([^\s"'<>`]+)/gi)) {
    if (EXTENSION_MEDIA.test(match[1])) agregar(match[1]);
  }

  // 3) Iframes (src, data-src, data-lazy-src, data-url) y contenedores de embed.
  for (const tag of texto.matchAll(/<iframe\b([^>]*)>/gi)) {
    const attrs = parseAttributes(tag[1]);
    agregar(attrs.src || attrs['data-src'] || attrs['data-lazy-src'] || attrs['data-url']);
  }
  for (const match of texto.matchAll(/\bdata-(?:embed|player|iframe|video|url|src)\s*=\s*["']([^"']+)["']/gi)) {
    if (!EXTENSION_MEDIA.test(match[1])) agregar(match[1]);
  }

  return { media: [...media], frames: [...frames] };
}

// ---------------------------------------------------------------------------
// Firmas de media
// ---------------------------------------------------------------------------

// Un .m3u8 real contiene variantes (master) o segmentos (media). Un cuerpo que
// solo empieza por #EXTM3U puede ser una página de error o un stub: no se
// acepta como reproducible.
function firmaMedia(buffer) {
  if (!buffer || !buffer.length) return null;
  const texto = buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (texto.startsWith('#EXTM3U')) {
    // Un cuerpo que solo empieza por #EXTM3U (página de error, stub) no es una
    // playlist reproducible: se exige una directiva de contenido.
    if (/^#EXT-X-STREAM-INF/mi.test(texto)) return 'hls-master';
    if (/^#EXTINF|^#EXT-X-TARGETDURATION/mi.test(texto)) return 'hls-media';
    return null;
  }
  // Caja ISO BMFF: [tamaño:4][ftyp:4]
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return null;
}

function esEntidadHtmlSegura(valor) {
  return typeof valor === 'string' && valor.length > 0;
}

async function mapLimit(items, limit, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const indice = siguiente++;
      if (indice >= items.length) return;
      resultados[indice] = await fn(items[indice], indice);
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}

// ---------------------------------------------------------------------------
// Fetcher con políticas de seguridad
// ---------------------------------------------------------------------------

// Fetch compartido para proveedores y resolvedores. Aplica las políticas de
// seguridad: solo HTTPS, sin credenciales, destinos públicos IPv4, sin
// redirecciones (salvo peticiones que las necesitan de forma explícita), y un
// presupuesto de tiempo TOTAL por extracción (deadlineMs), no solo por petición.
// No ejecuta scripts, no maneja cookies, no resuelve CAPTCHAs ni evade DRM.
function createFetcher({
  allowedHosts = [],
  fetchImpl,
  lookupImpl = lookup,
  timeoutMs = 10000,
  deadlineMs = 20000,
  maxBytes = 2 * 1024 * 1024,
  pageReferer,
  onEvent
} = {}) {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  // Si se inyecta fetchImpl (pruebas) se respeta; si no, se usa el transporte
  // seguro con el lookup también inyectable: la dirección validada es la que se
  // conecta, sin un segundo DNS entre validación y conexión.
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : createPublicFetch({ lookupImpl, timeoutMs });
  const limite = Date.now() + Math.max(deadlineMs, timeoutMs);
  const DEFAULT_HEADERS = {
    // Los sitios públicos suelen rechazar peticiones sin User-Agent de navegador.
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  function restante() { return limite - Date.now(); }
  function signalDePeticion() {
    const ms = Math.min(timeoutMs, restante());
    if (ms <= 0) {
      const error = new Error('Tiempo de extracción agotado');
      error.code = 'DEADLINE_EXCEEDED';
      throw error;
    }
    return AbortSignal.timeout(ms);
  }

  async function request(raw, headers = {}, { method = 'GET', body, redirect = 'error', permitirRedireccion = false } = {}) {
    const url = new URL(raw);
    emitir({ stage: 'request', host: url.hostname });
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password
      || !hosts.has(url.hostname)) {
      emitir({ stage: 'blocked-host', host: url.hostname });
      throw new Error('Enlace no permitido: host no confiable');
    }
    // Comprobación explícita además de la del socket: da un error claro y evita
    // abrir conexión hacia destinos privados cuando el DNS responde mixto.
    const addresses = await resolveAddresses(lookupImpl, url.hostname);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw new Error('Destino no público bloqueado');
    }
    // Referencia al origen del sitio al verificar medios: algunos hosts
    // rechazan peticiones Range sin un Referer del mismo sitio.
    const referer = esEntidadHtmlSegura(pageReferer) ? pageReferer : undefined;
    let response;
    try {
      response = await fetchFn(url, {
        method, body, redirect, signal: signalDePeticion(),
        headers: { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}), ...headers }
      });
    } catch (error) {
      // "fetch failed" no dice nada: se añade el código real (ENOTFOUND,
      // UND_ERR_CONNECT_TIMEOUT, CERT_HAS_EXPIRED...) para poder diagnosticar,
      // conservando el mensaje y la causa originales del transporte.
      if (error && error.name === 'AbortError') throw new Error('Tiempo de petición agotado');
      const causa = error?.cause?.code || error?.cause?.message || error?.code;
      throw new Error(`Fallo de red${causa ? ` (${causa})` : ''}: ${error?.message || error}`, { cause: error });
    }
    if (permitirRedireccion && response.status >= 300 && response.status < 400) return response;
    if (!response.ok) throw new Error(`Solicitud fallida: HTTP ${response.status}`);
    return response;
  }

  async function readLimited(response) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('Respuesta excede el límite de tamaño');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }

  async function getText(raw, headers = {}, opciones = {}) {
    const response = await request(raw, headers, opciones);
    return (await readLimited(response)).toString('utf8');
  }

  async function getJson(raw, headers = {}, opciones = {}) {
    return JSON.parse(await getText(raw, { Accept: 'application/json', ...headers }, opciones));
  }

  // Lee el prefijo suficiente para reconocer la firma, sin descargar el archivo.
  async function leerPrefijo(response, bytes = 8192) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    let prefix = Buffer.alloc(0);
    try {
      while (prefix.length < Math.min(bytes, 65536)) {
        const { done, value } = await reader.read();
        if (done) break;
        prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 65536)]);
        if (firmaMedia(prefix)) break;
      }
    } finally { await reader.cancel(); }
    return prefix;
  }

  async function verificar(url, headers = {}) {
    const response = await request(url, { Range: 'bytes=0-65535', ...headers });
    return firmaMedia(await leerPrefijo(response)) !== null;
  }

  return { request, getText, getJson, verificar, verify: verificar, readLimited, leerPrefijo, parsePage, hosts };
}

// ---------------------------------------------------------------------------
// Extractor genérico de sitios
// ---------------------------------------------------------------------------

// Recorre la página de contenido y sus reproductores (iframes del mismo sitio o
// de hosts autorizados), recoge los candidatos .m3u8/.mp4 y los verifica por
// firma. Es el mismo motor que usan los proveedores de sitios.
function createExtractor({
  allowedHosts = [],
  fetchImpl,
  lookupImpl = lookup,
  timeoutMs = 10000,
  deadlineMs = 20000,
  maxPages = 5,
  maxCandidates = 10,
  concurrencia = 2,
  maxBytes = 2 * 1024 * 1024,
  name = 'Sites',
  title = 'HLS / MP4',
  pageReferer,
  onEvent
} = {}) {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });
  const hosts = fetcher.hosts;

  // Rastrea páginas e iframes y devuelve candidatos sin verificarlos todavía.
  // La página solicitada propaga sus errores (host no confiable, destino
  // privado, límite de tamaño, tiempo agotado): un fallo real no debe
  // presentarse como "sin medios". Las páginas anidadas sí se toleran.
  async function descubrir(pageUrl) {
    const pendientes = [pageUrl];
    const visitadas = new Set();
    const candidatos = new Set();
    const embeds = new Set();
    const clave = (url) => { const u = new URL(url); u.hash = ''; return u.href; };
    let html;
    while (pendientes.length && visitadas.size < maxPages) {
      const pagina = pendientes.shift();
      const ident = clave(pagina);
      if (visitadas.has(ident)) continue;
      visitadas.add(ident);
      if (ident === clave(pageUrl)) {
        html = await fetcher.getText(pagina);
      } else {
        try {
          html = await fetcher.getText(pagina);
        } catch (error) {
          emitir({ stage: 'page-failed', host: new URL(pagina).hostname, error: error.message });
          continue;
        }
      }
      const { media, frames } = parsePage(html, pagina);
      emitir({ stage: 'page', host: new URL(pagina).hostname, candidates: media.length, frames: frames.length });
      for (const url of media) candidatos.add(url);
      for (const frame of frames) {
        const host = new URL(frame).hostname.toLowerCase();
        if (!hosts.has(host)) {
          emitir({ stage: 'blocked-frame', host });
          continue;
        }
        // Los iframes autorizados se registran como reproductores a resolver y,
        // mientras quede presupuesto de páginas, también se rastrean por si
        // encadenan a otra página del mismo sitio.
        embeds.add(frame);
        if (visitadas.size + pendientes.length < maxPages) pendientes.push(frame);
      }
    }
    return { media: [...candidatos], embeds: [...embeds], paginas: visitadas.size };
  }

  async function analizar(pageUrl) {
    const { media, embeds, paginas } = await descubrir(pageUrl);
    const elegidos = media.slice(0, maxCandidates);
    const verificados = await mapLimit(elegidos, concurrencia, async (url) => {
      try {
        const ok = await fetcher.verificar(url);
        emitir({ stage: 'candidate', host: new URL(url).hostname, verified: ok });
        return ok ? url : null;
      } catch (error) {
        emitir({ stage: 'candidate-failed', host: new URL(url).hostname, error: error.message });
        return null;
      }
    });
    return { media, embeds, paginas, streams: verificados.filter(Boolean).map(url => ({ name, title, url })) };
  }

  async function extract(pageUrl) {
    return (await analizar(pageUrl)).streams;
  }

  return { extract, analizar, descubrir, verificar: fetcher.verificar, verify: fetcher.verificar, firmaMedia };
}

module.exports = {
  createFetcher, createExtractor, parsePage, decode, parseAttributes,
  firmaMedia, mapLimit, publicAddress
};
