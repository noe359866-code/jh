const { Resolvedor, verificarCandidatos } = require('./base');

// Modelado en StreamtapeExtractor.kt de Streamflix: fetchea la página del
// player, extrae los parámetros (id, expires, ip, token) del script `botlink`
// y construye la URL `get_video`. Esa URL responde con un 302 hacia el archivo
// real, así que la petición se hace con redirect='manual' y se valida el
// `Location`. Un 302 nunca se devuelve como stream: Stremio no puede reproducir
// una redirección con Referer obligatorio.
//
// Sin la URI final verificada, el resolvedor devuelve lista vacía en vez de
// prometer una URL que el reproductor rechazará.

function extraerBotlink(html) {
  // Formato clásico:
  //   document.getElementById('botlink').innerHTML = '/streamtape...' + ('&id=...').substring(N)
  const re = /getElementById\(['"]botlink['"]\)\s*\.\s*innerHTML\s*=\s*'([^']*)'\s*\+\s*\('([^']*)'\)\s*\.\s*substring\((\d+)\)/;
  const match = re.exec(html);
  if (!match) return null;
  const base = match[1];
  const parametros = match[2].substring(Number(match[3]));
  const leer = (nombre) => new RegExp(`(?:^|&)${nombre}=([^&]+)`).exec(parametros)?.[1];
  const id = leer('id');
  const expires = leer('expires');
  const ip = leer('ip');
  const token = leer('token');
  if (!id || !expires || !ip || !token) return null;
  return { base, id, expires, ip, token };
}

function construirGetVideo(link, partes) {
  // El script concatena la base con los parámetros ('BASE' + '?...'; la base
  // puede ser una ruta relativa, un host o una URL absoluta). Reconstruir con
  // URL + search evita duplicar barras y conserva la ruta que trae la base.
  const url = new URL(partes.base, link);
  url.search = new URLSearchParams({
    id: partes.id, expires: partes.expires, ip: partes.ip, token: partes.token, stream: '1'
  }).toString();
  return url.href;
}

function crearResolvedorStreamtape({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent } = {}) {
  const { createFetcher } = require('./fetcher');
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });
  return new Resolvedor({
    nombre: 'Streamtape',
    urlPrincipal: 'https://streamtape.com',
    urlsAlias: ['streamta.site', 'streamtape.to', 'strtape.cloud'],
    resuelve: async (link) => {
      const html = await fetcher.getText(link);
      const partes = extraerBotlink(html);
      if (partes) {
        const getVideo = construirGetVideo(link, partes);
        emitir({ stage: 'streamtape', host: new URL(link).hostname });
        try {
          const respuesta = await fetcher.request(getVideo, {}, { redirect: 'manual', permitirRedireccion: true });
          const ubicacion = respuesta.status >= 300 && respuesta.status < 400
            ? respuesta.headers.get('location')
            : null;
          if (ubicacion) {
            const destino = new URL(ubicacion, getVideo).href;
            // Solo se entrega si el destino (host autorizado y público) confirma
            // la firma del media.
            const verificado = await verificarCandidatos(fetcher, 'Streamtape', [destino]);
            if (verificado.length) return verificado;
          }
        } catch (error) {
          emitir({ stage: 'streamtape-failed', host: new URL(link).hostname, error: error.message });
        }
      }
      // Respaldo: barrido literal de candidatos en la página del player.
      const { media } = fetcher.parsePage(html, link);
      return verificarCandidatos(fetcher, 'Streamtape', media.slice(0, 10));
    }
  });
}

module.exports = { crearResolvedorStreamtape, extraerBotlink, construirGetVideo };
