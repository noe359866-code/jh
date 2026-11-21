const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearRegistry } = require('../engines/resolvers');
const { crearResolvedorVoe } = require('../engines/resolvers/voe');
const { rc4, aesCbcDecrypt } = require('../engines/resolvers/crypto');

const lookupImpl = async () => [{ address: '93.184.216.34' }];

// AES-128-CBC sin padding automático: el payload debe ser múltiplo de 16.
function cifrarAes(clave, iv, texto) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(clave), Buffer.from(iv));
  cipher.setAutoPadding(false);
  let data = Buffer.from(texto, 'utf8');
  if (data.length % 16) data = Buffer.concat([data, Buffer.alloc(16 - (data.length % 16))]);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
}

test('registry asigna el resolvedor correcto por dominio', () => {
  const registry = crearRegistry({ allowedHosts: [] });
  assert.equal(registry.encontrarResolvedor('https://voe.sx/e/abc').nombre, 'VOE');
  assert.equal(registry.encontrarResolvedor('https://streamtape.com/c/xyz').nombre, 'Streamtape');
  assert.equal(registry.encontrarResolvedor('https://vidsrc.to/embed/movie/1').nombre, 'Vidsrc.to');
  assert.equal(registry.encontrarResolvedor('https://otro.example/player').nombre, 'Genérico');
});

test('resolvedor genérico verifica un .m3u8 directo', async () => {
  const registry = crearRegistry({
    allowedHosts: ['cdn.example'],
    lookupImpl,
    fetchImpl: async () => new Response('#EXTM3U\n#EXT-X-VERSION:3\n')
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
      if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n');
      return new Response(html);
    }
  });
  const streams = await resolvedor.resolver('https://voe.sx/e/abc');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, fuente);
  assert.equal(streams[0].nombre, 'VOE');
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
