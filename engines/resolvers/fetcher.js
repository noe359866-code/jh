// Fetch compartido para los resolvedores de reproductores. Re-expone el
// createFetcher de sites/extractor.js para que los resolvedores tengan la
// misma política de seguridad (HTTPS, destinos públicos, sin redirecciones) y
// el mismo presupuesto de tiempo total (deadlineMs).
const { createFetcher, parsePage, firmaMedia } = require('../sites/extractor');
const { publicAddress, createPublicFetch } = require('../sites/network');
module.exports = { createFetcher, parsePage, firmaMedia, publicAddress, createPublicFetch };
