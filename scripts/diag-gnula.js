// Descubrimiento del flujo de Gnula, solo estructura (no publica enlaces).
//
// La ficha de Gnula no lleva el reproductor en el HTML, pero declara su propia
// API REST de WordPress: /wp-json/gnrd/v1/{player,vivo,rpmdec}. Este script
// lee la definición pública de esas rutas (/wp-json/) y el código que las
// llama para saber QUÉ parámetros aceptan, sin ejecutar nada del sitio.
//
// Nada de lo que imprime sirve para reproducir: sustituye literales de cadena,
// tokens y valores largos, y solo deja nombres de ruta, métodos, nombres de
// parámetro y atributos data-* del modal.
const { createFetcher } = require('../engines/sites/extractor');
const { hostsPermitidos } = require('../engines/sites');

const BASE = 'https://ww3.gnulahd.nu';
const FICHA = `${BASE}/ver/godzilla-minus-zero/`;

// Forma de una cadena: se conserva la puntuación y cada letra/dígito pasa a x.
// Sirve para ver la estructura de una URL sin publicar sus valores.
function formaCadena(cadena) {
  return String(cadena).replace(/[A-Za-z0-9]/g, 'x');
}

// Redacción: fuera literales de cadena, tokens y valores largos.
function redactar(fragmento) {
  return String(fragmento)
    .replace(/"(?:[^"\\]|\\.)*"/g, '"<s>"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'<s>'")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '<tok>')
    .replace(/\s+/g, ' ');
}

async function principal() {
  const fetcher = createFetcher({
    allowedHosts: [...hostsPermitidos({}), 'www.youtube-nocookie.com'],
    maxBytes: 4 * 1024 * 1024
  });

  // 1) Definición pública de las rutas: nombres de argumento y métodos.
  for (const ruta of ['/wp-json/', '/wp-json/gnrd/v1']) {
    try {
      const texto = await fetcher.getText(`${BASE}${ruta}`);
      const json = JSON.parse(texto);
      const rutas = json.routes || json.namespaces || json;
      console.log(`--- ${ruta} ---`);
      for (const [nombre, def] of Object.entries(rutas)) {
        if (!/gnrd|player|vivo|rpmdec/i.test(nombre)) continue;
        const metodos = def.endpoints ? def.endpoints.map(e => (e.methods || []).join('+')) : [];
        const args = def.endpoints
          ? [...new Set(def.endpoints.flatMap(e => Object.keys(e.args || {})))].sort()
          : [];
        const requeridos = def.endpoints
          ? [...new Set(def.endpoints.flatMap(e => Object.entries(e.args || {})
            .filter(([, v]) => v && v.required).map(([k]) => k)))].sort()
          : [];
        console.log(`ruta=${nombre} metodos=${metodos.join(',')} args=[${args.join(',')}] requeridos=[${requeridos.join(',')}]`);
      }
    } catch (error) {
      console.log(`--- ${ruta} --- no disponible: ${error.message}`);
    }
  }

  // 2) Cómo llama el tema a esas rutas: nombre de parámetro que se concatena
  //    al endpoint (los valores se redactan).
  const html = await fetcher.getText(FICHA);
  console.log(`--- ficha --- bytes=${html.length}`);
  for (const match of html.matchAll(/gnrd\/v1\/(?:player|vivo|rpmdec)/g)) {
    const desde = Math.max(0, match.index - 160);
    const hasta = Math.min(html.length, match.index + 200);
    console.log(`llamada: ${redactar(html.slice(desde, hasta))}`);
  }
  // Nombres de parámetro que se concatenan tras el endpoint (?post=, &audio=...).
  const parametros = new Set();
  for (const match of html.matchAll(/gnrd\/v1\/(?:player|vivo|rpmdec)[^"'`]{0,240}/g)) {
    for (const parametro of match[0].matchAll(/[?&]([a-z0-9_-]{2,20})=/gi)) parametros.add(parametro[1]);
  }
  console.log(`parametros-detectados=[${[...parametros].sort().join(',')}]`);

  // 3) Atributos data-* del modal del player (nombres y valores numéricos).
  for (const match of html.matchAll(/<[a-z]+[^>]*id=["']gnrd-(?:player-modal|dlmodal)["'][^>]*>|<[^>]*data-(?:post|video|audio|server|tipo)[\w-]*=[^>]*>/gi)) {
    const etiqueta = match[0];
    const id = (/id=["']([^"']+)["']/.exec(etiqueta) || [, ''])[1];
    const datos = [...etiqueta.matchAll(/data-([\w-]+)=["']([^"']*)["']/g)]
      .map(([, clave, valor]) => `${clave}=${/^\d{1,8}$/.test(valor) ? valor : '<s>'}`);
    if (id || datos.length) console.log(`elemento id=${id || '-'} data=[${datos.join(' ')}]`);
  }

  // 4) Sondeo de la ruta player con los parámetros detectados: solo estado y
  //    nombres de las claves de la respuesta.
  const idPost = (/data-post=["'](\d+)/.exec(html) || [])[1];
  const idVideo = (/data-video-id=["']([\w-]+)/.exec(html) || [])[1];
  const sondeos = [
    `player?post=${idPost || ''}`,
    `player?post=${idPost || ''}&audio=lat&server=1`,
    `player?video=${idVideo || ''}&server=1`
  ];
  for (const sondeo of sondeos) {
    try {
      const texto = await fetcher.getText(`${BASE}/wp-json/gnrd/v1/${sondeo}`, {
        Accept: 'application/json', Referer: FICHA
      });
      const json = JSON.parse(texto);
      const claves = Array.isArray(json) ? `array(${json.length})` : Object.keys(json).sort().join(',');
      console.log(`sondeo ${sondeo.replace(/\d+/g, '<n>')} -> ok claves=[${claves}]`);
    } catch (error) {
      console.log(`sondeo ${sondeo.replace(/\d+/g, '<n>')} -> ${error.message.slice(0, 120)}`);
    }
  }
}

const fase = (process.argv[2] || 'todo');
// Orden pensado para que lo imprescindible quede al principio de la salida.
const ejecutar = fase === 'unpack' ? faseUnpack
  : fase === 'rutas' ? principal
    : fase === 'vars' ? faseVariables
      : async () => { await faseVariables(); await faseUnpack(); await principal(); };

ejecutar().catch(error => {
  console.error(`diagnóstico falló: ${error.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Fase 2: el decodificador del player (gnrdUnpack) y la forma del payload
// ---------------------------------------------------------------------------
// El cliente hace `fetch(ruta + _gnrdPid + '?tok=' + _gnrdTok)` y pasa la
// respuesta por `gnrdUnpack(...)`. Para replicarlo sin ejecutar JavaScript hace
// falta (a) el código del decodificador y (b) la forma del payload. Aquí se
// imprime el código con literales redactados y del payload solo su longitud y
// alfabeto: nunca su contenido.
async function faseUnpack() {
  const fetcher = createFetcher({ allowedHosts: [...hostsPermitidos({})], maxBytes: 4 * 1024 * 1024 });
  const html = await fetcher.getText(FICHA);

  // El id va sin comillas (var _gnrdPid=520864) y el token entrecomillado.
  const valor = (nombre) => {
    // El token se declara tras una coma (var _gnrdPid=520864,_gnrdTok="...").
    const m = new RegExp(`\\b${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\d+))`).exec(html);
    if (!m) return null;
    const v = m[1] ?? m[2] ?? m[3];
    return { valor: v, largo: v.length };
  };
  const pid = valor('_gnrdPid');
  const tok = valor('_gnrdTok');
  console.log(`pid=${pid ? `largo=${pid.largo} forma=${/^\d+$/.test(pid.valor) ? 'numerico' : /^[a-z0-9]+$/i.test(pid.valor) ? 'alfanum' : 'otro'}` : 'no encontrado'}`);
  console.log(`tok=${tok ? `largo=${tok.largo}` : 'no encontrado'}`);

  // Cuerpo de gnrdUnpack: se equilibran llaves para cortar la función entera.
  const inicio = html.search(/function\s+gnrdUnpack\s*\(/);
  if (inicio === -1) {
    console.log('gnrdUnpack: no encontrado en la ficha');
  } else {
    let i = html.indexOf('{', inicio);
    let nivel = 0;
    for (; i < html.length; i++) {
      if (html[i] === '{') nivel++;
      else if (html[i] === '}' && --nivel === 0) break;
    }
    const cuerpo = html.slice(inicio, i + 1);
    console.log(`--- gnrdUnpack (${cuerpo.length} B, literales redactados) ---`);
    console.log(redactar(cuerpo).slice(0, 3000));
  }

  if (!pid || !tok) return;
  // La URL se arma en el tema con dos literales alrededor del id. Se usan esos
  // literales tal cual (en vez de adivinar la ruta) y se muestra solo su forma.
  const llamada = /fetch\((['"])([^'"]*)\1\s*\+\s*_gnrdPid\s*\+\s*(['"])([^'"]*)\3/.exec(html);
  if (!llamada) {
    console.log('url del player: no se encontró la construcción en el tema');
    return;
  }
  const [prefijo, sufijo] = [llamada[2], llamada[4]];
  console.log(`url-forma: ${formaCadena(prefijo)} + <pid> + ${formaCadena(sufijo)} + <tok>`);
  // Nombre del parámetro del token (una letra): se informa, nunca su valor.
  console.log(`parametro-token=${(sufijo.match(/[?&]([a-z0-9_-]{1,12})=$/i) || [, '?'])[1]}`);
  const url = new URL(`${prefijo}${pid.valor}${sufijo}${encodeURIComponent(tok.valor)}`, FICHA).href;
  try {
    const texto = await fetcher.getText(url, { Accept: 'application/json', Referer: FICHA, 'X-Requested-With': 'XMLHttpRequest' });
    let json;
    try { json = JSON.parse(texto); } catch { json = null; }
    console.log(`player: bytes=${texto.length} json=${json ? 'si' : 'no'}${json ? ` claves=[${Object.keys(json).sort().join(',')}]` : ''}`);
    if (json && typeof json.p === 'string') {
      const p = json.p;
      const clases = {
        base64: /^[A-Za-z0-9+/=]+$/.test(p),
        hex: /^[0-9a-f]+$/i.test(p),
        numeros: /^[0-9,;|]+$/.test(p),
        conSeparadores: /[|:;,~]/.test(p),
        conLlaves: /[{}[\]]/.test(p)
      };
      console.log(`p: largo=${p.length} ${JSON.stringify(clases)}`);
      // El decodificador observado en el tema: base64 + XOR con clave de 4 B,
      // luego JSON. Se aplica en memoria y solo se informa la forma, no los
      // enlaces (el reporte no debe publicar URLs de media).
      const CLAVE = [103, 78, 55, 100];
      const crudo = Buffer.from(p, 'base64');
      const claro = Buffer.from(crudo.map((b, i) => b ^ CLAVE[i & 3])).toString('utf8');
      let datos;
      try { datos = JSON.parse(claro); } catch { datos = null; }
      console.log(`p decodificado: json=${datos ? 'si' : 'no'} bytes=${claro.length}`);
      if (datos) {
        const forma = (v, nivel = 0) => {
          if (Array.isArray(v)) return `[${v.length}x ${v.length ? forma(v[0], nivel + 1) : ''}]`;
          if (v && typeof v === 'object') {
            return `{${Object.keys(v).map(k => `${k}:${forma(v[k], nivel + 1)}`).join(', ')}}`;
          }
          if (typeof v === 'string') {
            // Un enlace: solo esquema y host (nunca la ruta ni la query).
            try { const u = new URL(v); return `url(${u.protocol}//${u.hostname})`; } catch { return `str(${v.length})`; }
          }
          return typeof v;
        };
        console.log(`forma: ${forma(datos).slice(0, 2500)}`);
        // Detalle útil para el proveedor: idiomas, servidores y hosts (nunca
        // la ruta ni la query de cada servidor).
        const host = (v) => { try { return new URL(v).hostname.replace(/^www\./, ''); } catch { return '?'; } };
        for (const lang of datos.langs || []) {
          const servidores = (lang.servers || []).map(sv => `${sv.title || '?'}→${host(sv.src)}`);
          console.log(`lang label=${JSON.stringify(lang.label)} flag=${JSON.stringify(lang.flag)} servidores=[${servidores.join(', ')}]`);
        }
        // Forma del enlace de cada servidor (esquema, host y si lleva código),
        // para saber si hace falta transformarlo antes de resolverlo.
        for (const lang of datos.langs || []) {
          for (const sv of lang.servers || []) {
            let descripcion = '?';
            try {
              const u = new URL(sv.src);
              const partes = u.pathname.split('/').filter(Boolean);
              descripcion = `${u.protocol}//${u.hostname} partes=${partes.length}`
                + ` largos=[${partes.map(x => x.length).join(',')}]`
                + `${u.search ? ' query=si' : ''}${u.hash ? ' hash=si' : ''}`;
            } catch { descripcion = 'no-url'; }
            console.log(`src ${JSON.stringify(sv.title)} ${descripcion}`);
          }
        }
        const hostsDl = [...new Set((datos.dl || []).map(d => host(d.url)))];
        console.log(`descargas=${(datos.dl || []).length} hosts-dl=[${hostsDl.join(',')}]`);
      }
    }
  } catch (error) {
    console.log(`player: ${error.message.slice(0, 140)}`);
  }
}

// ---------------------------------------------------------------------------
// Fase 3: dónde están el id y el token del player
// ---------------------------------------------------------------------------
// El cliente los tiene en variables globales; aquí se listan las que empiezan
// por "gn" y solo se informa su forma (numérico, alfanumérico, largo), nunca su
// valor.
async function faseVariables() {
  const fetcher = createFetcher({ allowedHosts: [...hostsPermitidos({})], maxBytes: 4 * 1024 * 1024 });
  const html = await fetcher.getText(FICHA);
  const tipo = (valor) => {
    if (/^\d+$/.test(valor)) return `numerico(${valor.length})`;
    if (/^[a-z0-9]+$/i.test(valor)) return `alfanum(${valor.length})`;
    return `otro(${valor.length})`;
  };
  for (const match of html.matchAll(/\b(\w*(?:gnrd|tok|pid|player)\w*)\s*=\s*(["'])([^"']{1,200})\2/gi)) {
    console.log(`var ${match[1]} = <${tipo(match[3])}>`);
  }
  // También el uso exacto de _gnrdPid / _gnrdTok para ver de dónde salen.
  for (const nombre of ['_gnrdPid', '_gnrdTok', 'gnrdPid', 'gnrdTok']) {
    for (const match of html.matchAll(new RegExp(`.{0,120}${nombre}.{0,120}`, 'g'))) {
      console.log(`uso ${nombre}: ${redactar(match[0])}`);
    }
  }
}
