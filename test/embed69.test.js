const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { claveEmbed69, resolverAnubis, verificarAnubis } = require('../engines/resolvers/crypto');
const { leerServidores, leerRetoAnubis, descifrarEnlace, normalizarDestino, encontrarReproductor } = require('../engines/embed69');
const { unPacker, unPackerTodo, codificar } = require('../engines/resolvers/packer');

// ---------------------------------------------------------------------------
// Embed69: dataLink + AES-256-CBC (IV = primeros 16 bytes del base64)
// ---------------------------------------------------------------------------

const CLAVE = claveEmbed69('challenge-test', 'salt-test');

function cifrarEnlace(url, clave = CLAVE) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', clave, iv);
  return Buffer.concat([iv, cipher.update(Buffer.from(url)), cipher.final()]).toString('base64');
}

function paginaEmbed69({ challenge = 'challenge-test', salt = 'salt-test', grupos = [] } = {}) {
  const dataLink = grupos.map(({ idioma, servidores }) => ({
    video_language: idioma,
    sortedEmbeds: servidores.map(([servername, url]) => ({ servername, link: cifrarEnlace(url, claveEmbed69(challenge, salt)) }))
  }));
  return `<html><script>let dataLink = ${JSON.stringify(dataLink)};</script>` +
    `<script>const LINK_CHALLENGE = '${challenge}'; const LINK_SALT = '${salt}';</script></html>`;
}

test('Embed69 descifra los servidores del dataLink con SHA-256(challenge+salt)', () => {
  const html = paginaEmbed69({
    grupos: [
      { idioma: 'LAT', servidores: [['streamwish', 'https://streamwish.to/e/abc'], ['voe', 'https://voe.sx/e/xyz']] },
      { idioma: 'SUB', servidores: [['filemoon', 'https://filemoon.sx/e/fm']] }
    ]
  });
  const servidores = leerServidores(html);
  assert.deepEqual(servidores.map(s => s.url), [
    'https://streamwish.to/e/abc', 'https://voe.sx/e/xyz', 'https://filemoon.sx/e/fm'
  ]);
  assert.deepEqual(servidores.map(s => s.etiqueta), ['LAT · Streamwish', 'LAT · Voe', 'SUB · Filemoon']);
});

test('Embed69 normaliza los dominios rotados a los que resuelve el registry', () => {
  // Embed69 devuelve muchos mirrors; los resolvedores los conocen por su
  // nombre estable. Sin normalizar, el registry caería en el genérico.
  const casos = {
    'https://morencius.com/e/a': 'https://vidhidepro.com/e/a',
    'https://hglink.to/e/b': 'https://streamwish.to/e/b',
    'https://cybervynx.com/e/c': 'https://streamwish.to/e/c',
    'https://filemoon.link/e/d': 'https://filemoon.sx/e/d',
    'https://uqload.io/embed-e.html': 'https://uqload.com/embed-e.html',
    'https://do7go.com/e/f': 'https://dood.la/e/f',
    'https://voe.sx/e/g': 'https://voe.sx/e/g'
  };
  for (const [entrada, esperado] of Object.entries(casos)) assert.equal(normalizarDestino(entrada), esperado);
});

test('Embed69 ignora payloads que no descifran o no son http', () => {
  const html = paginaEmbed69({ grupos: [{ idioma: 'LAT', servidores: [['voe', 'https://voe.sx/e/ok']] }] })
    .replace(/let dataLink = (.*?);/, (m, json) => {
      const datos = JSON.parse(json);
      datos[0].sortedEmbeds.push({ servername: 'roto', link: 'bm8tZXMtYWVz' });          // base64 inválido
      datos[0].sortedEmbeds.push({ servername: 'ftp', link: cifrarEnlace('ftp://x/y.mp4') }); // esquema no http
      return `let dataLink = ${JSON.stringify(datos)};`;
    });
  assert.deepEqual(leerServidores(html).map(s => s.url), ['https://voe.sx/e/ok']);
  assert.equal(descifrarEnlace('bm8tZXMtYWVz', CLAVE), null);
});

test('Embed69 detecta el reto de Anubis y el iframe del reproductor en la ficha', () => {
  // Formato real de Anubis: la dificultad autoritativa está en rules.difficulty
  // y hay prefijo de despliegue y algoritmo.
  const reto = leerRetoAnubis('<script id="anubis_base_prefix" type="application/json">"/app"</script>' +
    '<script id="anubis_challenge" type="application/json">' +
    '{"rules":{"algorithm":"fast","difficulty":5},"challenge":{"randomData":"abc","difficulty":4,"id":"xyz"}}</script>');
  assert.deepEqual(reto, { randomData: 'abc', difficulty: 5, algorithm: 'fast', id: 'xyz', prefijo: '/app' });
  // Sin rules se cae a challenge.difficulty (compatibilidad).
  assert.deepEqual(leerRetoAnubis('<script id="anubis_challenge" type="application/json">' +
    '{"challenge":{"randomData":"abc","difficulty":4,"id":"xyz"}}</script>'),
  { randomData: 'abc', difficulty: 4, algorithm: 'fast', id: 'xyz', prefijo: '' });
  assert.equal(leerRetoAnubis('<html>sin reto</html>'), null);
  // Las dos formas que usa FlixLatam: iframe a embed69 y al antiguo /vidurl/.
  assert.equal(encontrarReproductor('<iframe src="https://embed69.org/f/tt1/"></iframe>', 'https://flixlatam.com/pelicula/x'),
    'https://embed69.org/f/tt1/');
  assert.equal(encontrarReproductor('<iframe src="/vidurl/abc/"></iframe>', 'https://flixlatam.com/pelicula/x'),
    'https://flixlatam.com/vidurl/abc/');
  assert.equal(encontrarReproductor('<html>sin player</html>', 'https://flixlatam.com/pelicula/x'), null);
});

// ---------------------------------------------------------------------------
// Anubis proof of work
// ---------------------------------------------------------------------------

test('Anubis resuelve el PoW con la dificultad en nibbles y el hash verifica', () => {
  // Dificultad 4 = dos nibbles ('00' al inicio). Con la interpretación errónea
  // de "dificultad en bytes" el reto nunca se resolvía.
  const datos = 'random-data-de-prueba';
  const solucion = resolverAnubis(datos, 4);
  assert.ok(solucion, 'debe encontrar un nonce');
  assert.match(solucion.hash, /^0000/);
  assert.equal(verificarAnubis(datos, 4, solucion.nonce, solucion.hash), true);
  assert.equal(verificarAnubis(datos, 4, solucion.nonce + 1, solucion.hash), false);
  // Dificultad 0 no exige nada y devuelve el primer nonce.
  assert.equal(resolverAnubis(datos, 0).nonce, 0);
});

// ---------------------------------------------------------------------------
// P.A.C.K.E.R.
// ---------------------------------------------------------------------------

// Genera un bloque P.A.C.K.E.R. válido a partir de un diccionario.
function empaquetar(cuerpo, palabras) {
  const codificar = (indice) => {
    const digitos = [];
    let numero = indice;
    do {
      const resto = numero % 36;
      digitos.unshift(resto > 35 ? String.fromCharCode(resto + 29) : resto.toString(36));
      numero = Math.floor(numero / 36);
    } while (numero > 0);
    return digitos.join('');
  };
  let salida = cuerpo;
  palabras.forEach((palabra, indice) => {
    salida = salida.split(palabra).join(codificar(indice));
  });
  return `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};` +
    `while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}` +
    `('${salida}',36,${palabras.length},'${palabras.join('|')}'.split('|'),0,{}))`;
}

test('P.A.C.K.E.R. reconstruye el código y deja ver la URL del media', () => {
  const palabras = ['sources', 'https', 'cdn', 'streamwish', 'master', 'm3u8'];
  const bloque = empaquetar('sources="https://cdn.streamwish.to/master.m3u8";', palabras);
  assert.match(bloque, /^eval\(function\(p,a,c,k,e,d\)/);
  const desempaquetado = unPacker(bloque);
  assert.equal(desempaquetado, 'sources="https://cdn.streamwish.to/master.m3u8";');
  assert.deepEqual(unPackerTodo(bloque).slice(1), ['sources="https://cdn.streamwish.to/master.m3u8";']);
  assert.equal(unPacker('<html>nada</html>'), null);
});

test('P.A.C.K.E.R. soporta alfabetos con más de 36 palabras', () => {
  // Con a=62 se usan letras mayúsculas: un decodificador que asuma base36 falla.
  const palabras = Array.from({ length: 40 }, (_, i) => `palabra${i}`);
  palabras[38] = 'urlFinal';
  // Índice 38 en base 62 es 'C' (mayúscula): solo se decodifica bien con el
  // alfabeto 0-9a-zA-Z del cargador original.
  assert.equal(codificar(38, 62), 'C');
  const bloque = `eval(function(p,a,c,k,e,d){while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}` +
    `(' C="1";',62,${palabras.length},'${palabras.join('|')}'.split('|'),0,{}))`;
  // El diccionario sustituye también el "1" del cuerpo (índice 1 del array).
  assert.equal(unPacker(bloque), ' urlFinal="palabra1";');
});

test('las redirecciones controladas sobreviven al fetcher endurecido', async () => {
  // Regresión real: createPublicFetch forzaba redirect:'error' después de las
  // opciones, así que 'manual' se perdía y Anubis (302 + Set-Cookie) fallaba
  // solo en producción, nunca con un fetchImpl inyectado en los tests.
  // Aquí se intercepta undici.fetch para ver la opción que sale de verdad.
  const undici = require('undici');
  const original = undici.fetch;
  const opcionesVistas = [];
  undici.fetch = async (url, opciones) => {
    opcionesVistas.push(opciones.redirect);
    return new Response(null, { status: 302, headers: { 'Set-Cookie': 'a=b' } });
  };
  try {
    const { createPublicFetch } = require('../engines/sites/network');
    const fetchFn = createPublicFetch({ lookupImpl: async () => [{ address: '93.184.216.34' }] });
    await fetchFn('https://example.com/', { redirect: 'manual' });
    await fetchFn('https://example.com/');
    await fetchFn('https://example.com/', { redirect: 'follow' });
  } finally {
    undici.fetch = original;
  }
  assert.deepEqual(opcionesVistas, ['manual', 'error', 'follow']);
});

test('el fetcher reenvía las cookies del player y reintenta el interstitial', async () => {
  // Streamwish (y otros) responden primero una página "Loading..." de pocos
  // bytes con una cookie; solo con esa cookie llega la página con la fuente.
  const { createFetcher } = require('../engines/sites/extractor');
  const { crearRegistry } = require('../engines/resolvers');
  let visitas = 0;
  const fetchImpl = async (url, opciones) => {
    if (url.hostname === 'streamwish.to') {
      visitas++;
      const traeCookie = String(opciones.headers?.Cookie || '').includes('player=1');
      if (!traeCookie) {
        return new Response('<html><title>Loading...</title></html>',
          { headers: { 'Set-Cookie': 'player=1; Path=/' } });
      }
      return new Response('eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};' +
        "while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}" +
        "('sources:[{file:\"1://sw.example/e/a/index.mp4\"}];',36,2,'_|https'.split('|'),0,{}))");
    }
    // Caja ISO BMFF mínima: [tamaño:4]['ftyp'][marca] (firmaMedia exige ≥ 12 bytes).
    if (url.hostname === 'sw.example') {
      return new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
    }
    return new Response('x');
  };
  const registro = crearRegistry({ allowedHosts: ['sw.example'], lookupImpl: async () => [{ address: '93.184.216.34' }], fetchImpl });
  const streams = await registro.resolver('https://streamwish.to/e/a');
  assert.deepEqual(streams.map(s => s.url), ['https://sw.example/e/a/index.mp4']);
  assert.equal(visitas, 2, 'debe reintentar con la cookie del player');

  // Y la cookie queda guardada por host en el fetcher.
  const fetcher = createFetcher({ allowedHosts: ['streamwish.to'], lookupImpl: async () => [{ address: '93.184.216.34' }], fetchImpl });
  await fetcher.getText('https://streamwish.to/e/a');
  assert.equal(fetcher.cookiesDe('streamwish.to'), 'player=1');
});

test('el player recibe el Referer del reproductor que lo incrusta', async () => {
  // Los players comprueban el Referer: debe ser la página de Embed69, no la del
  // sitio ni la del propio player.
  const vistos = [];
  const { crearRegistry } = require('../engines/resolvers');
  const registro = crearRegistry({
    allowedHosts: ['sw.example'],
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url, opciones) => {
      vistos.push([url.hostname, opciones.headers?.Referer]);
      if (url.hostname === 'streamwish.to') return new Response('<script>sources:[{file:"https://sw.example/e/a/index.mp4"}]</script>');
      return new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
    }
  });
  await registro.resolver('https://streamwish.to/e/a', { pageReferer: 'https://embed69.org/f/tt1/' });
  assert.deepEqual(vistos.find(([host]) => host === 'streamwish.to'), ['streamwish.to', 'https://embed69.org/f/tt1/']);
});

test('el cuerpo redactado de un interstitial no filtra URLs ni tokens', () => {
  // Se publica el cuerpo de páginas mínimas para entender qué interpone el
  // player; debe salir sin URLs, rutas ni tokens.
  const { cuerpoRedactado } = require('../engines/resolvers/packed');
  const html = '<html><head><script src="https://cdn.ejemplo/x.js?k=1"></script></head>' +
    '<body><div data-token="abcdefghijklmnopqrstuvwx1234"></div><p>Loading...</p></body></html>';
  const salida = cuerpoRedactado(html);
  assert.ok(!salida.includes('ejemplo'), 'sin hosts');
  assert.ok(!salida.includes('abcdefghijklmnop'), 'sin tokens');
  assert.match(salida, /Loading/);
});

test('los servidores que no exigen JS se intentan primero', async () => {
  // Voe sí se resuelve sin navegador; los P.A.C.K.E.R. con interstitial no
  // deben consumir el turno de los que sí pueden entregar medios.
  const { resolver, hostsPermitidos } = require('../engines/sites');
  const orden = [];
  const streams = await resolver({ url: 'https://flixlatam.com/pelicula/x' }, {
    allowedHosts: [...hostsPermitidos({}), 'sw.example'],
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url) => {
      const host = url.hostname;
      if (host === 'flixlatam.com' && url.pathname === '/pelicula/x') {
        return new Response('<iframe src="https://embed69.org/f/tt1/"></iframe>');
      }
      if (host === 'embed69.org') {
        return new Response(paginaEmbed69({ grupos: [
          { idioma: 'LAT', servidores: [['streamwish', 'https://streamwish.to/e/sw'], ['voe', 'https://voe.sx/e/ok']] }
        ] }));
      }
      orden.push(host);
      if (host === 'streamwish.to') return new Response('<html><title>Loading...</title></html>');
      // Voe sirve su JSON de fuentes en una página estática (sin JS propio).
      if (host === 'voe.sx' && url.pathname.startsWith('/e/')) {
        return new Response('<script type="application/json">{"source":"https://voe.sx/hls/master.m3u8"}</script>');
      }
      // Playlist verificable (una cabecera suelta no cuenta como media).
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720.m3u8\n');
    }
  });
  // El título usa el idioma largo ("Latino"), no el código de Embed69 ("LAT").
  assert.ok(streams.length >= 1, 'debe entregar al menos el medio de Voe');
  assert.ok(streams.every(s => s.title === 'Latino · Voe'), JSON.stringify(streams.map(s => s.title)));
  assert.equal(orden[0], 'voe.sx', `orden observado: ${orden.join(',')}`);
});

test('lee el loader del player (sin ejecutarlo) y prueba su API', async () => {
  // Caso real de Streamwish: spinner de ~800 B con /main.js. El JS pide la
  // fuente a una API del mismo host; se lee la ruta y se prueba, sin ejecutar
  // nada del sitio.
  const { crearRegistry } = require('../engines/resolvers');
  const pedidos = [];
  const spinner = '<!DOCTYPE html><head><title>Loading...</title></head><body>' +
    '<div class="spinner"></div><p>Page is loading, please wait...</p>' +
    '<script src="/main.js?v=1.1.9"></script></body>';
  const loader = 'const api="/dl?op=player_api&file=abc&id=1";' +
    'fetch(api).then(r=>r.json()).then(d=>{location.href=d.url});' +
    'const css="/style.css"; const img="/logo.png";';
  const registro = crearRegistry({
    allowedHosts: ['sw.example'],
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url) => {
      pedidos.push(url.pathname + url.search);
      if (url.pathname === '/e/a') return new Response(spinner);
      if (url.pathname === '/main.js') return new Response(loader);
      if (url.pathname === '/dl') return new Response(JSON.stringify({ url: 'https://sw.example/e/a/index.mp4' }));
      return new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
    }
  });
  const streams = await registro.resolver('https://streamwish.to/e/a');
  assert.deepEqual(streams.map(s => s.url), ['https://sw.example/e/a/index.mp4']);
  assert.ok(pedidos.some(p => p.startsWith('/dl?')), 'debe probar la ruta de API del loader');
  assert.ok(!pedidos.some(p => p === '/style.css' || p === '/logo.png'), 'no pide estáticos');
});

test('un loader ofuscado se detecta y no se inventan rutas', async () => {
  // Caso real de Streamwish: 71 KB ofuscados (array de cadenas rotado). Sin
  // ejecutar su JS no hay rutas legibles; se informa y se corta.
  const { crearRegistry } = require('../engines/resolvers');
  const pedidos = [];
  const spinner = '<!DOCTYPE html><title>Loading...</title><body>Page is loading' +
    '<script src="/main.js?v=1.1.9"></script>';
  const ofuscado = 'var _0x1a2b=["VfWE","4yDx","J13g","dkg9","riYZ","fbco"]'.padEnd(2600, 'x') +
    ';(function(_0x3c,_0x4d){while(!![]){try{_0x3c.push(_0x3c.shift())}catch(_0x11){break}}}(_0x1a2b));';
  const eventos = [];
  const registro = crearRegistry({
    allowedHosts: ['sw.example'],
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    onEvent: (evento) => eventos.push(evento),
    fetchImpl: async (url) => {
      pedidos.push(url.pathname);
      if (url.pathname === '/e/a') return new Response(spinner);
      if (url.pathname === '/main.js') return new Response(ofuscado);
      return new Response('x');
    }
  });
  assert.deepEqual(await registro.resolver('https://streamwish.to/e/a'), []);
  assert.ok(eventos.some(e => e.stage === 'loader-ofuscado'), 'debe informar que el loader está ofuscado');
  // No se piden rutas al azar sacadas del array de cadenas.
  assert.ok(!pedidos.some(p => /^\/[A-Za-z0-9]{4,6}$/.test(p)), `pedidos: ${pedidos.join(',')}`);
});

test('el cuerpo redactado cumple el contrato del reporte saneado', () => {
  // El reporte en vivo nunca puede llevar queries ni la palabra "token": el
  // test de contrato de scripts/sites-live.js lo vigila. El diagnóstico nuevo
  // (cuerpo, rutas del loader) también debe cumplirlo.
  const { cuerpoRedactado, rutaRedactada } = require('../engines/resolvers/packed');
  const conSecretos = '<script src="/style.css" data-cf-beacon=\'{"token":"abc123"}\'></script>' +
    '<form method="post"><input name="_token" value="xyz">' +
    '<input name="csrf_token" value="secreto"></form>' +
    '<script>const api="/dl?op=player_api&file=abc&sig=deadbeef";</script>';
  const cuerpo = cuerpoRedactado(conSecretos);
  assert.doesNotMatch(cuerpo, /\?/, 'sin queries');
  assert.doesNotMatch(cuerpo, /token/i, 'sin la palabra token');
  assert.doesNotMatch(cuerpo, /abc123|deadbeef|secreto|xyz/, 'sin valores sensibles');
  // Las rutas se publican sin valores de parámetros.
  assert.equal(rutaRedactada('/dl?op=player_api&file=abc'), '/dl?op&file');
});
