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

// AES-256-CBC con la clave derivada (SHA-256 de challenge+salt) y el IV en los
// 16 primeros bytes del propio base64. Es el esquema de Embed69.
function aesCbcDecryptIvIncluido(key, encryptedBase64) {
  const raw = Buffer.from(encryptedBase64.replace(/\s+/g, ''), 'base64');
  if (raw.length <= 16) return null;
  const decipher = crypto.createDecipheriv('aes-256-cbc', normalizarClave(key).subarray(0, 32), raw.subarray(0, 16));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}

// Clave de Embed69: SHA-256(LINK_CHALLENGE + LINK_SALT).
function claveEmbed69(challenge, salt) {
  return crypto.createHash('sha256').update(String(challenge) + String(salt), 'utf8').digest();
}

// Proof of work de Anubis: el hash SHA-256(randomData + nonce) debe empezar por
// `difficulty` NIBBLES a cero, es decir `difficulty` caracteres hexadecimales
// '0' (la implementación de referencia usa difficulty/2 bytes + medio byte: 8
// significa '00' al inicio, no cuatro bytes). Devuelve { hash, nonce } o null
// si se agota el presupuesto de intentos.
function resolverAnubis(randomData, difficulty, { maxIntentos = 5_000_000 } = {}) {
  const nibbles = Math.max(0, Math.floor(Number(difficulty) || 0));
  const bytesLlenos = Math.floor(nibbles / 2);
  const medioByte = nibbles % 2 !== 0;
  const datos = String(randomData);
  for (let nonce = 0; nonce < maxIntentos; nonce++) {
    const digest = Uint8Array.from(crypto.createHash('sha256').update(datos + nonce, 'utf8').digest());
    let valido = true;
    for (let i = 0; i < bytesLlenos; i++) {
      if (digest[i] !== 0) { valido = false; break; }
    }
    if (valido && medioByte && (digest[bytesLlenos] >> 4) !== 0) valido = false;
    if (valido) return { hash: Buffer.from(digest).toString('hex'), nonce };
  }
  return null;
}

// Comprueba un resultado de PoW sin resolverlo (para tests y para validar).
function verificarAnubis(randomData, difficulty, nonce, hashEsperado) {
  const nibbles = Math.max(0, Math.floor(Number(difficulty) || 0));
  const hex = crypto.createHash('sha256').update(String(randomData) + nonce, 'utf8').digest('hex');
  return hex.startsWith('0'.repeat(nibbles)) && (!hashEsperado || hex === hashEsperado);
}

module.exports = {
  rc4, aesCbcDecrypt, aesCbcDecryptRaw, quitarRelleno, normalizarClave, encontrarCifrado,
  aesCbcDecryptIvIncluido, claveEmbed69, resolverAnubis, verificarAnubis
};
