const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { resolver, PROVEEDORES, hostsPermitidos, validarUrlSitio } = require('../engines/sites');
const { buscarPistasReproductor } = require('../engines/sites/pistas');

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
  assert.deepEqual(streams.map(s => s.title).sort(), ['Latino · Streamwish', 'Latino · Voe', 'Subtitulado · Filemoon']);
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
      // El nombre real de la cookie es *-anubis-auth.
      if (url.pathname.startsWith('/.within.website/x/cmd/anubis/api/pass-challenge')) {
        passChallenge = { url, metodo: opciones.method, cuerpo: opciones.body };
        assert.equal(opciones.redirect, 'manual');
        return new Response(null, { status: 302, headers: { 'Set-Cookie': 'within.website-x-cmd-anubis-auth=tok3n; Path=/; HttpOnly' } });
      }
      if (host === 'embed69.org/f/tt0066206/') {
        // Con cookie ya se sirve la página real con los servidores.
        if (opciones.headers?.Cookie?.includes('anubis-auth')) {
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
  // El primer intento es GET con la respuesta en la query (protocolo Anubis).
  assert.equal(passChallenge.metodo, 'GET');
  const campos = passChallenge.url.searchParams;
  assert.equal(campos.get('id'), 'reto-1');
  assert.equal(campos.get('nonce'), String(solucion.nonce));
  assert.equal(campos.get('response'), solucion.hash);
  assert.equal(campos.get('redir'), 'https://embed69.org/f/tt0066206/');
  // Y se espera el tiempo mínimo que exige el servidor (dificultad × 80 ms).
  assert.ok(Number(campos.get('elapsedTime')) >= 4 * 80 - 5);
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
  assert.deepEqual(PROVEEDORES.map(p => p.clave), ['flixlatam', 'gnula']);
  const hosts = hostsPermitidos({});
  for (const host of ['flixlatam.com', 'www.flixlatam.com', 'embed69.org', 'voe.sx', 'streamwish.to',
    'vidhidepro.com', 'filemoon.sx', 'uqload.com', 'hglink.to', 'morencius.com']) {
    assert.ok(hosts.includes(host), `${host} debe estar autorizado`);
  }
  assert.equal(hosts.includes('cdn.evil.example'), false);
});

test('la ficha publica varios reproductores: se recorren todos', async () => {
  // Antes solo se usaba el primer iframe; si ese fallaba (o no traía el
  // dataLink) se perdían los players enlazados del resto de la ficha.
  const ficha = '<html><iframe src="https://embed69.org/f/tt1/"></iframe>' +
    '<a class="server" href="https://uqload.vc/embed-abc.html">uqload</a></html>';
  const { crearProveedorFlixLatam } = require('../engines/sites/flixlatam');
  const { hostsPermitidos } = require('../engines/sites');
  const proveedor = crearProveedorFlixLatam({
    allowedHosts: [...hostsPermitidos({}), 'uqload.vc'],
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url) => {
      if (url.hostname === 'flixlatam.com') return new Response(ficha);
      if (url.hostname === 'embed69.org') return new Response(paginaEmbed69({ grupos: [] }));
      return new Response('x');
    }
  });
  const { servidores, reproductores } = await proveedor.descubrir('https://flixlatam.com/pelicula/x');
  assert.equal(reproductores.length, 1);
  assert.ok(servidores.some(s => s.url.includes('uqload.vc/embed-abc.html')), 'debe incluir el player enlazado');
  assert.ok(servidores.every(s => typeof s.etiqueta === 'string' && s.etiqueta.length > 0));
});

// ---------------------------------------------------------------------------
// Gnula: WordPress con modal de reproducción
// ---------------------------------------------------------------------------
// La ficha real no lleva el reproductor en el HTML: el tema lo inyecta al
// pulsar "Reproducir". Estas pruebas cubren lo que sí es legible (iframes,
// enlaces a players conocidos, atributos data-*) y el diagnóstico cuando la
// página no publica ninguna pista.

const FICHA_GNULA = `<!DOCTYPE html><html><head>
<script src="https://ww3.gnulahd.nu/wp-includes/js/jquery/jquery.min.js"></script>
<script>var gnulaAjax = {"url":"https://ww3.gnulahd.nu/wp-admin/admin-ajax.php","action":"gnula_get_player","nonce":"abc123"};</script>
</head><body>
<div id="player-modal" class="modal">
  <div class="audio-options"><button class="opt active">Latino</button><button class="opt">Subtitulado</button></div>
  <div class="server-options"><button>Servidor 1</button><button>Servidor 2</button></div>
  <div id="player-container" data-video-id="520864" data-post="9912">
    <p>Haz clic para reproducir</p>
  </div>
</div>
<a class="download" href="https://ww3.gnulahd.nu/ver/godzilla-minus-zero/#">Descargar</a>
</body></html>`;

const FICHA_GNULA_CON_PLAYER = FICHA_GNULA.replace('</body>',
  '<iframe src="https://streamwish.to/e/abc123" allowfullscreen></iframe>' +
  '<a class="mirror" href="https://vidhidepro.com/v/xyz789">Ver</a>' +
  '<div data-src="https://filemoon.sx/e/qq1"></div></body>');

test('Gnula: la ficha se acepta como sitio propio y con sus espejos', () => {
  const { proveedor } = validarUrlSitio('https://ww3.gnulahd.nu/ver/godzilla-minus-zero/');
  assert.equal(proveedor.clave, 'gnula');
  assert.deepEqual(PROVEEDORES.find(p => p.clave === 'gnula').hosts,
    ['ww3.gnulahd.nu', 'gnulahd.nu', 'www.gnulahd.nu']);
});

test('Gnula: recoge los reproductores legibles de la ficha, sin ejecutar JS', async () => {
  const eventos = [];
  const pedidos = [];
  const fetchImpl = async (destino) => {
    const url = String(destino);
    pedidos.push(url);
    if (url.includes('gnulahd.nu')) return new Response(FICHA_GNULA_CON_PLAYER);
    // Los players de la ficha son páginas HTML: el registry las lee (no las
    // ejecuta) y, cuando no hay media verificable, no se devuelve nada.
    return new Response('<html><body><p>Loading...</p></body></html>');
  };
  const streams = await resolver({ url: 'https://ww3.gnulahd.nu/ver/godzilla-minus-zero/' }, {
    lookupImpl, fetchImpl, onEvent: evento => eventos.push(evento)
  });

  // Las tres pistas de la ficha (iframe, enlace y data-src) se descubren.
  const pistas = eventos.find(e => e.stage === 'pistas');
  assert.ok(pistas, 'debe informar las pistas encontradas');
  assert.equal(pistas.host, 'ww3.gnulahd.nu');
  assert.equal(pistas.total, 3);

  // Y se intentan de verdad: el registry pide cada host de player.
  for (const host of ['streamwish.to', 'vidhidepro.com', 'filemoon.sx']) {
    assert.ok(pedidos.some(p => p.includes(host)), `${host} debe intentarse`);
  }

  // Sin media verificable la lista queda vacía: nunca se inventa un stream.
  assert.deepEqual(streams, []);
});

test('Gnula: sin pistas legibles se informa la forma de la página, no se inventa nada', async () => {
  const eventos = [];
  const streams = await resolver({ url: 'https://ww3.gnulahd.nu/ver/street-fighter/' }, {
    lookupImpl,
    fetchImpl: async () => new Response(FICHA_GNULA),
    onEvent: evento => eventos.push(evento)
  });
  assert.deepEqual(streams, []);
  const diagnostico = eventos.find(e => e.stage === 'sin-pistas');
  assert.ok(diagnostico, 'debe emitir un diagnóstico de la página');
  // Solo estructura: nombres de etiqueta, endpoints y acciones del tema.
  assert.ok(diagnostico.etiquetas.includes('div'));
  assert.ok(diagnostico.endpoints.includes('admin-ajax.php'));
  assert.ok(diagnostico.acciones.includes('gnula_get_player'));
  assert.ok(diagnostico.ids.includes('player-container'));
  // Nunca el contenido de la página.
  assert.equal(JSON.stringify(diagnostico).includes('Haz clic'), false);
  assert.equal(JSON.stringify(diagnostico).includes('abc123'), false);
});

test('Gnula: el tráiler de YouTube no cuenta como reproductor del sitio', async () => {
  // La ficha real incrusta el tráiler antes que el modal del player. Si el
  // tráiler se toma como pista, el único intento acaba en blocked-host y el
  // diagnóstico real (no hay pistas del sitio) queda oculto.
  const ficha = FICHA_GNULA.replace('</body>',
    '<iframe src="https://www.youtube-nocookie.com/embed/abc?autoplay=1"></iframe></body>');
  const eventos = [];
  const pedidos = [];
  const streams = await resolver({ url: 'https://ww3.gnulahd.nu/ver/marrow/' }, {
    lookupImpl,
    fetchImpl: async (destino) => { pedidos.push(String(destino)); return new Response(ficha); },
    onEvent: evento => eventos.push(evento)
  });
  assert.deepEqual(streams, []);
  const pistas = eventos.find(e => e.stage === 'pistas');
  assert.equal(pistas.total, 0, 'el tráiler no es una pista de reproductor');
  assert.equal(pistas.otrosFrames, 1);
  assert.ok(eventos.some(e => e.stage === 'sin-pistas'));
  // Y no se hace ninguna petición al host del tráiler.
  assert.equal(pedidos.some(p => p.includes('youtube')), false);
});

test('Gnula: los idiomas y servidores del modal se leen del texto visible', () => {
  const { idiomas, servidores } = buscarPistasReproductor(FICHA_GNULA, 'https://ww3.gnulahd.nu/ver/x/');
  assert.deepEqual(idiomas, ['Latino', 'Subtitulado']);
  assert.deepEqual(servidores, [1, 2]);
});

// ---------------------------------------------------------------------------
// Gnula: API del tema (base64 + XOR) descifrada sin ejecutar JavaScript
// ---------------------------------------------------------------------------
// Payload con la MISMA forma que el real (verificado en vivo):
//   { t, langs: [{ label, flag, servers: [{ title, src }] }], dl: [...] }
// y cifrado igual que `gnrdUnpack` lo descifra.
function empaquetarGnula(datos, clave = [103, 78, 55, 100]) {
  const claro = Buffer.from(JSON.stringify(datos), 'utf8');
  const cifrado = Buffer.alloc(claro.length);
  for (let i = 0; i < claro.length; i++) cifrado[i] = claro[i] ^ clave[i % clave.length];
  return cifrado.toString('base64');
}

const FICHA_GNULA_API = `<html><head><script>
var _gnrdPid=520864,_gnrdTok="tok-de-prueba-0123456789abcdef";
</script><script>
function _gdLoad(){ fetch('/wp-json/gnrd/v1/player?id='+_gnrdPid+'&t='+encodeURIComponent(_gnrdTok))
  .then(function(r){return r.json();}).then(function(raw){ _gdApply(gnrdUnpack(raw.p)); }); }
function gnrdUnpack(s){try{var b=atob(s),k=[103,78,55,100];/*…*/return JSON.parse(b);}catch(e){return [];}}
</script></head><body><div id="gnrd-player-modal"></div></body></html>`;

const PAYLOAD_GNULA = {
  t: 'Godzilla Minus Zero',
  langs: [
    { label: 'Latino', flag: 'MX', servers: [
      { title: 'Servidor 1', src: 'https://vidara.to/e/abc123#xyz' },
      { title: 'Servidor 2', src: 'https://savefiles.com/e/def456' }
    ] },
    { label: 'Subtitulado', flag: 'US', servers: [
      { title: 'Servidor 1', src: 'https://vidaraa.cc/e/ghi789#xyz' }
    ] }
  ],
  dl: [{ name: '01', lang: 'Latino', qual: 'HD-CAM', url: 'https://1cloudfile.com/x' }]
};

test('Gnula descifra el payload del tema: base64 + XOR de 4 bytes, sin ejecutar JS', () => {
  const { desempacar, CLAVE_XOR } = require('../engines/sites/gnula');
  const datos = desempacar(empaquetarGnula(PAYLOAD_GNULA));
  assert.equal(datos.t, 'Godzilla Minus Zero');
  assert.equal(datos.langs.length, 2);
  // Un payload corrupto no lanza: devuelve null y el flujo no inventa nada.
  assert.equal(desempacar('no-es-base64-@@'), null);
  assert.equal(desempacar(''), null);
  assert.equal(desempacar(empaquetarGnula({ a: 1 }, [1, 2, 3, 4]), CLAVE_XOR), null);
});

test('Gnula lee id, token y la URL del player del código del tema', () => {
  const { leerPlayer } = require('../engines/sites/gnula');
  const player = leerPlayer(FICHA_GNULA_API);
  assert.equal(player.id, '520864');
  assert.equal(player.token, 'tok-de-prueba-0123456789abcdef');
  assert.equal(player.prefijo, '/wp-json/gnrd/v1/player?id=');
  assert.equal(player.sufijo, '&t=');
  // Si el tema cambia y no hay construcción reconocible, no se inventa.
  assert.equal(leerPlayer('<html>sin player</html>'), null);
});

test('Gnula resuelve la ficha por su API y etiqueta idioma y servidor', async () => {
  const payload = empaquetarGnula(PAYLOAD_GNULA);
  const pedidos = [];
  const eventos = [];
  const HLS_GNULA = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\n720p.m3u8\n';
  const fetchImpl = async (destino) => {
    const url = String(destino);
    pedidos.push(url);
    // 1) ficha  2) API del player (respuesta {p})  3) cada player de la lista
    if (url.includes('/ver/godzilla-minus-zero/')) return new Response(FICHA_GNULA_API);
    if (url.includes('/wp-json/gnrd/v1/player')) return new Response(JSON.stringify({ p: payload }));
    if (url.endsWith('.m3u8')) return new Response(HLS_GNULA);
    // Uno de los players publica la fuente en claro; los demás no.
    if (url.includes('vidara.to')) {
      return new Response('<html><script>var src="https://cdn.example/stream.m3u8";</script></html>');
    }
    return new Response('<html><body>Loading...</body></html>');
  };
  const streams = await resolver({ url: 'https://ww3.gnulahd.nu/ver/godzilla-minus-zero/' }, {
    lookupImpl, fetchImpl,
    allowedHosts: [...hostsPermitidos({}), 'cdn.example'],
    onEvent: evento => eventos.push(evento)
  });

  // La API se pidió con el id y el token del propio tema.
  assert.ok(pedidos.some(p => p.includes('/wp-json/gnrd/v1/player?id=520864')));
  assert.ok(pedidos.some(p => p.includes('t=tok-de-prueba')));
  // Los tres servidores del payload se intentan.
  for (const host of ['vidara.to', 'savefiles.com', 'vidaraa.cc']) {
    assert.ok(pedidos.some(p => p.includes(host)), `${host} debe intentarse`);
  }
  const servidores = eventos.find(e => e.stage === 'servidores');
  assert.equal(servidores.total, 3);
  assert.equal(servidores.descifrado, true);
  assert.deepEqual(servidores.hosts, ['vidara.to', 'savefiles.com', 'vidaraa.cc']);
  // Los enlaces con #fragmento del player se resuelven (no se descartan).
  assert.ok(streams.length >= 1);
  for (const stream of streams) {
    assert.equal(stream.name, 'Gnula');
    assert.match(stream.title, /^(Latino|Subtitulado) · Servidor \d$/);
  }
});

test('Gnula: si la API no descifra, cae a las pistas del HTML y lo informa', async () => {
  const eventos = [];
  const streams = await resolver({ url: 'https://ww3.gnulahd.nu/ver/bleach-2004/' }, {
    lookupImpl,
    fetchImpl: async (destino) => {
      const url = String(destino);
      if (url.endsWith('/ver/bleach-2004/')) {
        return new Response(FICHA_GNULA_API.replace('</body>',
          '<iframe src="https://streamwish.to/e/zzz"></iframe></body>'));
      }
      if (url.includes('/wp-json/gnrd/v1/player')) return new Response(JSON.stringify({ p: 'AAAA' }));
      return new Response('<html><body>Loading...</body></html>');
    },
    onEvent: evento => eventos.push(evento)
  });
  assert.ok(eventos.some(e => e.stage === 'player-failed'), 'debe informar el fallo del player');
  const pistas = eventos.find(e => e.stage === 'pistas');
  assert.equal(pistas.total, 1);
  assert.deepEqual(streams, []);
});
