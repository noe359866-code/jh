const { createFetcher } = require('./extractor');
const { buscarPistasReproductor, diagnosticarPagina } = require('./pistas');

// ---------------------------------------------------------------------------
// Proveedor Gnula (WordPress + API propia del tema)
// ---------------------------------------------------------------------------
//
// La ficha (`/ver/<slug>/`) NO publica iframes de reproductor: el tema entrega
// la lista de servidores por su propia API REST y la descifra en el navegador.
// El flujo real, leído de su código (sin ejecutarlo), es:
//
//   1. La ficha declara `var _gnrdPid=<id>,_gnrdTok="<token>";`.
//   2. El cliente hace `fetch(<prefijo> + _gnrdPid + <sufijo> + token)`, donde
//      prefijo y sufijo son dos literales del propio tema.
//   3. La respuesta es `{ "p": "<base64>" }`.
//   4. `gnrdUnpack` (215 B) hace: atob → XOR con la clave de 4 bytes
//      [103,78,55,100] → JSON:
//
//        { t, langs: [ { label, flag, servers: [ { title, src } ] } ], dl: [ … ] }
//
// Aquí los pasos 1-4 se replican en Node: base64 con Buffer y XOR en un bucle.
// No se ejecuta nada del sitio, no hay captcha ni DRM, y cada `src` se pasa al
// registry como cualquier otro embed.
//
// Si el tema cambia (no hay `_gnrdPid`, el payload no descifra o no trae JSON)
// no se inventa nada: se cae al descubrimiento genérico de pistas del HTML y,
// si tampoco hay, se emite la forma de la página para poder ajustarlo.

// Clave del decodificador del tema. No es un secreto (está en su JS público) y
// se puede sobreescribir con GNULA_XOR si el sitio la rota.
const CLAVE_XOR = [103, 78, 55, 100];

function claveXor(entorno = process.env) {
  const crudo = String(entorno.GNULA_XOR || '').split(',').map(Number);
  const valida = crudo.length >= 2 && crudo.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  return valida ? crudo : CLAVE_XOR;
}

// atob + XOR + JSON, en memoria. Devuelve null si el payload no es válido.
function desempacar(payload, clave = CLAVE_XOR) {
  if (typeof payload !== 'string' || !payload) return null;
  let crudo;
  try { crudo = Buffer.from(payload, 'base64'); } catch { return null; }
  if (!crudo.length) return null;
  const claro = Buffer.alloc(crudo.length);
  for (let i = 0; i < crudo.length; i++) claro[i] = crudo[i] ^ clave[i % clave.length];
  try {
    const datos = JSON.parse(claro.toString('utf8'));
    return datos && typeof datos === 'object' ? datos : null;
  } catch { return null; }
}

// Datos del player en la ficha: id, token y los literales que arman la URL.
function leerPlayer(html) {
  const pid = /\b_gnrdPid\s*=\s*(\d+)/.exec(html);
  const tok = /\b_gnrdTok\s*=\s*["']([^"']+)["']/.exec(html);
  const llamada = /fetch\(\s*(["'])([^"']*)\1\s*\+\s*_gnrdPid\s*\+\s*(["'])([^"']*)\3/.exec(html);
  if (!pid || !tok || !llamada) return null;
  return { id: pid[1], token: tok[1], prefijo: llamada[2], sufijo: llamada[4] };
}

// Lista normalizada de servidores a partir del payload descifrado.
function leerServidores(datos) {
  const servidores = [];
  for (const idioma of (datos && datos.langs) || []) {
    const etiquetaIdioma = String(idioma.label || '').trim();
    for (const servidor of idioma.servers || []) {
      const url = String(servidor.src || '');
      if (!/^https?:\/\//i.test(url)) continue;
      const nombre = String(servidor.title || '').trim();
      servidores.push({
        idioma: etiquetaIdioma,
        servidor: nombre,
        url,
        etiqueta: [etiquetaIdioma, nombre].filter(Boolean).join(' · ')
      });
    }
  }
  return servidores;
}

const crearProveedorGnula = ({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent, entorno }) => {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({
    allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir
  });

  return {
    async descubrir(pageUrl) {
      const html = await fetcher.getText(pageUrl);
      const host = (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })();
      const { media } = fetcher.parsePage(html, pageUrl);

      const player = leerPlayer(html);
      emitir({ stage: 'gnula', host, pid: Boolean(player), token: Boolean(player && player.token) });

      let servidores = [];
      if (player) {
        // La URL se arma con los literales del tema, igual que su cliente.
        const url = new URL(`${player.prefijo}${player.id}${player.sufijo}${encodeURIComponent(player.token)}`, pageUrl).href;
        try {
          const crudo = await fetcher.getText(url, { Accept: 'application/json', Referer: pageUrl });
          const json = JSON.parse(crudo);
          const datos = desempacar(json && json.p, claveXor(entorno));
          if (!datos) {
            // Respuesta con forma inesperada o con la clave rotada: se informa
            // y se sigue por el HTML, sin inventar servidores.
            emitir({ stage: 'player-failed', host, error: 'payload no descifra' });
          }
          servidores = leerServidores(datos);
          emitir({
            stage: 'servidores', host, total: servidores.length,
            // Solo nombres de host: nunca las rutas de los enlaces.
            hosts: [...new Set(servidores.map(s => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return ''; } }))].slice(0, 12),
            descifrado: Boolean(datos), idiomas: datos && Array.isArray(datos.langs) ? datos.langs.length : 0
          });
        } catch (error) {
          emitir({ stage: 'player-failed', host, error: error.message });
        }
      }

      if (servidores.length) return { reproductor: servidores[0].url, media, servidores };

      // Sin API utilizable: lo que sí sea legible en el HTML (iframes de
      // players, data-*). Un tráiler de YouTube no cuenta como reproductor.
      const pistas = buscarPistasReproductor(html, pageUrl);
      const jugadores = pistas.pistas.filter(pista => pista.jugador);
      emitir({ stage: 'pistas', host, total: jugadores.length, idiomas: pistas.idiomas, servidores: pistas.servidores, otrosFrames: pistas.pistas.length - jugadores.length });
      if (!jugadores.length) {
        emitir({ stage: 'sin-pistas', host, ...diagnosticarPagina(html, pageUrl) });
        return { reproductor: null, media, servidores: [] };
      }
      return {
        reproductor: jugadores[0].url,
        media,
        servidores: jugadores.map(pista => ({
          idioma: pista.idioma, servidor: pista.nombre, url: pista.url, etiqueta: pista.etiqueta
        }))
      };
    }
  };
};

module.exports = { crearProveedorGnula, desempacar, leerPlayer, leerServidores, claveXor, CLAVE_XOR };
