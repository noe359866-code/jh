const { createFetcher } = require('./fetcher');

// Base de un resolvedor de reproductor. Cada resolvedor mapea un dominio de
// reproductor (o alias) a una función que, dada la URL del embed/player,
// devuelve streams verificados (HLS/MP4). Equivale a Extractor.kt de Streamflix.
//
// El resolvedor NO ejecuta JS, no maneja cookies ni CAPTCHA: solo fetch de
// páginas ya renderizadas y descifrado de payloads visibles.
class Resolvedor {
  constructor(config) {
    this.nombre = config.nombre;
    this.urlPrincipal = config.urlPrincipal;
    this.urlsAlias = (config.urlsAlias || []).map(u => u.toLowerCase());
    this.resuelve = config.resuelve;
  }

  // Devuelve true si el host de la URL coincide con este resolvedor.
  coincide(host) {
    const normalized = String(host).toLowerCase().replace(/^www\./, '');
    const principal = this.urlPrincipal.replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
    if (normalized === principal || normalized.endsWith('.' + principal) || normalized === principal) return true;
    if (this.urlsAlias.some(alias => normalized === alias || normalized.endsWith('.' + alias))) return true;
    return false;
  }

  async resolver(link, ctx) {
    return this.resuelve(link, ctx);
  }
}

// Construye un resolvedor genérico: dado un link de embed o de media directo,
// verifica la URL del propio servidor (si es .m3u8/.mp4) y, como respaldo,
// fetchea la página y extrae candidatos literales .m3u8/.mp4 verificados.
// Es el resolvedor por defecto para hosts no reconocidos.
function crearResolvedorGenerico({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent } = {}) {
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent });
  return new Resolvedor({
    nombre: 'Genérico',
    urlPrincipal: 'resolvedor://generico',
    resuelve: async (link) => {
      const streams = [];
      const yaVistos = new Set();
      const agregar = async (url) => {
        if (yaVistos.has(url)) return;
        yaVistos.add(url);
        try {
          if (await fetcher.verify(url)) streams.push({ nombre: 'Genérico', titulo: 'HLS / MP4', url });
        } catch { /* candidato fallido */ }
      };
      // Si el propio enlace es un media directo, verificarlo primero.
      if (/\.(?:m3u8|mp4)(?:\?|$)/i.test(new URL(link).pathname)) {
        await agregar(link);
        return streams;
      }
      // Respaldo: barrido literal de candidatos en la página del servidor.
      try {
        const html = await fetcher.getText(link);
        const { media } = fetcher.parsePage(html, link);
        for (const url of media.slice(0, 10)) await agregar(url);
      } catch { /* página no accesible */ }
      return streams;
    }
  });
}

module.exports = { Resolvedor, crearResolvedorGenerico };
