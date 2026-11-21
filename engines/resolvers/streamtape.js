const { Resolvedor } = require('./base');

// Resolvedor Streamtape. Modelado en StreamtapeExtractor.kt de Streamflix:
// fetchea la página del player, extrae los parámetros (id, expires, ip,
// token) del script `botlink`, construye la URL `get_video?...&stream=1` y
// sigue el redirect final hasta la URL real del media.
function crearResolvedorStreamtape({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent } = {}) {
  const { createFetcher } = require('./fetcher');
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent });
  return new Resolvedor({
    nombre: 'Streamtape',
    urlPrincipal: 'https://streamtape.com',
    urlsAlias: ['https://streamta.site'],
    resuelve: async (link) => {
      const html = await fetcher.getText(link);
      // document.getElementById('botlink').innerHTML = 'BASE' + ('PARAM').substring(N)
      const re = /getElementById\('botlink'\)\.innerHTML\s*=\s*'([^']+)'\s*\+\s*\('([^']+)'\)\.substring\(([0-9]+)\)/;
      const match = html.match(re);
      if (!match) {
        // Respaldo: barrido literal de candidatos.
        const { media } = fetcher.parsePage(html, link);
        const streams = [];
        for (const url of media.slice(0, 10)) {
          try { if (await fetcher.verify(url)) streams.push({ nombre: 'Streamtape', titulo: 'HLS / MP4', url }); } catch { /* fallido */ }
        }
        return streams;
      }
      const base = match[1];
      const cleanParams = match[2].substring(Number(match[3]));
      const id = /(?:^|&)id=([^&]+)/.exec(cleanParams)?.[1];
      const expires = /(?:^|&)expires=([^&]+)/.exec(cleanParams)?.[1];
      const ip = /(?:^|&)ip=([^&]+)/.exec(cleanParams)?.[1];
      const token = /(?:^|&)token=([^&]+)/.exec(cleanParams)?.[1];
      if (!id || !expires || !ip || !token) {
        const { media } = fetcher.parsePage(html, link);
        const streams = [];
        for (const url of media.slice(0, 10)) {
          try { if (await fetcher.verify(url)) streams.push({ nombre: 'Streamtape', titulo: 'HLS / MP4', url }); } catch { /* fallido */ }
        }
        return streams;
      }
      const finalUrl = `${base}/get_video?id=${id}&expires=${expires}&ip=${ip}&token=${token}&stream=1`;
      // La URL final se obtiene siguiendo la petición; fetch con redirect='manual'
      // para capturar la ubicación real y luego verificarla.
      try {
        const response = await fetcher.request(finalUrl);
        // El media real suele estar en la redirección final; si responde OK,
        // verificar la firma del cuerpo.
        const prefix = (await fetcher.readLimited(response)).subarray(0, 512);
        const hls = prefix.toString('utf8').replace(/^/, '').trimStart().startsWith('#EXTM3U');
        const mp4 = prefix.length >= 12 && prefix.toString('ascii', 4, 8) === 'ftyp';
        if (hls || mp4) {
          // Reconstruir la URL verificada (el fetch resolvió redirects internos).
          const streams = [];
          try {
            // Verificar la URL final directamente para capturar la ubicación canónica.
            if (await fetcher.verify(finalUrl)) streams.push({ nombre: 'Streamtape', titulo: 'HLS / MP4', url: finalUrl });
          } catch { /* si verify falla, dejamos el stream vacío */ }
          return streams;
        }
      } catch { /* get_video no resolvió: cae al barrido literal */ }
      const { media } = fetcher.parsePage(html, link);
      const streams = [];
      for (const url of media.slice(0, 10)) {
        try { if (await fetcher.verify(url)) streams.push({ nombre: 'Streamtape', titulo: 'HLS / MP4', url }); } catch { /* fallido */ }
      }
      return streams;
    }
  });
}

module.exports = { crearResolvedorStreamtape };
