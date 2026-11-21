const { Resolvedor, verificarCandidatos } = require('./base');
const { unPackerTodo } = require('./packer');

// Resolvedor para los players que esconden la fuente con P.A.C.K.E.R.
// (Streamwish, Vidhide, Filemoon, Uqload, Doodstream...). FlixLatam sirve sus
// servidores desde Embed69 con estos players, así que sin descomprimir el
// bloque `eval(function(p,a,c,k,e,d)` no aparece ningún .m3u8/.mp4.
//
// Se desempaqueta por texto (no se ejecuta JS) y se buscan candidatos tanto en
// el HTML original como en cada capa desempaquetada.

// Dominios observados en los enlaces de Embed69 (incluye los "rotados").
const SERVIDORES = {
  streamwish: {
    nombre: 'Streamwish',
    dominios: ['streamwish.to', 'streamwish.com', 'streamwish.site', 'hglink.to', 'swdyu.com',
      'cybervynx.com', 'dumbalag.com', 'sfastwish.com', 'wishembed.pro', 'embedwish.com',
      'awish.pro', 'strwish.com', 'swhoi.com']
  },
  vidhide: {
    nombre: 'Vidhide',
    dominios: ['vidhide.com', 'vidhidepro.com', 'vidhidevip.com', 'morencius.com', 'minochinos.com',
      'mivalyo.com', 'dinisglows.com', 'dhtpre.com', 'vidhide.fun', 'vidhideplus.com']
  },
  filemoon: {
    nombre: 'Filemoon',
    dominios: ['filemoon.sx', 'filemoon.to', 'filemoon.in', 'filemoon.link', 'filemoon.nl']
  },
  uqload: {
    nombre: 'Uqload',
    dominios: ['uqload.com', 'uqload.vc', 'uqload.co', 'uqload.to', 'uqload.su', 'uqload.io', 'uqload.cx']
  },
  doodstream: {
    nombre: 'Doodstream',
    dominios: ['doodstream.com', 'dood.watch', 'dood.to', 'dood.so', 'dood.cx', 'dood.la', 'dood.pm',
      'dood.ws', 'do7go.com', 'd0000d.com', 'd000d.com']
  },
  lulustream: {
    nombre: 'Lulustream',
    dominios: ['lulustream.com', 'lulu.st']
  },
  watchsb: {
    nombre: 'WatchSB',
    dominios: ['watchsb.com', 'sblona.com']
  }
};

function crearResolvedorPacked({ nombre, dominios, allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent } = {}) {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const { createFetcher } = require('./fetcher');
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });

  return new Resolvedor({
    nombre,
    urlPrincipal: `https://${dominios[0]}`,
    urlsAlias: dominios.slice(1),
    resuelve: async (link) => {
      // Los players rotan de dominio y responden 302 al dominio estable.
      const html = await fetcher.getText(link, {}, { seguirMismoMotor: true });
      // Todas las capas: HTML original + cada bloque P.A.C.K.E.R desempaquetado.
      const capas = unPackerTodo(html);
      emitir({ stage: 'packer', host: new URL(link).hostname, capas: capas.length });

      // El enlace directo al media gana (algunos players lo dejan en claro).
      const candidatos = [];
      for (const capa of capas) {
        const { media } = fetcher.parsePage(capa, link);
        for (const url of media) if (!candidatos.includes(url)) candidatos.push(url);
        // Cadenas tipo file:"...", source:"...", "hls": "..." y las variantes
        // sin comillas (file: "..." con espacio). El valor debe parecer una URL
        // absoluta o relativa: si no, es un JSON ajeno (p. ej. el dataLink de
        // Embed69) y se descarta.
        for (const match of capa.matchAll(/["']?(?:file|source|src|hls|video_?url|stream_?url)["']?\s*:\s*["']([^"'<>\s]+)["']/gi)) {
          const url = match[1].replace(/\\\//g, '/');
          if (/^(?:https?:)?\/\//i.test(url) || url.startsWith('/')) {
            if (!candidatos.includes(url)) candidatos.push(url);
          }
        }
      }
      const streams = await verificarCandidatos(fetcher, nombre, candidatos.slice(0, 10));
      if (streams.length) return streams;

      // Sin candidato verificado no se entrega el embed: no es reproducible.
      // Se informa qué se encontró (sin volcar el HTML: lleva enlaces firmados).
      emitir({
        stage: 'sin-media', host: new URL(link).hostname, capasPacker: capas.length,
        candidatos: candidatos.length, bytes: html.length,
        packer: /eval\(function\s*\(p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e/.test(html),
        bloqueado: /403 forbidden|access denied|not found|deleted|removed/i.test(html.slice(0, 4000)),
        jwplayer: /jwplayer|jwp-config|sources\s*:\s*\[/i.test(html),
        // Título de la página (texto suyo, no enlaces) para saber qué sirvió.
        titulo: (/<title[^>]*>([^<]{0,80})<\/title>/i.exec(html) || [, ''])[1].trim(),
        // Páginas que solo funcionan con JS o que piden verificación.
        soloJs: /enable javascript|please enable js|noscript|recaptcha|turnstile|hcaptcha/i.test(html.slice(0, 4000)),
        sinCuerpo: html.trim().length < 32
      });
      return [];
    }
  });
}

// Crea todos los resolvedores P.A.C.K.E.R. del catálogo.
function crearResolvedoresPacked(config = {}) {
  return Object.entries(SERVIDORES).map(([clave, datos]) => {
    const { nombre, dominios } = datos;
    return crearResolvedorPacked({ ...config, nombre, dominios });
  });
}

module.exports = { crearResolvedorPacked, crearResolvedoresPacked, SERVIDORES };
