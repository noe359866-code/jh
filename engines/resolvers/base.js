const { createFetcher } = require('./fetcher');

// Base de un resolvedor de reproductor. Cada resolvedor mapea un dominio de
// reproductor (o alias) a una función que, dada la URL del embed/player,
// devuelve streams verificados (HLS/MP4). Equivale a Extractor.kt de Streamflix.
//
// El resolvedor NO ejecuta JS, no maneja cookies ni CAPTCHA: solo fetch de
// páginas ya renderizadas y descifrado de payloads visibles.
//
// Los dominios pueden declararse como URL completa (https://voe.sx) o como
// dominio suelto (voe.sx). Se comparan por etiquetas completas: un alias
// "voe.sx" acepta a.voe.sx pero nunca voe.sx.example.com.
function normalizarDominio(valor) {
  return String(valor).trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

class Resolvedor {
  constructor(config) {
    this.nombre = config.nombre;
    this.urlPrincipal = config.urlPrincipal;
    this.urlsAlias = (config.urlsAlias || []).map(normalizarDominio);
    this.dominio = normalizarDominio(config.urlPrincipal);
    this.resuelve = config.resuelve;
    this._fetcherConfig = config.fetcherConfig;
  }

  // Devuelve true si el host de la URL coincide con este resolvedor.
  coincide(host) {
    const normalized = normalizarDominio(host);
    if (!normalized) return false;
    const acepta = (dominio) => normalized === dominio || normalized.endsWith('.' + dominio);
    return acepta(this.dominio) || this.urlsAlias.some(acepta);
  }

  // Dominios que este resolvedor necesita poder pedir (para el registry).
  dominios() { return [this.dominio, ...this.urlsAlias]; }

  async resolver(link, ctx) {
    return this.resuelve(link, ctx);
  }
}

// Envuelve un candidato en el formato de stream interno.
function streamMedia(nombre, url, titulo = 'HLS / MP4') {
  return { nombre, titulo, url };
}

// Verifica en lote y devuelve solo los que tienen firma válida.
async function verificarCandidatos(fetcher, nombre, urls) {
  const vistos = new Set();
  const streams = [];
  for (const url of urls) {
    if (!url || vistos.has(url)) continue;
    vistos.add(url);
    try {
      if (await fetcher.verificar(url)) streams.push(streamMedia(nombre, url));
    } catch { /* candidato no verificable: se ignora */ }
    if (streams.length >= 10) break;
  }
  return streams;
}

// Construye un resolvedor genérico: dado un link de embed o de media directo,
// verifica la URL del propio servidor (si es .m3u8/.mp4) y, como respaldo,
// fetchea la página y extrae candidatos literales .m3u8/.mp4 verificados.
// Es el resolvedor por defecto para hosts no reconocidos.
const { unPackerTodo } = require('./packer');

function crearResolvedorGenerico({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent } = {}) {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });
  return new Resolvedor({
    nombre: 'Genérico',
    urlPrincipal: 'resolvedor://generico',
    resuelve: async (link, ctx = {}) => {
      const url = new URL(link);
      // Si el propio enlace es un media directo, verificarlo primero.
      if (/\.(?:m3u8|mp4)$/i.test(url.pathname)) {
        const streams = await verificarCandidatos(fetcher, 'Genérico', [link]);
        if (streams.length) return streams;
      }
      // Respaldo: barrido literal de candidatos en la página del servidor.
      // Los players de Embed69 rotan de dominio y usan P.A.C.K.E.R.; si su
      // resolvedor dedicado no los reconoce, este es el último recurso, así
      // que también desempaqueta y sigue el 302 al dominio estable.
      const cabeceras = ctx.pageReferer ? { Referer: ctx.pageReferer } : {};
      let html;
      try {
        html = await fetcher.getText(link, cabeceras, { seguirMismoMotor: true });
      } catch (error) {
        emitir({ stage: 'resolver-failed', host: url.hostname, error: error.message });
        return [];
      }
      const candidatos = [];
      for (const capa of unPackerTodo(html)) {
        const { media } = parsePageSeguro(fetcher, capa, link);
        for (const candidato of media) if (!candidatos.includes(candidato)) candidatos.push(candidato);
      }
      return verificarCandidatos(fetcher, 'Genérico', candidatos.slice(0, 10));
    }
  });
}

function parsePageSeguro(fetcher, html, base) {
  try { return fetcher.parsePage(html, base); } catch { return { media: [], frames: [] }; }
}

module.exports = { Resolvedor, crearResolvedorGenerico, normalizarDominio, streamMedia, verificarCandidatos };
