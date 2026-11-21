const crypto = require('node:crypto');

// Helpers de descifrado usados por los resolvedores de reproductores.
// VOE cifra la fuente con AES-128-CBC; Vidsrc.to usa RC4. Nada de JS,
// cookies o CAPTCHA: solo descifrado de payloads ya visibles en la página.

function rc4(key, data) {
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
  if (!keyBytes.length) throw new Error('Clave RC4 vacía');
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

function normalizarClave(valor) {
  if (Buffer.isBuffer(valor)) return valor;
  if (Array.isArray(valor)) return Buffer.from(valor.map(b => Number(b) & 0xff));
  return Buffer.from(String(valor), 'utf8');
}

// Descifra un payload AES-128-CBC (base64) sin quitar relleno: el llamador
// decide si acepta PKCS#7 nativo o el relleno manual con ceros.
function aesCbcDecryptRaw(key, iv, encryptedBase64) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', normalizarClave(key), normalizarClave(iv));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()]);
}

// Quita relleno PKCS#7 o ceros finales, en ese orden.
function quitarRelleno(texto) {
  const sinCeros = texto.replace(/\x00+$/, '');
  const ultimo = sinCeros.charCodeAt(sinCeros.length - 1);
  if (ultimo > 0 && ultimo <= 16 && sinCeros.length >= ultimo) {
    const relleno = sinCeros.slice(-ultimo);
    if ([...relleno].every(c => c.charCodeAt(0) === ultimo)) return sinCeros.slice(0, -ultimo);
  }
  return sinCeros;
}

// Descifra un payload AES-128-CBC (base64) con la clave y el IV dados.
function aesCbcDecrypt(key, iv, encryptedBase64) {
  return quitarRelleno(aesCbcDecryptRaw(key, iv, encryptedBase64).toString('utf8'));
}

// Extrae la cadena cifrada de una página VOE. Formatos conocidos:
//  - <script type="application/json">"<base64>"</script>  (payload entrecomillado)
//  - <script type="application/json">{"source":"<url>"}</script> (ya en claro)
//  - atributo data-* con el payload
//  - variable JS con un base64 largo
function encontrarCifrado(html) {
  const pagina = String(html);
  const deScript = (cuerpo) => {
    const texto = String(cuerpo).trim().replace(/^["']|["']$/g, '');
    if (texto.startsWith('{') || texto.startsWith('[')) {
      try {
        const datos = JSON.parse(texto);
        const fuente = datos.source || datos.file || (Array.isArray(datos) ? datos[0] : null);
        if (typeof fuente === 'string' && fuente) return { payload: fuente, yaDescifrado: true };
      } catch { /* no es JSON válido */ }
      return null;
    }
    return /^[A-Za-z0-9+/=]{40,}$/.test(texto) ? { payload: texto, yaDescifrado: false } : null;
  };

  for (const match of pagina.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const encontrado = deScript(match[1]);
    if (encontrado) return encontrado;
  }
  for (const match of pagina.matchAll(/\bdata-(?:payload|source|data|encrypted)\s*=\s*["']([A-Za-z0-9+/=]{40,})["']/gi)) {
    return { payload: match[1], yaDescifrado: false };
  }
  for (const match of pagina.matchAll(/["']([A-Za-z0-9+/=]{40,})["']/g)) {
    if (match[1].length % 4 === 0) return { payload: match[1], yaDescifrado: false };
  }
  return null;
}

module.exports = { rc4, aesCbcDecrypt, aesCbcDecryptRaw, quitarRelleno, normalizarClave, encontrarCifrado };
