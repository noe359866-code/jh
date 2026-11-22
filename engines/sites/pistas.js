// ---------------------------------------------------------------------------
// Pistas de reproductor en páginas que lo inyectan al pulsar
// ---------------------------------------------------------------------------
//
// Sitios como Gnula (WordPress con tema propio) no llevan el reproductor en el
// HTML: al pulsar "Reproducir" su JavaScript pide los enlaces y los inyecta.
// Lo que sí queda en el HTML es la infraestructura: el modal con los selectores
// de **Audio** (Latino/Subtitulado) y **Servidor** (1..4), iframes de players,
// enlaces a hosts de reproductor, atributos `data-*` y el endpoint de WordPress
// (`admin-ajax.php`) que usa el tema.
//
// Aquí se recoge todo eso SIN ejecutar JavaScript. Lo que no se pueda leer se
// informa como diagnóstico con la forma de la página (etiquetas, formularios,
// nombres de campos y hosts), nunca con el contenido.

// Hosts de reproductor que el registry sabe resolver (se comparan por sufijo).
const HOSTS_PLAYER = [
  'streamwish.to', 'streamwish.com', 'hglink.to', 'swdyu.com', 'cybervynx.com', 'dumbalag.com',
  'vidhide.com', 'vidhidepro.com', 'vidhidevip.com', 'morencius.com', 'minochinos.com',
  'mivalyo.com', 'dinisglows.com', 'dhtpre.com', 'vidhide.fun', 'vidhideplus.com',
  'filemoon.sx', 'filemoon.to', 'filemoon.in', 'filemoon.link', 'filemoon.nl',
  'uqload.com', 'uqload.vc', 'uqload.co', 'uqload.io', 'uqload.to',
  'voe.sx', 'streamtape.com', 'streamta.site', 'doodstream.com', 'dood.watch', 'dood.to',
  'dood.la', 'do7go.com', 'lulustream.com', 'lulu.st', 'watchsb.com', 'sblona.com',
  'vidsrc.to', 'vidsrc.net', 'vidsrc.icu', 'embed69.org', 'ok.ru', 'mixdrop.co'
];

const IDIOMAS = [
  [/latino|lat\b/i, 'Latino'],
  [/subtitulado|sub\b|caption/i, 'Subtitulado'],
  [/castellano|espa[ñn]ol/i, 'Español']
];

function idiomaDe(texto) {
  for (const [patron, nombre] of IDIOMAS) if (patron.test(String(texto))) return nombre;
  return '';
}

// Nombre legible de un host de player: streamwish.to -> Streamwish.
function nombreDePlayer(host) {
  const limpio = String(host).replace(/^www\./, '').split('.')[0];
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

function esHostPlayer(host) {
  const limpio = String(host).toLowerCase();
  return HOSTS_PLAYER.some(dominio => limpio === dominio || limpio.endsWith(`.${dominio}`));
}

// ---------------------------------------------------------------------------
// Búsqueda de pistas
// ---------------------------------------------------------------------------

// Devuelve { pistas, idiomas, servidores } con lo legible en la página.
function buscarPistasReproductor(html, base) {
  const texto = String(html);
  const pistas = [];
  const vistos = new Set();

  const agregar = (raw, { idioma = '', nombre = '', referer = '' } = {}) => {
    if (!raw) return;
    let url;
    try { url = new URL(String(raw).replace(/\\\//g, '/'), base); } catch { return; }
    if (!/^https?:$/i.test(url.protocol)) return;
    if (vistos.has(url.href)) return;
    vistos.add(url.href);
    const host = url.hostname.replace(/^www\./, '');
    const servidor = nombre || nombreDePlayer(host);
    pistas.push({
      url: url.href,
      host,
      nombre: servidor,
      idioma,
      etiqueta: [idioma, servidor].filter(Boolean).join(' · ') || servidor,
      referer
    });
  };

  // 1) iframes y data-embed/data-src (algunos temas los dejan declarados).
  for (const match of texto.matchAll(/<iframe[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["']/gi)) {
    agregar(match[1]);
  }
  for (const match of texto.matchAll(/data-(?:embed|player|video|src|url)=["']([^"'<>]{8,})["']/gi)) {
    if (/^https?:\/\//i.test(match[1]) || /^\/\//.test(match[1])) agregar(match[1]);
  }

  // 2) Enlaces a hosts de reproductor conocidos (dentro de JSON o HTML).
  const patronJugadores = HOSTS_PLAYER.map(d => d.replace(/\./g, '\\.')).join('|');
  const patron = new RegExp(
    `(?:https?:)?(?:\\\\?/){2}(?:[a-z0-9-]+\\.)*(?:${patronJugadores})/[^"'\\\\s<>)]+`, 'gi'
  );
  for (const match of texto.matchAll(patron)) {
    agregar(match[0].replace(/^\/\//, 'https://'));
  }

  // 3) Endpoints del tema que devuelven los reproductores (se guardan como
  //    pista 'endpoint' para que el diagnóstico los muestre; resolverlos exige
  //    POST con nonce, que no se inventa).
  const endpoints = [];
  for (const match of texto.matchAll(/(?:["']((?:[a-z0-9_\-/]*\/)?admin-ajax\.php)["']|[?&]action=([a-z0-9_-]+))/gi)) {
    const valor = match[1] || `action=${match[2]}`;
    if (!endpoints.includes(valor)) endpoints.push(valor);
  }

  // 4) Idiomas y servidores declarados en el modal (texto visible).
  const idiomas = [];
  for (const match of texto.matchAll(/>\s*(Latino|Subtitulado|Castellano|Espa[ñn]ol)\s*</gi)) {
    const nombre = idiomaDe(match[1]);
    if (nombre && !idiomas.includes(nombre)) idiomas.push(nombre);
  }
  // Botones de servidor: "Servidor 1", "Servidor 2"...
  const servidores = [];
  for (const match of texto.matchAll(/Servidor\s*(\d{1,2})/gi)) {
    const numero = Number(match[1]);
    if (!servidores.includes(numero)) servidores.push(numero);
  }

  return { pistas, idiomas, servidores, endpoints };
}

// ---------------------------------------------------------------------------
// Diagnóstico: forma de la página, sin contenido
// ---------------------------------------------------------------------------

// Nombres de campo de formularios (sin valores) y hosts de scripts propios.
function diagnosticarPagina(html, base) {
  const texto = String(html);
  const propio = (() => { try { return new URL(base).hostname; } catch { return ''; } })();

  const etiquetas = [...new Set([...texto.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map(m => m[1].toLowerCase()))].slice(0, 14);
  const formularios = [...texto.matchAll(/<form[^>]*>/gi)].map(m => {
    const metodo = (/method=["'](\w+)["']/i.exec(m[0]) || [, ''])[1].toLowerCase() || 'get';
    const accion = (/action=["']([^"']+)["']/i.exec(m[0]) || [, ''])[1];
    let host = '';
    try { host = accion ? new URL(accion, base).hostname : propio; } catch { host = propio; }
    return `${metodo}→${host}`;
  }).slice(0, 4);
  const campos = [...new Set([...texto.matchAll(/<(?:input|select|button)[^>]*name=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 8);
  const scripts = [...new Set([...texto.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map(m => { try { return new URL(m[1], base).hostname; } catch { return ''; } })
    .filter(Boolean))].slice(0, 6);
  const endpoints = [...new Set([...texto.matchAll(/admin-ajax\.php|wp-json\/[a-z0-9_\-/]+/gi)].map(m => m[0]))].slice(0, 4);
  const ajaxActions = [...new Set([...texto.matchAll(/(?:action|ajax_action)["'\s:=]+["']([a-z0-9_-]{3,40})["']/gi)].map(m => m[1]))].slice(0, 8);
  const ids = [...new Set([...texto.matchAll(/\bid=["']([a-z0-9_-]{3,40})["']/gi)].map(m => m[1]))]
    .filter(id => /play|player|video|modal|server|audio|option/i.test(id)).slice(0, 10);

  return {
    bytes: texto.length, etiquetas, formularios, campos, scripts, endpoints,
    acciones: ajaxActions, ids, propio
  };
}

const hostsDeReproductor = HOSTS_PLAYER;

module.exports = {
  buscarPistasReproductor, diagnosticarPagina, idiomaDe, nombreDePlayer,
  esHostPlayer, hostsDeReproductor, HOSTS_PLAYER
};
