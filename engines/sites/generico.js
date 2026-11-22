const { createFetcher } = require('./extractor');
const { buscarPistasReproductor, diagnosticarPagina } = require('./pistas');

// ---------------------------------------------------------------------------
// Proveedor genérico (sitios WordPress con modal de reproducción)
// ---------------------------------------------------------------------------
//
// Gnula es un WordPress con tema propio. Su ficha tiene:
//
//   1. Un modal "Haz clic para reproducir" con selector de **Audio**
//      (Latino/Subtitulado) y de **Servidor** (1..4).
//   2. Los reproductores NO son iframes en el HTML: se inyectan al pulsar,
//      así que aquí se buscan todas las pistas legibles (iframe, enlaces a
//      players, `data-*`, JSON de WordPress) y se devuelven las que hay.
//   3. Cada pista se pasa al registry: si alguna es un embed de un player
//      conocido (Streamwish, Vidhide, Filemoon...), se resuelve igual que en
//      FlixLatam.
//
// Cuando no hay ninguna pista legible se informa exactamente qué se encontró
// (formularios, scripts, endpoints de admin-ajax) en vez de devolver vacío a
// secas: así se puede ajustar sin adivinar.

const crearProveedorGenerico = ({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent }) => {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({
    allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir
  });

  return {
    // Devuelve { reproductor, media, servidores }: la primera página de player,
    // los medios literales y las pistas de reproductor con su etiqueta.
    async descubrir(pageUrl) {
      const html = await fetcher.getText(pageUrl);
      const { media } = fetcher.parsePage(html, pageUrl);
      const { pistas, idiomas, servidores } = buscarPistasReproductor(html, pageUrl);
      // Solo sirven las pistas de hosts de reproductor conocidos. Un tráiler de
      // YouTube en la ficha es un iframe más: no es un reproductor del sitio.
      const jugadores = pistas.filter(pista => pista.jugador);

      emitir({
        stage: 'pistas', host: new URL(pageUrl).hostname,
        total: jugadores.length, idiomas, servidores,
        otrosFrames: pistas.length - jugadores.length
      });

      if (!jugadores.length) {
        // Nada utilizable: se informa la forma de la página (nombres de
        // etiqueta, formularios, endpoints, acciones e ids del tema). Nunca
        // contenido ni valores de atributo.
        const diagnostico = diagnosticarPagina(html, pageUrl);
        emitir({ stage: 'sin-pistas', host: new URL(pageUrl).hostname, ...diagnostico });
      }

      return {
        reproductor: jugadores[0] ? jugadores[0].url : null,
        media,
        servidores: jugadores.map(pista => ({
          idioma: pista.idioma || '',
          servidor: pista.nombre,
          url: pista.url,
          etiqueta: pista.etiqueta,
          referer: pista.referer || pageUrl
        }))
      };
    }
  };
};

module.exports = { crearProveedorGenerico };
