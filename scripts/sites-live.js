// Intentionally outside test/: normal CI is deterministic and offline.
// Live verification for the direct site stream resolver. Requires outbound
// access to the target sites; the development sandbox only reaches GitHub and
// package registries, so this runs manually (or from GitHub Actions) where the
// network allows it. Scans every configured page URL and reports which sites
// returned verified HLS/MP4.
//
// Un reporte saneado (sin URLs, queries, HTML ni tokens) se escribe siempre en
// reports/sites-live.json. El proceso solo termina con código 0 si al menos un
// sitio devolvió un medio con firma válida.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolver, validarUrlSitio } = require('../engines/sites');

// Único sitio soportado: FlixLatam. Página de detalle real (las rutas de
// ejemplo devolvían 404 y la prueba nunca podía encontrar medios).
const DEFAULT_URLS = [
  'https://flixlatam.com/pelicula/patton'
];

function parseUrls(entorno = process.env) {
  const raw = (entorno.SITES_TEST_URLS || entorno.SITES_TEST_URL || '').trim();
  if (!raw) return DEFAULT_URLS;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Eventos permitidos en el reporte: solo etapa y host. Nunca paths, queries,
// HTML, cuerpos ni tokens.
function eventoSanitizado(evento) {
  const limpio = { stage: String(evento.stage || 'unknown') };
  if (evento.host) limpio.host = String(evento.host).toLowerCase();
  if (typeof evento.verified === 'boolean') limpio.verified = evento.verified;
  if (Number.isFinite(evento.candidates)) limpio.candidates = evento.candidates;
  if (Number.isFinite(evento.frames)) limpio.frames = evento.frames;
  if (evento.error) limpio.error = String(evento.error).slice(0, 200);
  // Diagnóstico booleano de Embed69 (nunca contenido de la página).
  for (const clave of ['dataLink', 'challenge', 'salt', 'anubisPendiente', 'anubisPasado', 'captcha', 'bloqueado']) {
    if (typeof evento[clave] === 'boolean') limpio[clave] = evento[clave];
  }
  if (Number.isFinite(evento.bytes)) limpio.bytes = evento.bytes;
  if (Number.isFinite(evento.nonce)) limpio.nonce = evento.nonce;
  if (evento.algorithm) limpio.algorithm = String(evento.algorithm).slice(0, 20);
  return limpio;
}

async function main(report) {
  const urls = parseUrls();
  assert.ok(urls.length, 'Set SITES_TEST_URLS (or SITES_TEST_URL) with at least one site page URL');
  const hostsVistos = new Set();
  let anyVerified = false;

  for (const pageUrl of urls) {
    const entry = {
      site: null, host: null, success: false, verifiedMedia: 0, error: null,
      pages: 0, candidates: 0, frames: 0, verified: 0, blockedHosts: [], stages: {}
    };
    try {
      // Validar antes de cualquier petición de red para fallar rápido.
      const { url, proveedor } = validarUrlSitio(pageUrl);
      entry.site = proveedor.clave;
      entry.host = url.hostname;
      const streams = await resolver({ url: pageUrl }, {
        onEvent: evento => {
          const limpio = eventoSanitizado(evento);
          if (limpio.host) hostsVistos.add(limpio.host);
          // Conteos por sitio: explican si falló el acceso, el análisis del
          // HTML o la verificación de los candidatos.
          if (limpio.stage === 'page') {
            entry.pages++;
            entry.candidates += limpio.candidates || 0;
            entry.frames += limpio.frames || 0;
          }
          if (limpio.stage === 'candidate' && limpio.verified) entry.verified++;
          if ((limpio.stage === 'blocked-frame' || limpio.stage === 'blocked-host') && limpio.host
            && !entry.blockedHosts.includes(limpio.host)) entry.blockedHosts.push(limpio.host);
          if (limpio.host) {
            const clave = limpio.stage === 'page' ? 'pages' : limpio.stage;
            entry.stages[clave] = entry.stages[clave] || [];
            if (!entry.stages[clave].includes(limpio.host)) entry.stages[clave].push(limpio.host);
          }
          if (report.events.length < 200) report.events.push({ ...limpio, site: proveedor.clave });
        }
      });
      entry.success = streams.length > 0;
      entry.verifiedMedia = streams.length;
      if (streams.length) anyVerified = true;
      console.log(`${proveedor.clave}: ${streams.length ? `${streams.length} verified HLS/MP4 response(s)` : 'no verified HLS/MP4 found'}`);
    } catch (error) {
      entry.error = error.message;
      console.error(`${entry.host || pageUrl}: failed - ${error.message}`);
    }
    report.tested.push(entry);
  }

  // Resumen de hosts para diagnosticar allowlists (solo nombres de host).
  report.hosts = [...hostsVistos].sort();
  report.success = anyVerified;
  const winners = report.tested.filter(entry => entry.success).map(entry => entry.site);
  console.log(winners.length
    ? `Verified HLS/MP4 on: ${winners.join(', ')}. This is not a full playback test.`
    : 'No site returned verified HLS/MP4. Inspect the sanitized report (events/hosts) for blocked or failed hosts.');
  console.log(`Wrote sanitized report to reports/sites-live.json`);

  if (!anyVerified) {
    // Se distingue fallo de validación/red de un simple "sin medios": el código
    // de salida lo refleja para que CI no reporte un éxito falso.
    const fallos = report.tested.filter(entry => entry.error);
    if (fallos.length) console.error(`${fallos.length} site(s) failed before or during extraction.`);
    process.exitCode = 1;
  }
}

// El reporte se escribe siempre (también en fallo de validación o de red),
// pero nunca se presenta como éxito si no hubo medios verificados.
(function ejecutar() {
  const report = { startedAt: new Date().toISOString(), success: false, tested: [], events: [] };
  const escribir = () => {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/sites-live.json', JSON.stringify(report, null, 2) + '\n');
  };
  main(report).catch(error => {
    report.error = String(error.message).slice(0, 200);
    console.error(error.message);
    process.exitCode = 1;
  }).finally(escribir);
})();
