const { aesCbcDecryptIvIncluido, claveEmbed69, resolverAnubis } = require('../resolvers/crypto');
const { normalizarDominio } = require('../resolvers/base');

// ---------------------------------------------------------------------------
// Embed69: el reproductor que usa FlixLatam
// ---------------------------------------------------------------------------
//
// Protocolo (verificado contra la implementación de referencia de CloudStream
// y contra la documentación de Anubis):
//
//  1. La página del reproductor (`embed69.org/f/<id>`) trae `let dataLink = [...]`
//     en claro: un array JSON con los servidores agrupados por idioma.
//  2. Cada `link` va cifrado en AES-256-CBC; la clave es
//     SHA-256(LINK_CHALLENGE + LINK_SALT), ambos visibles en la misma página.
//  3. Los 16 primeros bytes del base64 son el IV y el resto el texto cifrado.
//  4. El sitio está tras Anubis (proof of work): si la página trae
//     `<script id="anubis_challenge">`, hay que resolver el reto y pedir
//     `/.within.website/x/cmd/anubis/api/pass-challenge` para obtener la cookie
//     `*-anubis-auth`. Ese reto está ligado al User-Agent y a la cookie de
//     verificación que emite la propia página del reto.
//
// Nada de esto ejecuta JavaScript del sitio: son regex, SHA-256 y AES.

const DATA_LINK = /let\s+dataLink\s*=\s*(\[[\s\S]*?\])\s*;/;
const CHALLENGE = /LINK_CHALLENGE\s*=\s*'([^']+)'/;
const SALT = /LINK_SALT\s*=\s*'([^']+)'/;
const ANUBIS = /<script[^>]*id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i;
const ANUBIS_PREFIX = /<script[^>]*id=["']anubis_base_prefix["'][^>]*>([\s\S]*?)<\/script>/i;
const ANUBIS_VERSION = /<script[^>]*id=["']anubis_version["'][^>]*>([\s\S]*?)<\/script>/i;

// Nombres legibles de los servidores de Embed69.
const NOMBRES = {
  voe: 'Voe', filemoon: 'Filemoon', doodstream: 'Doodstream', streamwish: 'Streamwish',
  vidhide: 'Vidhide', rapidvideo: 'Rapidvideo', uqload: 'Uqload', netu: 'Netu',
  streamtape: 'Streamtape', vidoza: 'Vidoza', mixdrop: 'Mixdrop', okru: 'Okru'
};

// Dominios rotados que Embed69 sirve y que los resolvedores conocen por su
// nombre estable. Se normaliza para que el registry elija el resolvedor.
const ALIAS_DOMINIOS = [
  ['morencius.com', 'vidhidepro.com'], ['minochinos.com', 'vidhidepro.com'],
  ['mivalyo.com', 'vidhidepro.com'], ['dinisglows.com', 'vidhidepro.com'],
  ['dhtpre.com', 'vidhidepro.com'], ['sblona.com', 'watchsb.com'],
  ['hglink.to', 'streamwish.to'], ['swdyu.com', 'streamwish.to'],
  ['cybervynx.com', 'streamwish.to'], ['dumbalag.com', 'streamwish.to'],
  ['filemoon.link', 'filemoon.sx'], ['lulu.st', 'lulustream.com'],
  ['uqload.io', 'uqload.com'], ['do7go.com', 'dood.la']
];

function normalizarDestino(url) {
  let salida = String(url).trim().replace(/`/g, '');
  for (const [rotado, estable] of ALIAS_DOMINIOS) {
    if (salida.startsWith(`https://${rotado}`)) {
      salida = salida.replace(`https://${rotado}`, `https://${estable}`);
      break;
    }
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Anubis
// ---------------------------------------------------------------------------

// Extrae el reto: la dificultad autoritativa está en `rules.difficulty`.
function leerRetoAnubis(html) {
  const texto = String(html);
  const encontrado = ANUBIS.exec(texto);
  if (!encontrado) return null;
  let raiz;
  try { raiz = JSON.parse(encontrado[1]); } catch { return null; }
  const reto = raiz.challenge || raiz;
  if (!reto || !reto.randomData) return null;

  let prefijo = '';
  const basePrefix = ANUBIS_PREFIX.exec(texto);
  if (basePrefix) {
    try {
      const valor = JSON.parse(basePrefix[1]);
      prefijo = typeof valor === 'string' ? valor : '';
    } catch {
      const simple = /"([^"]*)"/.exec(basePrefix[1]);
      prefijo = simple ? simple[1] : '';
    }
  }

  const reglas = raiz.rules || {};
  return {
    randomData: String(reto.randomData),
    difficulty: Number(reglas.difficulty ?? reto.difficulty) || 0,
    algorithm: String(reglas.algorithm || reto.method || 'fast').toLowerCase(),
    id: String(reto.id || ''),
    prefijo: prefijo.replace(/\/+$/, '')
  };
}

// Motivo de rechazo que devuelve Anubis, si lo hay. Es texto fijo suyo, nunca
// contenido del sitio protegido.
function mensajeAnubis(cuerpo, estado) {
  const texto = String(cuerpo);
  const conocido = /(invalid proof of work|challenge not found|invalid challenge|too fast|already solved|invalid response|invalid nonce|cookie (?:could not be|failed to be) verified|challenge (?:has )?expired)/i.exec(texto);
  if (conocido) return conocido[1].toLowerCase();
  if (ANUBIS.test(texto)) return 'sigue sirviendo el reto';
  return `http ${estado}`;
}

function leerCookies(cabeceras) {
  const cookies = {};
  for (const linea of cabeceras || []) {
    const par = String(linea).split(';')[0].trim();
    const pos = par.indexOf('=');
    if (pos > 0) cookies[par.slice(0, pos)] = par.slice(pos + 1);
  }
  return cookies;
}

function cabeceraCookies(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Resuelve el reto de Anubis y devuelve las cookies con acceso.
//
// - `fast`/`slow`: SHA-256 con `difficulty` nibbles a cero.
// - `metarefresh`: no hay PoW; basta con volver a pedir la página tras la espera.
// - `argon2id`/`preact`: no soportados sin dependencias nativas; se informa.
//
// La petición de pass-challenge se prueba en GET y POST, con `redir` como URL
// completa y como ruta, porque distintas versiones aceptan formas distintas.
// La cookie se acepta también cuando llega en un 302.
async function pasarAnubis(fetcher, url, reto, { referer, cookies = {}, onEvent = () => {}, maxIntentos = 3_000_000 } = {}) {
  const origen = new URL(url).origin;

  if (reto.algorithm === 'metarefresh') {
    onEvent({ stage: 'anubis', host: new URL(url).hostname, algorithm: 'metarefresh' });
    await new Promise(r => setTimeout(r, Math.max(500, reto.difficulty * 200)));
    return { ...cookies };
  }
  if (reto.algorithm !== 'fast' && reto.algorithm !== 'slow') {
    onEvent({ stage: 'anubis-no-soportado', host: new URL(url).hostname, algorithm: reto.algorithm });
    return null;
  }

  const inicio = Date.now();
  const solucion = resolverAnubis(reto.randomData, reto.difficulty, { maxIntentos });
  if (!solucion) {
    onEvent({ stage: 'anubis-agotado', host: new URL(url).hostname, difficulty: reto.difficulty });
    return null;
  }
  const transcurrido = Date.now() - inicio;
  onEvent({ stage: 'anubis', host: new URL(url).hostname, difficulty: reto.difficulty, algorithm: reto.algorithm, nonce: solucion.nonce, ms: transcurrido });

  // El servidor rechaza una respuesta enviada demasiado rápido: exige un tiempo
  // mínimo proporcional a la dificultad (~80 ms por nivel).
  const minimo = reto.difficulty * 80;
  if (transcurrido < minimo) await new Promise(r => setTimeout(r, minimo - transcurrido));

  const base = `${origen}${reto.prefijo || ''}/.within.website/x/cmd/anubis/api/pass-challenge`;
  const redirCompleto = url;
  const redirRuta = new URL(url).pathname + (new URL(url).search || '');
  const campos = { id: reto.id, response: solucion.hash, nonce: String(solucion.nonce), elapsedTime: String(Date.now() - inicio) };
  const cabeceras = {
    ...(cabeceraCookies(cookies) ? { Cookie: cabeceraCookies(cookies) } : {}),
    ...(referer ? { Referer: referer } : {}),
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const intentos = [];
  for (const redir of [redirCompleto, redirRuta]) {
    const consulta = new URLSearchParams({ ...campos, redir });
    intentos.push({ url: `${base}?${consulta}`, metodo: 'GET' });
    intentos.push({ url: base, metodo: 'POST', cuerpo: new URLSearchParams({ ...campos, redir }).toString() });
  }

  const recibidas = { ...cookies };
  for (const intento of intentos) {
    try {
      const respuesta = await fetcher.request(intento.url, cabeceras, {
        method: intento.metodo, body: intento.cuerpo, redirect: 'manual', permitirRedireccion: true
      });
      const nuevas = leerCookies(respuesta.headers.getSetCookie ? respuesta.headers.getSetCookie() : []);
      Object.assign(recibidas, nuevas);
      // Algunas versiones devuelven la página real en vez de una cookie.
      const cuerpo = (await fetcher.readLimited(respuesta)).toString('utf8');
      const auth = Object.keys(nuevas).some(k => k.includes('anubis-auth'));
      onEvent({
        stage: 'anubis-intento', host: new URL(url).hostname, metodo: intento.metodo,
        estado: respuesta.status, cookies: Object.keys(nuevas).length, auth,
        // Mensaje de rechazo de Anubis (texto corto, sin datos de la página).
        aviso: mensajeAnubis(cuerpo, respuesta.status)
      });
      if (DATA_LINK.test(cuerpo)) return { cookies: recibidas, html: cuerpo };
      if (auth) return { cookies: recibidas };
    } catch (error) {
      onEvent({ stage: 'anubis-intento', host: new URL(url).hostname, metodo: intento.metodo, error: String(error.message || error).slice(0, 120) });
    }
  }
  return null;
}

// Descarga la página del reproductor resolviendo Anubis si está activo.
// Devuelve { html, anubis, pasado }.
async function abrirReproductor(fetcher, url, { referer, onEvent = () => {} } = {}) {
  const baseHeaders = referer ? { Referer: referer } : {};
  let cookies = {};
  let html = '';
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    const cabecera = cabeceraCookies(cookies);
    const respuesta = await fetcher.request(url, { ...baseHeaders, ...(cabecera ? { Cookie: cabecera } : {}) });
    html = (await fetcher.readLimited(respuesta)).toString('utf8');
    Object.assign(cookies, leerCookies(respuesta.headers.getSetCookie ? respuesta.headers.getSetCookie() : []));

    const reto = leerRetoAnubis(html);
    if (!reto) return { html, anubis: vuelta > 0, pasado: true };
    if (vuelta === 1) return { html, anubis: true, pasado: false };

    const resultado = await pasarAnubis(fetcher, url, reto, { referer, cookies, onEvent });
    if (!resultado) return { html, anubis: true, pasado: false };
    cookies = resultado.cookies;
    if (resultado.html) return { html: resultado.html, anubis: true, pasado: true };
  }
  return { html, anubis: true, pasado: false };
}

// ---------------------------------------------------------------------------
// dataLink
// ---------------------------------------------------------------------------

function descifrarEnlace(cifrado, clave) {
  try {
    const texto = aesCbcDecryptIvIncluido(clave, cifrado);
    if (!texto) return null;
    const limpio = texto.replace(/`/g, '').trim();
    return /^https?:\/\//i.test(limpio) ? limpio : null;
  } catch { return null; }
}

// Diagnóstico: qué piezas del protocolo aparecen en la página. Solo booleanos,
// sin contenido (los payloads llevan enlaces firmados).
function diagnosticar(html) {
  const texto = String(html);
  return {
    dataLink: DATA_LINK.test(texto),
    challenge: CHALLENGE.test(texto),
    salt: SALT.test(texto),
    anubis: ANUBIS.test(texto),
    longitud: texto.length,
    captcha: /cf-challenge|just a moment|attention required/i.test(texto),
    bloqueado: /403 forbidden|access denied|blocked/i.test(texto)
  };
}

// Convierte el dataLink en claro en servidores descifrados.
function leerServidores(html) {
  const texto = String(html);
  const datos = DATA_LINK.exec(texto);
  const challenge = CHALLENGE.exec(texto);
  const salt = SALT.exec(texto);
  if (!datos || !challenge || !salt) return [];
  const clave = claveEmbed69(challenge[1], salt[1]);
  let lista;
  try { lista = JSON.parse(datos[1]); } catch { return []; }
  if (!Array.isArray(lista)) return [];

  const servidores = [];
  const vistos = new Set();
  for (const grupo of lista) {
    if (!grupo || typeof grupo !== 'object') continue;
    const idioma = String(grupo.video_language || 'LAT').toUpperCase();
    const embeds = Array.isArray(grupo.sortedEmbeds) ? grupo.sortedEmbeds : [];
    for (const servidor of embeds) {
      if (!servidor || typeof servidor.link !== 'string' || !servidor.link) continue;
      const descifrado = descifrarEnlace(servidor.link, clave);
      if (!descifrado) continue;
      const url = normalizarDestino(descifrado);
      if (!/^https?:\/\//i.test(url) || vistos.has(url)) continue;
      vistos.add(url);
      const bruto = String(servidor.servername || '').toLowerCase().replace(/[^a-z]/g, '');
      const nombre = NOMBRES[bruto] || (servidor.servername || 'Servidor');
      servidores.push({ idioma, servidor: nombre, url, etiqueta: `${idioma} · ${nombre}` });
    }
  }
  return servidores;
}

// URLs de reproductor a partir del HTML de la ficha de FlixLatam.
//
// La ficha publica VARIOS reproductores (Embed69 y otros como Uqload): antes se
// usaba solo el primero, así que si ese fallaba se perdía el resto.
function encontrarReproductores(html, base) {
  const texto = String(html);
  const patrones = [
    /<iframe[^>]+src=["']([^"']*(?:\/vidurl\/|embed69\.org\/f\/)[^"']*)["']/gi,
    /["']((?:https?:)?\/\/(?:www\.)?embed69\.org\/f\/[^"']+)["']/gi,
    /["']([^"']*\/vidurl\/[^"']+)["']/gi
  ];
  const urls = [];
  for (const patron of patrones) {
    for (const encontrado of texto.matchAll(patron)) {
      try {
        const url = new URL(encontrado[1].replace(/^\/\//, 'https://'), base).href;
        if (!urls.includes(url)) urls.push(url);
      } catch { /* siguiente */ }
    }
  }
  return urls;
}

// Enlaces a players externos que la ficha publica como enlaces (no iframe):
// `uqload.vc/embed-xxx.html`, `streamwish.to/e/xxx`, etc.
const DOMINIOS_PLAYER = [
  'uqload.vc', 'uqload.com', 'uqload.co', 'uqload.io', 'streamwish.to', 'hglink.to',
  'vidhide.com', 'vidhidepro.com', 'filemoon.sx', 'filemoon.to', 'dood.la', 'do7go.com',
  'voe.sx', 'lulustream.com', 'lulu.st', 'watchsb.com', 'sblona.com', 'streamtape.com'
];

function encontrarEmbeds(html, base) {
  const texto = String(html);
  const urls = [];
  const patron = new RegExp(
    `["'](https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:${DOMINIOS_PLAYER.map(d => d.replace(/\./g, '\\.')).join('|')})\\/[^"'\\s<>]+)["']`,
    'gi'
  );
  for (const encontrado of texto.matchAll(patron)) {
    const url = encontrado[1].replace(/\\\//g, '/');
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Primer reproductor (compatibilidad con el flujo anterior).
function encontrarReproductor(html, base) {
  return encontrarReproductores(html, base)[0] || null;
}

module.exports = {
  leerServidores, encontrarReproductor, leerRetoAnubis, descifrarEnlace,
  normalizarDestino, abrirReproductor, pasarAnubis, leerCookies, diagnosticar,
  encontrarReproductores, encontrarEmbeds, NOMBRES, ALIAS_DOMINIOS, normalizarDominio
};
