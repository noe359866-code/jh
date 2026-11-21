const { Resolvedor, verificarCandidatos, normalizarDominio } = require('./base');
const { rc4 } = require('./crypto');

// Modelado en VidsrcToExtractor.kt de Streamflix: obtiene el media ID de la
// página embed, pide las fuentes a la API (vidsrc.icu) y descifra la URL con
// RC4 usando la clave completa de `decrypt`. Después verifica la firma del
// media y, si el servidor devuelto es otro reproductor conocido (VOE,
// Streamtape), delega en el registry mediante el contexto `ctx.delegar`.
// Sin JS, sin CAPTCHA.

const API_VIGENTE = 'https://vidsrc.icu/embed';
const DOMINIOS_VIGENTES = ['vidsrc.to', 'vidsrc.net', 'vidsrc.icu', 'vidsrc.me', 'vidsrc.in', 'vidsrc.pm', 'vidsrc.xyz'];

function esClaveValida(valor) {
  return Boolean(valor) && (typeof valor === 'string' || Buffer.isBuffer(valor) || Array.isArray(valor));
}

// Firma RC4 del payload de Vidsrc: mcrypt con base64 y clave UTF-8.
function descifrarConClave(clave, payloadBase64) {
  if (!esClaveValida(clave)) return null;
  const crudo = rc4(clave, Buffer.from(payloadBase64, 'base64')).toString('utf8');
  const url = crudo.split('\u0000')[0].trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

// Busca en el HTML el JSON de fuentes ya presente (algunos mirrors lo incrustan).
function fuentesEnHtml(html) {
  const resultado = [];
  for (const match of html.matchAll(/"url"\s*:\s*"([A-Za-z0-9+/=]{16,})"/g)) resultado.push(match[1]);
  for (const match of html.matchAll(/"id"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"([^"]+)"/g)) resultado.push(match[2]);
  return resultado;
}

function crearResolvedorVidsrc({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent, claves } = {}) {
  const { createFetcher } = require('./fetcher');
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  // El propio resolvedor autoriza explícitamente el host de su API: es parte
  // del resolvedor, no un host descubierto en el HTML.
  const hosts = [...new Set([...allowedHosts, new URL(API_VIGENTE).hostname, ...DOMINIOS_VIGENTES])];
  const fetcher = createFetcher({ allowedHosts: hosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });
  return new Resolvedor({
    nombre: 'Vidsrc.to',
    urlPrincipal: 'https://vidsrc.to',
    urlsAlias: ['vidsrc.net', 'vidsrc.icu', 'vidsrc.me', 'vidsrc.in', 'vidsrc.pm', 'vidsrc.xyz'],
    resuelve: async (link, ctx = {}) => {
      const html = await fetcher.getText(link);
      const mediaId = extraerMediaId(html);
      emitir({ stage: 'vidsrc', host: new URL(link).hostname, mediaId: mediaId ? 'si' : 'no' });

      const candidatos = [];
      // 1) API de fuentes (solo si hay mediaId y claves de descifrado).
      if (mediaId && claves && esClaveValida(claves.decrypt)) {
        try {
          const api = new URL(`/rcp/${mediaId}`, API_VIGENTE).href;
          const datos = await fetcher.getJson(api, { Referer: link });
          // La API responde con un array de fuentes o con un objeto que las
          // anida en result/sources.
          const lista = Array.isArray(datos) ? datos
            : Array.isArray(datos?.result) ? datos.result
              : Array.isArray(datos?.result?.sources) ? datos.result.sources
                : Array.isArray(datos?.sources) ? datos.sources : [];
          for (const fuente of lista) {
            if (!fuente || typeof fuente.url !== 'string') continue;
            const descifrada = descifrarConClave(claves.decrypt, fuente.url) || (fuente.url.startsWith('http') ? fuente.url : null);
            if (descifrada) candidatos.push(descifrada);
          }
        } catch (error) {
          emitir({ stage: 'vidsrc-api-failed', host: new URL(link).hostname, error: error.message });
        }
      }
      // 2) Fuentes incrustadas en la propia página (ya descargada: sin refetch).
      for (const cifrado of fuentesEnHtml(html)) {
        const descifrada = esClaveValida(claves?.decrypt) ? descifrarConClave(claves.decrypt, cifrado) : null;
        candidatos.push(descifrada || cifrado);
      }

      // 3) Si el candidato es un embed de otro reproductor, se delega en el
      // registry (VOE/Streamtape/...); si no, se verifica la firma directamente.
      const streams = [];
      const dominiosPropios = [normalizarDominio('https://vidsrc.to'), 'vidsrc.net', 'vidsrc.icu', 'vidsrc.me', 'vidsrc.in', 'vidsrc.pm', 'vidsrc.xyz'];
      for (const candidato of candidatos.slice(0, 10)) {
        let host = '';
        try { host = normalizarDominio(new URL(candidato).hostname); } catch { continue; }
        const propio = dominiosPropios.some(dominio => host === dominio || host.endsWith('.' + dominio));
        if (!propio && ctx && typeof ctx.delegar === 'function') {
          try {
            const resueltos = await ctx.delegar(candidato);
            for (const stream of resueltos || []) {
              streams.push({ nombre: 'Vidsrc.to', titulo: stream.titulo || 'HLS / MP4', url: stream.url });
            }
            if (streams.length) return streams;
          } catch { /* se intenta la verificación directa */ }
        }
      }
      const directos = await verificarCandidatos(fetcher, 'Vidsrc.to', candidatos.slice(0, 10));
      if (directos.length) return directos;

      // Respaldo: barrido literal de candidatos en la página.
      const { media } = fetcher.parsePage(html, link);
      return verificarCandidatos(fetcher, 'Vidsrc.to', media.slice(0, 10));
    }
  });
}

// El media ID aparece en el enlace de episodio/temporada o en el propio path.
function extraerMediaId(html) {
  const deLista = /<li[^>]*class=["'][^"']*(?:episode|season-item)[^"']*["'][^>]*>\s*<a[^>]*data-id=["']([^"']+)["']/i.exec(html)
    || /data-id=["']([^"']+)["'][^>]*>\s*(?:<[^>]+>\s*)*\d+/i.exec(html);
  if (deLista) return deLista[1];
  const delScript = /"id"\s*:\s*"?(\d{4,})"?/.exec(html);
  return delScript ? delScript[1] : null;
}

module.exports = { crearResolvedorVidsrc, extraerMediaId, descifrarConClave, API_VIGENTE };
