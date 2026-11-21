// Fetch compartido para los resolvedores de reproductores. Re-expone el
// createFetcher de sites/extractor.js para que los resolvedores tengan la
// misma política de seguridad (HTTPS, destinos públicos, sin redirecciones).
const { createFetcher, parsePage } = require('../sites/extractor');
module.exports = { createFetcher, parsePage };
