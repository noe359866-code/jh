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

principal().catch(error => {
  console.error(`diagnóstico falló: ${error.message}`);
  process.exit(1);
});
