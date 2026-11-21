const { Resolvedor } = require('./base');
const { aesCbcDecrypt, encontrarCifrado } = require('./crypto');

// Resolvedor VOE (voe.sx). Modelado en VoeExtractor.kt de Streamflix: fetchea
// la página del player, localiza el payload cifrado (script JSON o regex),
// lo descifra con AES-128-CBC y extrae la fuente .m3u8. Si no hay payload
// cifrado, cae al barrido literal de candidatos .m3u8/.mp4.
//
// No ejecuta JS ni resuelve CAPTCHA. La clave/IV son configurables (VOE_KEY,
// VOE_IV); sin ellas, se skipa el descifrado y se usa el barrido literal.
function crearResolvedorVoe({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent, clave, iv } = {}) {
  const { createFetcher } = require('./fetcher');
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent });
  return new Resolvedor({
    nombre: 'VOE',
    urlPrincipal: 'https://voe.sx',
    urlsAlias: [
      'https://jilliandescribecompany.com', 'https://mikaylaarealike.com',
      'https://christopheruntilpoint.com', 'https://walterprettytheir.com',
      'https://crystaltreatmenteast.com', 'https://lauradaydo.com',
      'https://lancewhosedifficult.com', 'https://dianaavoidthey.com',
      'https://jefferycontrolmodel.com', 'https://charlestoughrace.com',
      'https://richardquestionbuilding.com', 'https://jessicayeahcatch.com',
      'https://juliewomanwish.com', 'https://rebeccapracticeloss.com',
      'https://johnbeyondnation.com', 'https://jamesbornmain.com',
      'https://goofy-banana.com'
    ],
    resuelve: async (link) => {
      const html = await fetcher.getText(link);
      const encoded = encontrarCifrado(html);
      let fuente = null;
      if (encoded && clave && iv) {
        try {
          const descifrado = aesCbcDecrypt(clave, iv, encoded);
          const match = descifrado.match(/"source"\s*:\s*"([^"]+)"/i);
          if (match) fuente = match[1];
        } catch { /* payload no decifrable: cae al barrido literal */ }
      }
      const streams = [];
      if (fuente) {
        try {
          if (await fetcher.verify(fuente)) {
            streams.push({ nombre: 'VOE', titulo: 'HLS / MP4', url: fuente });
            return streams;
          }
        } catch { /* fuente no verificable */ }
      }
      // Barrido literal como respaldo.
      const { media } = fetcher.parsePage(html, link);
      for (const url of media.slice(0, 10)) {
        try {
          if (await fetcher.verify(url)) streams.push({ nombre: 'VOE', titulo: 'HLS / MP4', url });
        } catch { /* candidato fallido */ }
      }
      return streams;
    }
  });
}

module.exports = { crearResolvedorVoe };
