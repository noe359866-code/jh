const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { resolver, PROVEEDORES, hostsPermitidos } = require('../engines/sites');

// CDNs de ejemplo de los fixtures. En producción se autorizan con
// SITES_ALLOWED_HOSTS: ningún host descubierto en el HTML lo está por defecto.
const HOSTS_FIXTURE = ['sw.example', 'fm.example'];
const { claveEmbed69, resolverAnubis } = require('../engines/resolvers/crypto');
const { leerServidores } = require('../engines/embed69');

const lookupImpl = async () => [{ address: '93.184.216.34' }];
const HLS = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8\n';
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

// Página de Embed69 como la real: dataLink cifrado + challenge/salt.
function paginaEmbed69({ challenge = 'ch-1', salt = 'sa-1', grupos = [] } = {}) {
  const clave = claveEmbed69(challenge, salt);
  const cifrar = (url) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', clave, iv);
    return Buffer.concat([iv, cipher.update(Buffer.from(url)), cipher.final()]).toString('base64');
  };
  const dataLink = grupos.map(({ idioma, servidores }) => ({
    video_language: idioma,
    sortedEmbeds: servidores.map(([servername, url]) => ({ servername, link: cifrar(url) }))
  }));
  return `<html><head><script>let dataLink = ${JSON.stringify(dataLink)};</script>` +
    `<script>const LINK_CHALLENGE = '${challenge}'; const LINK_SALT = '${salt}';</script></head></html>`;
}

// Bloque P.A.C.K.E.R. con el media escondido (como streamwish/vidhide).
function empaquetar(cuerpo, palabras) {
  const codificar = (indice) => {
    const digitos = [];
    let numero = indice;
    do { const resto = numero % 36; digitos.unshift(resto.toString(36)); numero = Math.floor(numero / 36); } while (numero > 0);
    return digitos.join('');
  };
  let salida = cuerpo;
  palabras.forEach((palabra, indice) => { salida = salida.split(palabra).join(codificar(indice)); });
  return `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};` +
    `while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}` +
    `('${salida}',36,${palabras.length},'${palabras.join('|')}'.split('|'),0,{}))`;
}

const FICHA = '<html><body><h1>Patton</h1><iframe src="https://embed69.org/f/tt0066206/" allowfullscreen></iframe></body></html>';

test('FlixLatam: ficha → Embed69 → servidores descifrados → HLS verificado', async () => {
  const embed = paginaEmbed69({
    grupos: [
      { idioma: 'LAT', servidores: [['voe', 'https://voe.sx/e/lat1'], ['streamwish', 'https://hglink.to/e/sw1']] },
      { idioma: 'SUB', servidores: [['filemoon', 'https://filemoon.sx/e/fm1']] }
    ]
  });
  const streamwish = empaquetar('sources="https://sw.example/e/sw1/index.m3u8";', ['sources', 'https']);
  const paginas = {
    'flixlatam.com/pelicula/patton': FICHA,
    'embed69.org/f/tt0066206/': embed,
    'voe.sx/e/lat1': '<script type="application/json">{"source":"https://voe.sx/hls/master.m3u8"}</script>',
    'streamwish.to/e/sw1': streamwish,
    'filemoon.sx/e/fm1': '<script>var s = "https://fm.example/master.m3u8";</script>'
  };
  const pedidos = [];
  const streams = await resolver({ url: 'https://flixlatam.com/pelicula/patton' }, {
    lookupImpl,
    allowedHosts: [...hostsPermitidos({}), ...HOSTS_FIXTURE],
    fetchImpl: async (url) => {
      pedidos.push(url.hostname + url.pathname);
      if (url.pathname.endsWith('.m3u8')) return new Response(HLS);
      return new Response(paginas[url.hostname + url.pathname] ?? 'x');
    }
  });

  // Se resuelven los tres servidores, cada uno con su idioma en la etiqueta.
  assert.deepEqual(streams.map(s => s.url).sort(), [
    'https://fm.example/master.m3u8',
    'https://sw.example/e/sw1/index.m3u8',
    'https://voe.sx/hls/master.m3u8'
  ]);
  assert.deepEqual(streams.map(s => s.title).sort(), ['LAT · Streamwish', 'LAT · Voe', 'SUB · Filemoon']);
  for (const stream of streams) assert.equal(stream.name, 'FlixLatam');
  // El mirror rotado hglink.to se pidió como streamwish.to (registry correcto).
  assert.ok(pedidos.includes('streamwish.to/e/sw1'));
  assert.ok(!pedidos.includes('hglink.to/e/sw1'));
});

test('FlixLatam resuelve Anubis antes de leer el dataLink', async () => {
  const reto = { challenge: { randomData: 'datos-anubis', difficulty: 4, id: 'reto-1' } };
  const embedProtegido = `<html><script id="anubis_challenge" type="application/json">${JSON.stringify(reto)}</script></html>`;
  const solucion = resolverAnubis('datos-anubis', 4);
  let passChallenge = null;

  const streams = await resolver({ url: 'https://flixlatam.com/pelicula/patton' }, {
    lookupImpl,
    fetchImpl: async (url, opciones) => {
      const host = url.hostname + url.pathname;
      if (host === 'flixlatam.com/pelicula/patton') return new Response(FICHA);
      if (url.pathname.startsWith('/.within.website/x/cmd/anubis/api/pass-challenge')) {
        // Anubis acepta GET con query y POST con formulario: se prueban ambos.
        passChallenge = { url, metodo: opciones.method, cuerpo: opciones.body };
        assert.equal(opciones.redirect, 'manual');
        // El sitio devuelve la cookie que da acceso.
        return new Response(null, { status: 302, headers: { 'Set-Cookie': 'anubis=ok; Path=/; HttpOnly' } });
      }
      if (host === 'embed69.org/f/tt0066206/') {
        // Con cookie ya se sirve la página real con los servidores.
        if (opciones.headers?.Cookie?.includes('anubis=ok')) {
          return new Response(paginaEmbed69({ grupos: [{ idioma: 'LAT', servidores: [['voe', 'https://voe.sx/e/ok']] }] }));
        }
        return new Response(embedProtegido);
      }
      if (host === 'voe.sx/e/ok') return new Response('<script type="application/json">{"source":"https://voe.sx/hls/master.m3u8"}</script>');
      if (url.pathname.endsWith('.m3u8')) return new Response(HLS);
      return new Response('x');
    }
  });

  assert.deepEqual(streams.map(s => s.url), ['https://voe.sx/hls/master.m3u8']);
  assert.ok(passChallenge, 'debe pedir pass-challenge');
  // El primer intento es POST con formulario (el que usa Anubis hoy).
  assert.equal(passChallenge.metodo, 'POST');
  const campos = new URLSearchParams(passChallenge.cuerpo);
  assert.equal(campos.get('id'), 'reto-1');
  assert.equal(campos.get('nonce'), String(solucion.nonce));
  assert.equal(campos.get('response'), solucion.hash);
  assert.equal(campos.get('redir'), '/f/tt0066206/');
});

test('FlixLatam no inventa streams cuando el reproductor falla', async () => {
  const casos = [
    { html: '<html>sin player</html>', nota: 'ficha sin reproductor' },
    { html: FICHA, embed: '<html>dataLink vacío</html>', nota: 'reproductor sin dataLink' }
  ];
  for (const caso of casos) {
    const streams = await resolver({ url: 'https://flixlatam.com/pelicula/x' }, {
      lookupImpl,
      fetchImpl: async (url) => new Response(
        url.hostname === 'flixlatam.com' ? caso.html : (caso.embed ?? 'x')
      )
    });
    assert.deepEqual(streams, [], caso.nota);
  }
});

test('FlixLatam tiene prioridad sobre el barrido literal para medios directos', async () => {
  // Algunas fichas publican un mp4 directo: se verifica por firma y se entrega.
  const ficha = '<html><body><source src="https://flixlatam.com/media/pelicula.mp4"></body></html>';
  const streams = await resolver({ url: 'https://flixlatam.com/pelicula/directo' }, {
    lookupImpl,
    fetchImpl: async (url) => new Response(url.pathname.endsWith('.mp4') ? MP4 : ficha)
  });
  assert.deepEqual(streams.map(s => s.url), ['https://flixlatam.com/media/pelicula.mp4']);
});

test('el proveedor declara los hosts imprescindibles: sitio, embed69 y players', () => {
  assert.deepEqual(PROVEEDORES.map(p => p.clave), ['flixlatam']);
  const hosts = hostsPermitidos({});
  for (const host of ['flixlatam.com', 'www.flixlatam.com', 'embed69.org', 'voe.sx', 'streamwish.to',
    'vidhidepro.com', 'filemoon.sx', 'uqload.com', 'hglink.to', 'morencius.com']) {
    assert.ok(hosts.includes(host), `${host} debe estar autorizado`);
  }
  assert.equal(hosts.includes('cdn.evil.example'), false);
});
