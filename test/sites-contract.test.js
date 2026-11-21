const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp, credencialesResolvedores } = require('../index');

async function servidor(t, sites) {
  const app = createApp({ streams: {}, sites });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('el endpoint publica los streams con claves de Stremio y descarta URLs inválidas', async t => {
  const base = await servidor(t, {
    resolve: async () => [
      { nombre: 'FlixLatam', titulo: 'Latino', url: 'https://cdn.example/a.m3u8?token=1' },
      { nombre: 'FlixLatam', url: 'https://cdn.example/b.mp4' },
      { nombre: 'Roto', url: 'javascript:alert(1)' },
      { nombre: 'Sin URL' }
    ]
  });
  const { streams } = await (await fetch(base + '/stream/site?url=https://flixlatam.com/watch/x')).json();
  assert.deepEqual(streams, [
    { name: 'FlixLatam', title: 'Latino', url: 'https://cdn.example/a.m3u8?token=1' },
    { name: 'FlixLatam', title: 'HLS / MP4', url: 'https://cdn.example/b.mp4' }
  ]);
});

test('el endpoint pasa las credenciales de los resolvedores al proveedor', async t => {
  let recibido;
  const base = await servidor(t, {
    resolve: async request => { recibido = request; return []; }
  });
  const previas = { ...process.env };
  process.env.VOE_KEY = 'clave-de-16-byte';
  process.env.VOE_IV = 'iv-de-16-bytes!';
  process.env.VIDSRC_KEYS = 'enc:dec';
  try {
    await fetch(base + '/stream/site?url=https://flixlatam.com/watch/x');
  } finally {
    for (const clave of ['VOE_KEY', 'VOE_IV', 'VIDSRC_KEYS']) {
      if (previas[clave] === undefined) delete process.env[clave]; else process.env[clave] = previas[clave];
    }
  }
  assert.equal(recibido.url, 'https://flixlatam.com/watch/x');
  assert.deepEqual(recibido.vidsrcKeys, { encrypt: 'enc', decrypt: 'dec' });
  assert.equal(recibido.voeKey, 'clave-de-16-byte');
  assert.equal(recibido.voeIv, 'iv-de-16-bytes!');
});

test('sin variables de entorno no se inventan credenciales', () => {
  assert.deepEqual(credencialesResolvedores({}), {});
  assert.deepEqual(credencialesResolvedores({ VOE_KEY: '', VOE_IV: '', VIDSRC_KEYS: 'solo-una-parte' }), {});
});

test('una extracción fallida no devuelve claves en español ni datos internos', async t => {
  const base = await servidor(t, { resolve: async () => { throw new Error('boom interno'); } });
  const respuesta = await fetch(base + '/stream/site?url=https://flixlatam.com/pelicula/x');
  assert.equal(respuesta.status, 502);
  const cuerpo = await respuesta.json();
  assert.deepEqual(cuerpo, { error: 'Extracción de stream del sitio fallida' });
  assert.doesNotMatch(JSON.stringify(cuerpo), /boom/);
});
