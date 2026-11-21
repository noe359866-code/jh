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
      'mivalyo.com', 'dinisglows.com', 'dhtpre.com', 'vidhide.fun', 'vidhideplus.com',
      // Mirrors observados en redirecciones de vidhidepro.com (verificados por
      // resolución DNS; vidhidefast.com se descartó por no existir).
      'vidhidepre.com', 'vidhidehub.com']
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

// Describe la FORMA de una página que no tiene media, sin volcar contenido:
// solo nombres de etiquetas, nombres de campos y hosts. Sirve para saber qué
// interposición hay (formulario POST, redirección JS, meta refresh, loader).
function formaPagina(html) {
  const texto = String(html);
  const hosts = (listas) => listas.map(u => { try { return new URL(u).hostname; } catch { return '?'; } });
  const acciones = [...texto.matchAll(/<form[^>]*action=["']([^"']+)["']/gi)].map(m => m[1]);
  const campos = [...texto.matchAll(/<input[^>]*name=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 4);
  const scripts = [...texto.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 4);
  const saltos = [...texto.matchAll(/(?:location(?:\.href)?\s*=|window\.open\(|location\.replace\()\s*["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 3);
  return {
    form: /<form/i.test(texto), metodo: ((/<form[^>]*method=["'](\w+)["']/i.exec(texto) || [, ''])[1] || '').toLowerCase(),
    actions: hosts(acciones), campos,
    scripts: hosts(scripts),
    saltos: hosts(saltos),
    refresh: ((/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']([^"']+)["']/i.exec(texto) || [, ''])[1] || ''),
    carga: /document\.(?:forms\[0\]|getElementById\([^)]*\))\.submit\(|onload=|addEventListener\(["']load/i.test(texto),
    decodifica: /atob\(|fromCharCode|decodeURIComponent|unescape\(/i.test(texto),
    eval: /eval\(/i.test(texto),
    // Etiquetas presentes y textos de arranque típicos ("Loading..." + script
    // que navega). Sirve para distinguir un loader de una página vacía.
    etiquetas: [...new Set([...texto.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map(m => m[1].toLowerCase()))].slice(0, 10),
    claves: [...new Set([...texto.matchAll(/(?:^|[\s;,{])([a-zA-Z_$][\w$]*)\s*[=:(]/g)].map(m => m[1]))]
      .filter(k => !['var', 'let', 'const', 'function', 'if', 'for', 'window', 'document', 'return'].includes(k))
      .slice(0, 8)
  };
}

// Página mínima de espera: pocos bytes, título "Loading..." y sin player. Solo
// cuenta si NO hay ya un media o un bloque P.A.C.K.E.R. (una página real puede
// pesar poco: no se debe pedir dos veces una página que ya sirve).
function esInterstitial(html) {
  const texto = String(html);
  if (texto.length > 3000) return false;
  if (/eval\(function\s*\(p\s*,\s*a\s*,\s*c/i.test(texto)) return false;
  if (/\.m3u8|\.mp4|\/embed\//i.test(texto)) return false;
  return /Loading|Cargando|Please wait|Espera/i.test(texto) || texto.length < 400;
}

function crearResolvedorPacked({ nombre, dominios, allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent } = {}) {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const { createFetcher } = require('./fetcher');
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir });

  return new Resolvedor({
    nombre,
    urlPrincipal: `https://${dominios[0]}`,
    urlsAlias: dominios.slice(1),
    resuelve: async (link, ctx = {}) => {
      // Referer de la página que incrusta el player (Embed69): varios players
      // solo sirven el media si la petición viene de ahí.
      const cabeceras = ctx.pageReferer ? { Referer: ctx.pageReferer } : {};
      // Los players rotan de dominio y responden 302 al dominio estable.
      let html = await fetcher.getText(link, cabeceras, { seguirMismoMotor: true });
      // Varios players sirven primero un interstitial mínimo ("Loading...")
      // con una cookie; con esa cookie llega la página con la fuente.
      if (esInterstitial(html)) {
        emitir({ stage: 'reintento-interstitial', host: new URL(link).hostname, bytes: html.length });
        const segunda = await fetcher.getText(link, cabeceras, { seguirMismoMotor: true });
        if (segunda.length > html.length) html = segunda;
      }
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
        sinCuerpo: html.trim().length < 32,
        forma: formaPagina(html)
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
