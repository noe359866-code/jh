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
// Versión publicable de una página diminuta: se eliminan URLs, rutas, tokens
// largos y valores de atributos; quedan etiquetas, nombres de atributo y texto.
// Versión publicable de una página diminuta: se conserva la ESTRUCTURA
// (etiquetas y texto visible) y se descartan todos los atributos, que es donde
// viven los enlaces, tokens y valores CSRF. Así el reporte explica qué
// interpone el player sin poder filtrar nada.
function cuerpoRedactado(html, maximo = 1200) {
  const texto = String(html).slice(0, maximo * 4);
  const etiquetas = [];
  for (const encontrado of texto.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)) etiquetas.push(encontrado[1].toLowerCase());
  const visible = texto
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximo);
  const resumen = etiquetas.slice(0, 30).join(' ');
  return `etiquetas: ${resumen} | texto: ${visible}`.slice(0, maximo);
}

// ---------------------------------------------------------------------------
// Loader en JavaScript: leerlo, no ejecutarlo
// ---------------------------------------------------------------------------
//
// Varios players (Streamwish entre ellos) sirven un spinner de ~800 B con
// `<script src="/main.js">`. El JS hace una petición a una API del mismo host
// que devuelve la fuente. Ese JS se puede LEER: de él se sacan las rutas de la
// API y sus parámetros, y se prueban sin ejecutar nada del sitio.
//
// Devuelve las rutas candidatas (sin ejecutar) y marca las que parecen API.
// Rutas citadas en el JS. Cubre las tres formas habituales: absolutas
// ("/api/x"), relativas ("api/x") y plantillas (`/api/${id}`).
// Grupo 1: camino; grupo 2: query (con valores, que es lo que hace la llamada).
const RUTA_EN_JS = /["'`]((?:https?:\/\/[^"'`\s?#]+|\/?[A-Za-z0-9_\-][A-Za-z0-9_\-./]{1,80}))(\?[^"'`\s]{0,160})?["'`]/g;
const API_SOSPECHOSA = /(?:\bapi\b|\bdl\b|embed|source|stream|video|\bget\b|\bplay\b|media|\bfile\b|link|url|\bop\b|download|mp4|m3u8|ajax|fetch)/i;

function rutasDeLoader(js) {
  const rutas = new Set();
  for (const encontrado of String(js).matchAll(RUTA_EN_JS)) {
    const camino = encontrado[1];
    const consulta = encontrado[2] || '';
    // Se descarta lo que es claramente un recurso estático del player.
    if (/\.(?:css|png|jpe?g|svg|ico|woff2?|ttf|map|js)$/i.test(camino)) continue;
    if (/^[A-Za-z_$][\w$]*$/.test(camino) && !API_SOSPECHOSA.test(camino)) continue;
    const ruta = camino.startsWith('/') || /^https?:/i.test(camino) ? camino : `/${camino}`;
    rutas.add(`${ruta}${consulta}`);
    if (rutas.size >= 40) break;
  }
  return [...rutas];
}

// Detecta un loader ofuscado (javascript-obfuscator y similares): cadenas en un
// array rotado con `push`/`shift` y nombres tipo `_0x1a2b`. Ese código solo se
// descifra ejecutándolo, cosa que este proyecto no hace por diseño: se informa
// y no se pierde tiempo probando rutas inventadas.
function loaderOfuscado(js) {
  const texto = String(js);
  if (texto.length < 2000) return false;
  const arrayRotado = /\.push\(\s*(?:[\w$]+\s*,\s*)+\)|\[\s*'(?:[^'\\]|\\.){200,}'/.test(texto);
  const nombresHex = (texto.match(/_0x[0-9a-f]{3,}/gi) || []).length;
  const rotacion = /\bshift\(\)/.test(texto) && /\.push\(/.test(texto);
  const sinMecanismosLegibles = !/\bfetch\s*\(|XMLHttpRequest/.test(texto);
  return (arrayRotado && (rotacion || nombresHex > 20)) || nombresHex > 200 || (sinMecanismosLegibles && rotacion);
}

// Forma publicable del loader: qué mecanismos usa y literales sin valores. Es
// lo que permite ajustar la lectura sin volcar el JS del sitio.
function formaLoader(js) {
  const texto = String(js);
  const literales = [];
  for (const m of texto.matchAll(RUTA_EN_JS)) {
    if (literales.length >= 8) break;
    const valor = rutaRedactada(m[1]);
    if (!literales.includes(valor)) literales.push(valor);
  }
  return {
    bytes: texto.length,
    fetch: /\bfetch\s*\(/.test(texto),
    xhr: /XMLHttpRequest|\$\.ajax|axios/.test(texto),
    atob: /\batob\s*\(/.test(texto),
    b64: /base64/i.test(texto),
    eval: /\beval\s*\(/.test(texto),
    sha: /sha-?256|crypto\.subtle|md5/i.test(texto),
    literales
  };
}

// Copia publicable de una ruta de API: sin valores de parámetros (llevan
// tokens) y con los nombres de los parámetros, que es lo que hace falta para
// reconstruir la llamada.
function rutaRedactada(ruta) {
  const [camino, consulta] = String(ruta).split('?');
  if (!consulta) return camino;
  const nombres = consulta.split('&').map(par => par.split('=')[0]).filter(Boolean);
  return `${camino}?${nombres.join('&')}`;
}

function formaPagina(html) {
  const texto = String(html);
  const hosts = (listas) => listas.map(u => { try { return new URL(u).hostname; } catch { return '-'; } });
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
  if (texto.length > 4000) return false;
  if (/eval\(function\s*\(p\s*,\s*a\s*,\s*c/i.test(texto)) return false;
  if (/\.m3u8|\.mp4|\/embed\/|jwplayer|playerjs/i.test(texto)) return false;
  if (/<video|<source/i.test(texto)) return false;
  // Un payload de player (base64, incluso corto) no es un spinner: Voe sirve
  // su JSON cifrado en una página diminuta.
  if (/[A-Za-z0-9+/=]{32,}/.test(texto)) return false;
  // JSON de player (claro o cifrado): lleva una fuente, un cifrado o una URL.
  if (/<script[^>]+type=["']application\/json["'][^>]*>\s*[{A-Za-z0-9+/=]/i.test(texto)) return false;
  if (/"(?:source|file|hls|url)"\s*:/i.test(texto)) return false;
  return /Loading|Cargando|Please wait|Espera/i.test(texto) || texto.length < 600;
}

// Detecta una verificación humana (captcha) servida como página del player:
// formulario POST con token CSRF, textos de "confirme que es humano", o los
// proveedores habituales (Turnstile/hCaptcha/reCAPTCHA). No se resuelve por
// diseño; se informa con precisión en vez de decir "sin medios".
function verificacionHumana(html) {
  const texto = String(html);
  const textoHumano = /confirme? que es humano|confirm you are human|verify (?:that )?you(?:'re| are) (?:a )?human|soy humano|no soy un robot|i'?m not a robot|verificaci[oó]n humana/i.test(texto);
  const proveedor = /turnstile|hcaptcha|recaptcha|cf-challenge|challenges\.cloudflare\.com/i.test(texto);
  const formulario = /<form[^>]+method=["']post["']/i.test(texto)
    && /name=["'](?:csrf|_token|token|access)["']/i.test(texto);
  if (!textoHumano && !proveedor && !formulario) return null;
  return {
    humano: true,
    proveedor: proveedor ? ((/turnstile/i.test(texto) && 'turnstile') || (/hcaptcha/i.test(texto) && 'hcaptcha')
      || (/recaptcha/i.test(texto) && 'recaptcha') || (/cf-challenge|challenges\.cloudflare/i.test(texto) && 'cloudflare')) : null,
    formulario: formulario,
    texto: textoHumano
  };
}

// Evento común de "esta página no dio media", con el contexto suficiente para
// diagnosticar sin volcar contenido (título, tamaño, P.A.C.K.E.R., bloqueo...).
function eventoSinMedia({ link, html, capas, candidatos, emitir }) {
  const texto = String(html || '');
  const humano = verificacionHumana(texto);
  if (humano) {
    // Verificación humana: se informa como tal. Este extractor no resuelve
    // captchas, así que el player se cierra aquí (no es un fallo oculto).
    emitir({
      stage: 'verificacion-humana', host: new URL(link).hostname,
      proveedor: humano.proveedor || undefined, formulario: humano.formulario,
      bytes: texto.length, titulo: (/<title[^>]*>([^<]{0,120})<\/title>/i.exec(texto) || [, ''])[1].trim()
    });
    return;
  }
  emitir({
    stage: 'sin-media', host: new URL(link).hostname,
    capasPacker: capas, candidatos: candidatos, bytes: texto.length,
    packer: /eval\(function\s*\(p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e/.test(texto),
    bloqueado: /403 forbidden|access denied|not found|deleted|removed/i.test(texto.slice(0, 4000)),
    jwplayer: /jwplayer|jwp-config|sources\s*:\s*\[/i.test(texto),
    titulo: (/<title[^>]*>([^<]{0,80})<\/title>/i.exec(texto) || [, ''])[1].trim(),
    soloJs: /enable javascript|please enable js|noscript|recaptcha|turnstile|hcaptcha/i.test(texto.slice(0, 4000)),
    sinCuerpo: texto.trim().length < 32,
    forma: formaPagina(texto),
    cuerpo: texto.length <= 4000 ? cuerpoRedactado(texto) : undefined
  });
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
      // El interstitial es JS suyo: se reintenta con espera corta (su JS tarda
      // unos cientos de ms en dejar la cookie) y se acepta la primera página
      // que ya traiga player o P.A.C.K.E.R.
      for (let intento = 1; intento <= 2 && esInterstitial(html); intento++) {
        emitir({ stage: 'reintento-interstitial', host: new URL(link).hostname, intento, bytes: html.length });
        await new Promise(r => setTimeout(r, 1200 * intento));
        const siguiente = await fetcher.getText(link, cabeceras, { seguirMismoMotor: true });
        if (siguiente.length > html.length) html = siguiente;
        else break;
      }
      // Si sigue siendo un spinner, se lee su loader (sin ejecutarlo) para
      // descubrir la API que devuelve la fuente. Solo scripts del mismo host.
      let api = null;
      if (esInterstitial(html)) {
        const origen = new URL(link).origin;
        const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
          .map(m => { try { return new URL(m[1], link).href; } catch { return null; } })
          .filter(Boolean)
          .filter(src => new URL(src).origin === origen)
          .slice(0, 3);
        const rutas = new Set();
        for (const src of scripts) {
          try {
            // El loader es del propio player: su Referer natural es su página.
            const js = await fetcher.getText(src, { Referer: link });
            const forma = formaLoader(js);
            const ofuscado = loaderOfuscado(js);
            emitir({ stage: 'loader-forma', host: new URL(link).hostname, ...forma, ofuscado });
            // Ofuscado: no hay rutas legibles y descifrarlo exige ejecutar el
            // JS del sitio. Se informa y se deja de probar rutas al azar.
            if (ofuscado) {
              emitir({ stage: 'loader-ofuscado', host: new URL(link).hostname, bytes: js.length });
              return [];
            }
            for (const ruta of rutasDeLoader(js)) rutas.add(ruta);
          } catch { /* loader inaccesible: se sigue con la página tal cual */ }
        }
        const candidatas = [...rutas].filter(ruta => API_SOSPECHOSA.test(ruta));
        emitir({
          stage: 'loader', host: new URL(link).hostname, scripts: scripts.length,
          rutas: [...rutas].slice(0, 12).map(rutaRedactada),
          api: candidatas.slice(0, 8).map(rutaRedactada)
        });
        // Se prueban las rutas de API con el propio enlace como referencia: si
        // alguna devuelve un media verificable, ese es el resultado.
        for (const ruta of candidatas.slice(0, 6)) {
          try {
            const cuerpo = await fetcher.getText(new URL(ruta, origen).href, cabeceras);
            const medios = [];
            for (const capa of unPackerTodo(cuerpo)) {
              const { media } = fetcher.parsePage(capa, new URL(ruta, origen).href);
              for (const url of media) if (!medios.includes(url)) medios.push(url);
              // JSON con la fuente en texto plano.
              for (const m of capa.matchAll(/"(?:file|source|src|url|hls)"\s*:\s*"([^"]*\.(?:m3u8|mp4)[^"]*)"/gi)) {
                const url = m[1].replace(/\\\//g, '/');
                if (!medios.includes(url)) medios.push(url);
              }
            }
            const verificados = await verificarCandidatos(fetcher, nombre, medios.slice(0, 6));
            if (verificados.length) {
              emitir({ stage: 'loader-api', host: new URL(link).hostname, total: verificados.length });
              return verificados;
            }
          } catch { /* ruta no válida para este player */ }
        }
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
      eventoSinMedia({ link, html, capas: capas.length, candidatos: candidatos.length, emitir });
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

module.exports = {
  crearResolvedorPacked, crearResolvedoresPacked, SERVIDORES,
  formaPagina, cuerpoRedactado, esInterstitial, rutasDeLoader, formaLoader, rutaRedactada,
  loaderOfuscado, eventoSinMedia, verificacionHumana
};
