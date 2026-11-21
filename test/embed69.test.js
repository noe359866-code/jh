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
  const reto = leerRetoAnubis('<script id="anubis_challenge" type="application/json">' +
    '{"challenge":{"randomData":"abc","difficulty":4,"id":"xyz"}}</script>');
  assert.deepEqual(reto, { randomData: 'abc', difficulty: 4, id: 'xyz' });
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
