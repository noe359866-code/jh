const crypto = require('node:crypto');

// Helpers de descifrado usados por los resolvedores de reproductores.
// VOE cifra la fuente con AES-128-CBC; Vidsrc.to usa RC4. Nada de JS,
// cookies o CAPTCHA: solo descifrado de payloads ya visibles en la página.

function rc4(key, data) {
  const keyBytes = Buffer.from(key, 'utf8');
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
  }
  const out = Buffer.from(data);
  let i = 0; j = 0;
  for (let k = 0; k < out.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
    out[k] ^= s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

// Descifra un payload AES-128-CBC (base64) con la clave y el IV dados.
function aesCbcDecrypt(key, iv, encryptedBase64) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()]).toString('utf8');
}

// Extrae la cadena cifrada de una página VOE: prioriza el script JSON,
// luego el regex que busca la variable con el payload.
function encontrarCifrado(html) {
  const script = html.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (script && script[1]) return script[1].trim();
  const regex = /["']([A-Za-z0-9+/=]{40,})["']/;
  const match = html.match(regex);
  return match ? match[1] : null;
}

module.exports = { rc4, aesCbcDecrypt, encontrarCifrado };
