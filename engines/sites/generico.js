const { createFetcher } = require('./extractor');
const { buscarPistasReproductor, diagnosticarPagina, hostsDeReproductor } = require('./pistas');

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

      emitir({
        stage: 'pistas', host: new URL(pageUrl).hostname,
        total: pistas.length, idiomas: idiomas.length, servidores: servidores.length
      });

      if (!pistas.length) {
        // Sin pistas: se informa la forma de la página (nombres de etiqueta,
        // formularios, endpoints y scripts del propio sitio). Nunca contenido.
        const diagnostico = diagnosticarPagina(html, pageUrl);
        emitir({ stage: 'sin-pistas', host: new URL(pageUrl).hostname, ...diagnostico });
      }

      // Las pistas de hosts de reproductor ya autorizados se resuelven primero:
      // son las que el registry puede convertir en HLS/MP4.
      const dePlayer = pistas.filter(pista => hostsDeReproductor.includes(new URL(pista.url).hostname));
      const ordenadas = [...dePlayer, ...pistas.filter(pista => !dePlayer.includes(pista))];

      return {
        reproductor: ordenadas[0] ? ordenadas[0].url : null,
        media,
        servidores: ordenadas.map(pista => ({
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
