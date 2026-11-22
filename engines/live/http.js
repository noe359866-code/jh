// Utilidades de red para el motor de TV en directo.
//
// Todo el tráfico interno (catálogos y páginas de origen) pasa por `get`, que
// aplica la misma política que el resto del proyecto: HTTPS, sin credenciales,
// solo puertos 80/443, destinos IPv4 públicos y sin redirecciones. El catálogo
// es estático: no se ejecuta JavaScript, no se usan cookies y no se resuelven
// CAPTCHAs. Los tests inyectan `fetchImpl` y `lookupImpl` para ser deterministas
// y sin red.
const dns = require('node:dns');
const { isIP, BlockList } = require('node:net');
const zlib = require('node:zlib');
const { Agent, fetch } = require('undici');

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(ip, prefix, 'ipv4');
}

function publicAddress(address) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}

// La dirección validada es la que se pasa al socket: no hay una segunda
// resolución DNS entre la comprobación y la conexión.
function createPublicLookup(lookup = dns.lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { family: 4, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        return callback(new Error('Destino no público bloqueado'));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, 4);
    });
  };
}

const dispatcher = new Agent({
  connect: { lookup: createPublicLookup(), timeout: 10000 },
  connections: 6, pipelining: 1, headersTimeout: 12000, bodyTimeout: 20000
});

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// `redirect: 'error'` evita saltos a hosts no validados. El cuerpo se lee
// completo pero con límite estricto de bytes.
function publicFetch(url, options) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL inválida');
  }
  if (parsed.protocol !== 'https:') throw new Error('Solo se permite HTTPS');
  if (parsed.username || parsed.password) throw new Error('URL con credenciales rechazada');
  if (parsed.port && parsed.port !== '443') throw new Error('Puerto no permitido');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new Error('Destino no público bloqueado');
  return fetch(parsed, { ...options, dispatcher, redirect: 'manual' });
}

function decodeBody(buffer) {
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buffer).toString('utf8');
    } catch {
      return buffer.toString('utf8');
    }
  }
  return buffer.toString('utf8');
}

/**
 * Descarga un recurso de texto siguiendo redirecciones con validación por salto.
 * Devuelve `{ status, url, contentType, text }`. Lanza `HTTP <status>` en
 * respuestas no 2xx para que el llamador decida.
 *
 * `allowHttp` se reserva a catálogos públicos cuyo origen solo responde por
 * HTTP tras la redirección (p. ej. eja.tv); el destino se valida igualmente
 * (sin credenciales, puerto 80/443, IPv4 pública).
 */
async function get(url, {
  fetchImpl = publicFetch,
  lookupImpl = dns.promises.lookup,
  timeoutMs = 12000,
  maxBytes = 6 * 1024 * 1024,
  headers = {},
  referer,
  accept = 'text/html,application/json;q=0.9,*/*;q=0.8',
  allowHttp = false,
  maxRedirects = 4
} = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'https:' && !(allowHttp && current.protocol === 'http:')) {
      throw new Error('Solo se permite HTTPS');
    }
    if (current.username || current.password) throw new Error('URL con credenciales rechazada');
    if (current.port && !['80', '443'].includes(current.port)) throw new Error('Puerto no permitido');
    const addresses = await lookupImpl(current.hostname, { all: true, family: 4 });
    if (!addresses || !addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw new Error('Destino no público bloqueado');
    }
    const response = await fetchImpl(current.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: accept,
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.6',
        'Accept-Encoding': 'gzip, deflate',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
        ...(referer ? { Referer: referer } : {}),
        ...headers
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} sin Location`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('Respuesta excede el límite de tamaño');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return {
      status: response.status,
      url: current.href,
      contentType: response.headers.get('content-type') || '',
      text: decodeBody(Buffer.concat(chunks))
    };
  }
  throw new Error('Demasiadas redirecciones');
}

module.exports = { get, publicFetch, publicAddress, createPublicLookup, BROWSER_UA };
