const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearRegistry, hostsReproductores } = require('../engines/resolvers');
const { crearResolvedorVoe, VOE_KEY_POR_DEFECTO, VOE_IV_POR_DEFECTO } = require('../engines/resolvers/voe');
const { crearResolvedorStreamtape, extraerBotlink, construirGetVideo } = require('../engines/resolvers/streamtape');
const { crearResolvedorVidsrc } = require('../engines/resolvers/vidsrc');
const { rc4, aesCbcDecrypt } = require('../engines/resolvers/crypto');

const lookupImpl = async () => [{ address: '93.184.216.34' }];
const HLS = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8\n';

// AES-128-CBC sin padding automático: el payload debe ser múltiplo de 16.
function cifrarAes(clave, iv, texto) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(clave), Buffer.from(iv));
  cipher.setAutoPadding(false);
  let data = Buffer.from(texto, 'utf8');
  if (data.length % 16) data = Buffer.concat([data, Buffer.alloc(16 - (data.length % 16))]);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
}

test('registry asigna el resolvedor correcto por dominio y alias', () => {
  const registry = crearRegistry({ allowedHosts: [] });
  assert.equal(registry.encontrarResolvedor('https://voe.sx/e/abc').nombre, 'VOE');
  assert.equal(registry.encontrarResolvedor('https://streamtape.com/c/xyz').nombre, 'Streamtape');
  assert.equal(registry.encontrarResolvedor('https://vidsrc.to/embed/movie/1').nombre, 'Vidsrc.to');
  assert.equal(registry.encontrarResolvedor('https://otro.example/player').nombre, 'Genérico');
  // Los alias declarados antes se ignoraban (se comparaban como URL completa).
  assert.equal(registry.encontrarResolvedor('https://jilliandescribecompany.com/e/1').nombre, 'VOE');
  assert.equal(registry.encontrarResolvedor('https://goofy-banana.com/e/1').nombre, 'VOE');
  assert.equal(registry.encontrarResolvedor('https://streamta.site/e/1').nombre, 'Streamtape');
  assert.equal(registry.encontrarResolvedor('https://vidsrc.net/embed/1').nombre, 'Vidsrc.to');
  // Un host que solo contiene el dominio como sufijo no coincide.
  assert.equal(registry.encontrarResolvedor('https://voe.sx.example.com/e/1').nombre, 'Genérico');
});

test('los resolvedores autorizan sus propios dominios sin abrir el resto de internet', () => {
  const hosts = hostsReproductores();
  assert.ok(hosts.includes('voe.sx'));
  assert.ok(hosts.includes('streamtape.com'));
  assert.ok(!hosts.includes('cdn.evil.example'));
});

test('resolvedor genérico verifica un .m3u8 directo', async () => {
  const registry = crearRegistry({
    allowedHosts: ['cdn.example'],
    lookupImpl,
    fetchImpl: async () => new Response(HLS)
  });
  const streams = await registry.resolver('https://cdn.example/a.m3u8');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn.example/a.m3u8');
});

test('resolvedor VOE descifra el payload AES y devuelve la fuente', async () => {
  const clave = '0123456789abcdef';
  const iv = 'abcdef9876543210';
  const fuente = 'https://voe.sx/stream/master.m3u8';
  const json = JSON.stringify({ source: fuente, captions: [] });
  const encrypted = cifrarAes(clave, iv, json);
  const html = `<html><script type="application/json">${encrypted}</script></html>`;
  const resolvedor = crearResolvedorVoe({
    allowedHosts: ['voe.sx'],
    clave, iv,
    lookupImpl,
    fetchImpl: async url => {
      if (url.pathname.endsWith('.m3u8')) return new Response(HLS);
      return new Response(html);
    }
  });
  const streams = await resolvedor.resolver('https://voe.sx/e/abc');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, fuente);
  assert.equal(streams[0].nombre, 'VOE');
});

test('VOE usa sus claves públicas por defecto (VOE_KEY/VOE_IV eran decorativas)', async () => {
  // El README prometía claves configurables, pero nada las leía ni había valor
  // por defecto: sin ellas el resolvedor era un barrido literal.
  assert.equal(Buffer.byteLength(VOE_KEY_POR_DEFECTO), 16);
  assert.equal(Buffer.byteLength(VOE_IV_POR_DEFECTO), 16);
  const fuente = 'https://voe.sx/hls/master.m3u8';
  const cifrado = cifrarAes(VOE_KEY_POR_DEFECTO, VOE_IV_POR_DEFECTO, JSON.stringify({ source: fuente }));
  const resolvedor = crearResolvedorVoe({
    allowedHosts: ['voe.sx'], lookupImpl,
    fetchImpl: async url => new Response(url.pathname.endsWith('.m3u8') ? HLS : `<script type="application/json">"${cifrado}"</script>`)
  });
  const streams = await resolvedor.resolver('https://voe.sx/e/abc');
  assert.deepEqual(streams.map(s => s.url), [fuente]);
});

test('VOE acepta JSON en claro y variantes /hls/master.txt', async () => {
  const resolvedor = crearResolvedorVoe({
    allowedHosts: ['voe.sx'], lookupImpl,
    fetchImpl: async url => {
      if (url.pathname.endsWith('master.txt')) return new Response('<html>404</html>');
      if (url.pathname.endsWith('.m3u8')) return new Response(HLS);
      return new Response('<script type="application/json">{"source":"https://voe.sx/hls/master.txt"}</script>');
    }
  });
  const streams = await resolvedor.resolver('https://voe.sx/e/claro');
  assert.deepEqual(streams.map(s => s.url), ['https://voe.sx/hls/master.m3u8']);
});

test('rc4 descifra un payload conocido', () => {
  const key = 'secret';
  const plaintext = 'https://vidsrc.to/media.m3u8';
  const encrypted = rc4(key, Buffer.from(plaintext));
  const decrypted = rc4(key, encrypted).toString('utf8');
  assert.equal(decrypted, plaintext);
});

test('aesCbcDecrypt revierte el cifrado AES-128-CBC', () => {
  const clave = '0123456789abcdef';
  const iv = 'abcdef9876543210';
  const plaintext = 'https://example.com/a.m3u8';
  const encrypted = cifrarAes(clave, iv, plaintext);
  const decrypted = aesCbcDecrypt(clave, iv, encrypted);
  // El padding manual (bytes nulos) se stripea al comparar.
  assert.equal(decrypted.replace(/\x00+$/, ''), plaintext);
});

test('Streamtape construye get_video sin barras duplicadas y sigue el 302', async () => {
  const html = `<script>document.getElementById('botlink').innerHTML = 'https://streamtape.com/get_video' + ('&id=AAA&expires=1&ip=1.2.3.4&token=TT').substring(0);</script>`;
  const pedidos = [];
  const resolvedor = crearResolvedorStreamtape({
    allowedHosts: ['streamtape.com'], lookupImpl,
    fetchImpl: async (url, opciones) => {
      pedidos.push(url.toString());
      if (url.pathname === '/get_video') {
        assert.equal(opciones.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: 'https://streamtape.com/v/AAA.mp4' } });
      }
      if (url.pathname === '/v/AAA.mp4') return new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
      return new Response(html);
    }
  });
  const streams = await resolvedor.resolver('https://streamtape.com/e/AAA');
  assert.deepEqual(streams.map(s => s.url), ['https://streamtape.com/v/AAA.mp4']);
  // La URL pedida tenía "streamtape.com/get_video" y antes generaba una ruta mal formada.
  assert.ok(pedidos.includes('https://streamtape.com/get_video?id=AAA&expires=1&ip=1.2.3.4&token=TT&stream=1'));
});

test('Streamtape nunca devuelve la URL get_video (no es reproducible) cuando el 302 falla', async () => {
  const html = `<script>document.getElementById('botlink').innerHTML = 'https://streamtape.com/get_video' + ('&id=A&expires=1&ip=1.1.1.1&token=T').substring(0);</script>`;
  const resolvedor = crearResolvedorStreamtape({
    allowedHosts: ['streamtape.com'], lookupImpl,
    fetchImpl: async (url) => {
      if (url.pathname === '/get_video') throw new Error('redirect blocked');
      return new Response(html);
    }
  });
  assert.deepEqual(await resolvedor.resolver('https://streamtape.com/e/A'), []);
});

test('Streamtape resuelve la base relativa del script contra la página', () => {
  const partes = { base: '/streamtape.com/get_video', id: 'A', expires: '1', ip: '1.1.1.1', token: 'T' };
  assert.equal(construirGetVideo('https://streamtape.com/e/A', partes),
    'https://streamtape.com/streamtape.com/get_video?id=A&expires=1&ip=1.1.1.1&token=T&stream=1');
  // Base absoluta sin barra final: no debe generar una ruta inventada.
  assert.equal(construirGetVideo('https://streamtape.com/e/A', { ...partes, base: 'https://streamtape.com/get_video' }),
    'https://streamtape.com/get_video?id=A&expires=1&ip=1.1.1.1&token=T&stream=1');
  assert.equal(extraerBotlink(`<script>document.getElementById('botlink').innerHTML = '' + ('&id=A&expires=1&ip=1.1.1.1&token=T').substring(0)</script>`).id, 'A');
});

test('Vidsrc descifra con la clave COMPLETA y usa el mediaId en la API', async () => {
  // Antes: rc4(claves.decrypt[0], ...) usaba el primer carácter como clave.
  const clave = 'clave-secreta-16';
  const urlMedia = 'https://cdn.vidsrc.example/a.m3u8';
  const payload = rc4(clave, Buffer.from(urlMedia)).toString('base64');
  const pedidos = [];
  const resolvedor = crearResolvedorVidsrc({
    allowedHosts: ['vidsrc.to', 'cdn.vidsrc.example'], lookupImpl,
    claves: { encrypt: 'x'.repeat(16), decrypt: clave },
    fetchImpl: async (url) => {
      pedidos.push(url.pathname);
      if (url.pathname === '/rcp/12345') {
        return new Response(JSON.stringify([{ id: 'file', url: payload }]), { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('.m3u8')) return new Response(HLS);
      return new Response('<ul><li class="episode"><a data-id="12345">1</a></li></ul>');
    }
  });
  const streams = await resolvedor.resolver('https://vidsrc.to/embed/movie/tt1');
  assert.deepEqual(streams.map(s => s.url), [urlMedia]);
  assert.ok(pedidos.includes('/rcp/12345'), 'la API de fuentes debe recibir el mediaId');
  // La página se descarga una sola vez (antes se pedía dos veces).
  assert.equal(pedidos.filter(p => p === '/embed/movie/tt1').length, 1);
});

test('Vidsrc delega en otro reproductor y no entra en recursión infinita', async () => {
  const clave = 'clave-secreta-16';
  const embed = 'https://voe.sx/e/delegado';
  const payload = rc4(clave, Buffer.from(embed)).toString('base64');
  const registry = crearRegistry({
    allowedHosts: ['voe.sx'], lookupImpl,
    vidsrcKeys: { encrypt: 'x'.repeat(16), decrypt: clave },
    fetchImpl: async (url) => {
      if (url.pathname === '/rcp/999') return new Response(JSON.stringify([{ url: payload }]), { headers: { 'content-type': 'application/json' } });
      if (url.hostname === 'voe.sx' && url.pathname === '/e/delegado') {
        return new Response('<script type="application/json">{"source":"https://voe.sx/hls/master.m3u8"}</script>');
      }
      if (url.pathname.endsWith('.m3u8')) return new Response(HLS);
      return new Response('<ul><li class="episode"><a data-id="999">1</a></li></ul>');
    }
  });
  const streams = await registry.resolver('https://vidsrc.to/embed/movie/tt1');
  assert.deepEqual(streams.map(s => s.url), ['https://voe.sx/hls/master.m3u8']);
});

test('sigue el redirector JS de Voe solo hacia sus mirrors declarados', async () => {
  // En vivo Voe responde "Redirecting..." hacia un mirror. Se lee el destino
  // (sin ejecutar JS) y se sigue una vez, pero solo si es un mirror del código.
  const { destinoDeRedirector, seguirRedirector } = require('../engines/resolvers/redirector');
  const redirector = '<title>Redirecting...</title><script>const currentUrl = new URL(window.location.href);' +
    ' currentUrl.host = "caseyseemavoid.com"; location.href = currentUrl.toString();</script>';
  assert.equal(destinoDeRedirector(redirector, 'https://voe.sx/e/abc'), 'https://caseyseemavoid.com/e/abc');
  // Una página de player normal no es un redirector.
  assert.equal(destinoDeRedirector('<title>Player</title><video src="a.mp4">', 'https://voe.sx/e/x'), null);

  const pedidos = [];
  const fetcher = {
    getText: async (url) => {
      pedidos.push(String(url));
      return '<script>{"source":"https://voe.sx/hls/master.m3u8"}</script>';
    }
  };
  const eventos = [];
  const html = await seguirRedirector({
    fetcher, html: redirector, link: 'https://voe.sx/e/abc',
    alias: ['voe.sx', 'caseyseemavoid.com'], emitir: (e) => eventos.push(e)
  });
  assert.match(html, /master\.m3u8/);
  assert.deepEqual(pedidos, ['https://caseyseemavoid.com/e/abc']);
  assert.ok(eventos.some(e => e.stage === 'redirector'));

  // Hacia un host ajeno no se sigue: ni petición ni contenido.
  pedidos.length = 0;
  const ajeno = await seguirRedirector({
    fetcher, html: '<title>Redirecting...</title><script>location.href="https://atacante.example/x";</script>',
    link: 'https://voe.sx/e/abc', alias: ['voe.sx'], emitir: () => {}
  });
  assert.equal(ajeno, null);
  assert.deepEqual(pedidos, [], 'no debe pedir el host ajeno');
});
