const { aesCbcDecryptIvIncluido, claveEmbed69, resolverAnubis } = require('../resolvers/crypto');
const { normalizarDominio } = require('../resolvers/base');

// ---------------------------------------------------------------------------
// Embed69: el reproductor que usa FlixLatam
// ---------------------------------------------------------------------------
//
// Protocolo (verificado contra la implementación de referencia de CloudStream):
//
//  1. La página del reproductor (`embed69.org/f/<id>`) trae `let dataLink = [...]`
//     en claro: un array JSON con los servidores agrupados por idioma.
//  2. Cada `link` va cifrado en AES-256-CBC; la clave es
//     SHA-256(LINK_CHALLENGE + LINK_SALT), ambos visibles en la misma página.
//  3. Los 16 primeros bytes del base64 son el IV y el resto el texto cifrado.
//  4. El sitio está tras Anubis (proof of work): si la página trae
//     `<script id="anubis_challenge">`, hay que resolver el reto y pedir
//     `/ .within.website/x/cmd/anubis/api/pass-challenge` para obtener cookies.
//
// Nada de esto ejecuta JavaScript del sitio: son regex, SHA-256 y AES.

const DATA_LINK = /let\s+dataLink\s*=\s*(\[[\s\S]*?\])\s*;/;
const CHALLENGE = /LINK_CHALLENGE\s*=\s*'([^']+)'/;
const SALT = /LINK_SALT\s*=\s*'([^']+)'/;
const ANUBIS = /<script[^>]*id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i;

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

// Extrae el reto de Anubis: { randomData, difficulty, id }.
function leerRetoAnubis(html) {
  const encontrado = ANUBIS.exec(String(html));
  if (!encontrado) return null;
  try {
    const raiz = JSON.parse(encontrado[1]);
    const reto = raiz.challenge || raiz;
    if (!reto || !reto.randomData) return null;
    return { randomData: String(reto.randomData), difficulty: Number(reto.difficulty) || 0, id: String(reto.id || '') };
  } catch { return null; }
}

// Descifra un enlace de dataLink. Devuelve null si el payload no es válido.
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
    // Pistas de bloqueo (sin volcar el HTML).
    captcha: /cf-challenge|just a moment|attention required/i.test(texto),
    bloqueado: /403 forbidden|access denied|blocked/i.test(texto)
  };
}

// Convierte el dataLink en claro en servidores descifrados.
function leerServidores(html) {
  const datos = DATA_LINK.exec(String(html));
  const challenge = CHALLENGE.exec(String(html));
  const salt = SALT.exec(String(html));
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

// URL absoluta del reproductor a partir del HTML de la ficha de FlixLatam.
function encontrarReproductor(html, base) {
  const texto = String(html);
  const patrones = [
    /<iframe[^>]+src=["']([^"']*(?:\/vidurl\/|embed69\.org\/f\/)[^"']*)["']/i,
    /["']((?:https?:)?\/\/(?:www\.)?embed69\.org\/f\/[^"']+)["']/i,
    /["']([^"']*\/vidurl\/[^"']+)["']/i
  ];
  for (const patron of patrones) {
    const encontrado = patron.exec(texto);
    if (!encontrado) continue;
    try { return new URL(encontrado[1].replace(/^\/\//, 'https://'), base).href; } catch { /* siguiente */ }
  }
  return null;
}

// Resuelve el PoW y hace la petición de pass-challenge. Devuelve las cookies
// resultantes o null si el sitio no lo pide o el reto es irresoluble.
async function pasarAnubis(fetcher, url, reto, { referer, cookies = {}, maxIntentos = 2_000_000 } = {}) {
  const inicio = Date.now();
  const solucion = resolverAnubis(reto.randomData, reto.difficulty, { maxIntentos });
  if (!solucion) return null;
  const transcurrido = Date.now() - inicio;
  const origen = new URL(url).origin;
  const destino = new URL(url);
  const redir = destino.pathname + (destino.search || '');
  const campos = {
    id: reto.id, response: solucion.hash, nonce: String(solucion.nonce),
    redir, elapsedTime: String(transcurrido)
  };
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const cabeceras = {
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(referer ? { Referer: referer } : {}),
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  // Anubis acepta GET con query y POST con formulario. Se prueban ambos y se
  // acepta también un 302 que traiga la cookie en lugar de una respuesta 200.
  const intentos = [
    { method: 'POST', body: new URLSearchParams(campos).toString(), url: `${origen}/.within.website/x/cmd/anubis/api/pass-challenge` },
    { method: 'GET', url: `${origen}/.within.website/x/cmd/anubis/api/pass-challenge?${new URLSearchParams(campos)}` }
  ];
  const recibidas = { ...cookies };
  for (const intento of intentos) {
    try {
      const respuesta = await fetcher.request(intento.url, cabeceras, {
        method: intento.method, body: intento.body, redirect: 'manual', permitirRedireccion: true
      });
      const nuevas = leerCookies(respuesta.headers.getSetCookie ? respuesta.headers.getSetCookie() : []);
      Object.assign(recibidas, nuevas);
      if (Object.keys(nuevas).length) return recibidas;
    } catch { /* siguiente método */ }
  }
  return null;
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

// Descarga la página del reproductor resolviendo Anubis si está activo.
async function abrirReproductor(fetcher, url, { referer, onEvent = () => {} } = {}) {
  const headers = referer ? { Referer: referer } : {};
  const respuesta = await fetcher.request(url, headers);
  let html = (await fetcher.readLimited(respuesta)).toString('utf8');
  const cookies = leerCookies(respuesta.headers.getSetCookie ? respuesta.headers.getSetCookie() : []);
  const reto = leerRetoAnubis(html);
  if (!reto) return html;
  onEvent({ stage: 'anubis', host: new URL(url).hostname, difficulty: reto.difficulty });
  const pasadas = await pasarAnubis(fetcher, url, reto, { referer, cookies });
  if (!pasadas) return html; // sin cookies: se devuelve lo que haya (lista vacía)
  const cabecera = Object.entries(pasadas).map(([k, v]) => `${k}=${v}`).join('; ');
  const segunda = await fetcher.request(url, { ...headers, Cookie: cabecera });
  html = (await fetcher.readLimited(segunda)).toString('utf8');
  return html;
}

module.exports = {
  leerServidores, encontrarReproductor, leerRetoAnubis, descifrarEnlace,
  normalizarDestino, abrirReproductor, leerCookies, diagnosticar, NOMBRES, ALIAS_DOMINIOS
};
