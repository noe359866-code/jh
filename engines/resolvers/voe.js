const { Resolvedor, verificarCandidatos } = require('./base');
const { esInterstitial, eventoSinMedia } = require('./packed');
const { seguirRedirector } = require('./redirector');
const { aesCbcDecryptRaw, quitarRelleno, encontrarCifrado } = require('./crypto');

// Clave/IV por defecto del player VOE; se pueden sobreescribir con VOE_KEY y
// VOE_IV (leídas en engines/resolvers/index.js).
const VOE_KEY_POR_DEFECTO = 'z1x2c3v4b5n6m7k8';

// Mirrors declarados de Voe. Un redirector JS solo se sigue hacia estos hosts:
// la lista es código del resolvedor, nunca un host descubierto en el HTML.
const MIRRORS_VOE = [
  'jilliandescribecompany.com', 'mikaylaarealike.com', 'christopheruntilpoint.com',
  'walterprettytheir.com', 'crystaltreatmenteast.com', 'lauradaydo.com',
  'lancewhosedifficult.com', 'dianaavoidthey.com', 'jefferycontrolmodel.com',
  'charlestoughrace.com', 'richardquestionbuilding.com', 'jessicayeahcatch.com',
  'juliewomanwish.com', 'rebeccapracticeloss.com', 'johnbeyondnation.com',
  'jamesbornmain.com', 'goofy-banana.com', 'caseyseemavoid.com'
];
const VOE_IV_POR_DEFECTO = 'q9w8e7r6t5y4u3i2';

// Modelado en VoeExtractor.kt de Streamflix: fetchea la página del player,
// localiza el payload cifrado, lo descifra con AES-128-CBC y extrae la fuente
// .m3u8. Si no hay payload descifrable, cae al barrido literal de candidatos.
// No ejecuta JS ni resuelve CAPTCHA.
function crearResolvedorVoe({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent,
  clave, iv } = {}) {
  const { createFetcher } = require('./fetcher');
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });
  const claveReal = clave || VOE_KEY_POR_DEFECTO;
  const ivReal = iv || VOE_IV_POR_DEFECTO;

  // Prueba el IV configurado y, si falla, el IV derivado del propio payload
  // (primeros 16 bytes del base64), variante que usan algunos mirrors.
  function descifrar(payload) {
    const ivDerivado = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').subarray(0, 16);
    const intentos = [{ iv: ivReal }, { iv: ivDerivado }];
    for (const intento of intentos) {
      const ivBytes = Buffer.isBuffer(intento.iv) ? intento.iv : Buffer.from(String(intento.iv), 'utf8');
      if (ivBytes.length !== 16) continue;
      try {
        const texto = quitarRelleno(aesCbcDecryptRaw(claveReal, ivBytes, payload).toString('utf8'));
        const fuente = /"?(?:source|file|hls)"?\s*[:=]\s*"([^"]+)"/i.exec(texto);
        if (fuente) return { fuente: fuente[1], texto };
        if (/^https?:\/\//i.test(texto.trim())) return { fuente: texto.trim().split(/\s/)[0], texto };
      } catch { /* siguiente intento */ }
    }
    return null;
  }

  return new Resolvedor({
    nombre: 'VOE',
    urlPrincipal: 'https://voe.sx',
    urlsAlias: [
      'jilliandescribecompany.com', 'mikaylaarealike.com',
      'christopheruntilpoint.com', 'walterprettytheir.com',
      'crystaltreatmenteast.com', 'lauradaydo.com',
      'lancewhosedifficult.com', 'dianaavoidthey.com',
      'jefferycontrolmodel.com', 'charlestoughrace.com',
      'richardquestionbuilding.com', 'jessicayeahcatch.com',
      'juliewomanwish.com', 'rebeccapracticeloss.com',
      'johnbeyondnation.com', 'jamesbornmain.com',
      'goofy-banana.com'
    ],
    resuelve: async (link) => {
      const url = new URL(link);
      let html;
      try {
        html = await fetcher.getText(link);
      } catch (error) {
        // Un fallo de red no es "sin medios": se informa con su causa real.
        emitir({ stage: 'resolver-failed', host: url.hostname, error: error.message });
        return [];
      }
      // Voe sirve en algunos mirrors un redirector JS ("Redirecting...") hacia
      // su dominio estable con la misma ruta. Se sigue una vez, solo hacia los
      // mirrors ya declarados en este resolvedor.
      const esRedirector = /Redirecting|Redirigiendo/i.test(html.slice(0, 2000));
      if (esRedirector) {
        const siguiente = await seguirRedirector({
          fetcher, html, link, alias: [url.hostname, ...MIRRORS_VOE], emitir
        });
        if (siguiente) html = siguiente;
      }
      // Un interstitial mínimo del player no se resuelve sin su JS: se informa
      // en vez de devolver vacío sin explicación.
      if (esInterstitial(html)) {
        eventoSinMedia({ link, html, capas: 1, candidatos: 0, emitir });
        return [];
      }
      const cifrado = encontrarCifrado(html);
      const urls = [];
      const agregarFuente = (fuente) => {
        // El payload apunta a veces a /hls/master.txt o a un master sin
        // extensión: se prueban las variantes habituales del mismo recurso.
        urls.push(fuente);
        urls.push(fuente.replace(/\.txt$/i, '.m3u8'));
        urls.push(fuente.replace(/\/hls\/[^/]*$/, '/hls/master.m3u8'));
        urls.push(fuente.replace(/\/hls\/[^/]*$/, '/hls/master.txt'));
      };
      if (cifrado) {
        if (cifrado.yaDescifrado) {
          agregarFuente(cifrado.payload);
        } else {
          const descifrado = descifrar(cifrado.payload);
          emitir({ stage: 'voe', host: url.hostname, descifrado: Boolean(descifrado) });
          if (descifrado) agregarFuente(descifrado.fuente);
        }
      }
      const streams = await verificarCandidatos(fetcher, 'VOE', urls);
      if (streams.length) return streams;
      // Barrido literal como respaldo.
      const { media } = fetcher.parsePage(html, link);
      const respaldo = await verificarCandidatos(fetcher, 'VOE', media.slice(0, 10));
      if (!respaldo.length) eventoSinMedia({ link, html, capas: 1, candidatos: urls.length + media.length, emitir });
      return respaldo;
    }
  });
}

module.exports = { crearResolvedorVoe, VOE_KEY_POR_DEFECTO, VOE_IV_POR_DEFECTO, MIRRORS_VOE };
