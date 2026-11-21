const { createFetcher } = require('./extractor');
const { encontrarReproductor, abrirReproductor, leerServidores } = require('../embed69');

// ---------------------------------------------------------------------------
// Proveedor FlixLatam (tema Dooplay)
// ---------------------------------------------------------------------------
//
// Flujo real del sitio:
//
//   1. La ficha (`/pelicula/<slug>`, `/serie/<slug>`, `/anime/<slug>`) trae un
//      iframe con el reproductor: `/vidurl/<id>/` o directamente
//      `https://embed69.org/f/<id>/`.
//   2. Ese reproductor es una página de Embed69 con la lista de servidores
//      (Voe, Streamwish, Vidhide, Filemoon, Uqload...) cifrada con AES-256-CBC
//      y protegida con el proof of work de Anubis.
//   3. Cada servidor es un embed externo que resuelve el registry.
//
// Esto sustituye al barrido literal: FlixLatam no publica ninguna URL .m3u8 o
// .mp4 en su HTML, así que buscar extensiones en la página nunca funcionaba.

const IDIOMAS = { LAT: 'Latino', ESP: 'Español', SUB: 'Subtitulado' };

function nombreIdioma(codigo) {
  return IDIOMAS[String(codigo || '').toUpperCase()] || String(codigo || '');
}

const crearProveedorFlixLatam = ({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent }) => {
  const emitir = typeof onEvent === 'function' ? onEvent : () => {};
  const fetcher = createFetcher({
    allowedHosts, fetchImpl, lookupImpl, timeoutMs, deadlineMs, maxBytes, pageReferer, onEvent: emitir
  });

  return {
    // Devuelve [{ reproductor, media, servidores }]: la página del reproductor,
    // los medios directos que hubiera en ella y los servidores descifrados con
    // su idioma y nombre.
    async descubrir(pageUrl) {
      const html = await fetcher.getText(pageUrl);
      const reproductor = encontrarReproductor(html, pageUrl);
      emitir({ stage: 'flixlatam', host: new URL(pageUrl).hostname, reproductor: Boolean(reproductor) });

      // Medios directos que la ficha pudiera publicar (algunos títulos sí).
      const { media } = fetcher.parsePage(html, pageUrl);

      if (!reproductor) return { reproductor: null, media, servidores: [] };

      const htmlReproductor = await abrirReproductor(fetcher, reproductor, { referer: pageUrl, onEvent: emitir });
      const servidores = leerServidores(htmlReproductor);
      emitir({ stage: 'servidores', host: new URL(reproductor).hostname, total: servidores.length });
      const mediosReproductor = fetcher.parsePage(htmlReproductor, reproductor).media;

      return {
        reproductor,
        media: [...new Set([...media, ...mediosReproductor])],
        servidores: servidores.map(servidor => ({
          ...servidor,
          idioma: nombreIdioma(servidor.idioma),
          referer: reproductor
        }))
      };
    }
  };
};

module.exports = { crearProveedorFlixLatam, nombreIdioma };
