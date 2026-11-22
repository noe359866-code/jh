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

// Páginas de detalle reales (las rutas de ejemplo devolvían 404 y la prueba
// nunca podía encontrar medios). Se prueban todos los sitios soportados: una
// ficha de FlixLatam (Embed69) y una de Gnula (WordPress con modal).
const DEFAULT_URLS = [
  'https://flixlatam.com/pelicula/patton',
  'https://ww3.gnulahd.nu/ver/godzilla-minus-zero/'
];

// Espera entre reintentos tras un 403/429 (los sitios limitan ráfagas).
const esperar = ms => new Promise(r => setTimeout(r, ms));

// Presupuesto total de la extracción en vivo. Se puede bajar (tests de contrato)
// o subir (workflow) sin tocar el código; por defecto, holgado para el flujo
// real: ficha + Anubis (PoW y espera) + varios players con reintento.
function presupuesto(entorno = process.env) {
  const valor = Number(entorno.SITES_LIVE_BUDGET_MS);
  if (Number.isFinite(valor) && valor >= 2000) return valor;
  return 180000;
}

function parseUrls(entorno = process.env) {
  const raw = (entorno.SITES_TEST_URLS || entorno.SITES_TEST_URL || '').trim();
  if (!raw) return DEFAULT_URLS;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Campos saneados que puede llevar un evento del reporte. Es la lista única:
// el test de contrato la importa, así un diagnóstico nuevo no puede olvidarse.
const CAMPOS_SANEADOS = [
  'stage', 'host', 'site', 'verified', 'candidates', 'frames', 'error',
  // Embed69 / Anubis
  'dataLink', 'challenge', 'salt', 'anubisPendiente', 'anubisPasado', 'captcha',
  'bloqueado', 'packer', 'jwplayer', 'soloJs', 'sinCuerpo', 'bytes', 'nonce',
  'metodo', 'aviso', 'titulo', 'hacia', 'estado', 'cookies', 'auth',
  'capasPacker', 'capas', 'forma', 'cuerpo', 'rutas', 'api', 'scripts', 'total',
  'algorithm', 'intento',
  // Loader y verificación humana
  'fetch', 'xhr', 'atob', 'b64', 'eval', 'sha', 'ofuscado', 'literales',
  'proveedor', 'formulario',
  // Diagnóstico de sitios que inyectan el reproductor (Gnula)
  'idiomas', 'servidores', 'etiquetas', 'formularios', 'campos', 'endpoints',
  'acciones', 'ids', 'propio', 'otrosFrames'
];
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
  for (const clave of ['dataLink', 'challenge', 'salt', 'anubisPendiente', 'anubisPasado', 'captcha', 'bloqueado', 'packer', 'jwplayer', 'soloJs', 'sinCuerpo']) {
    if (typeof evento[clave] === 'boolean') limpio[clave] = evento[clave];
  }
  if (Number.isFinite(evento.bytes)) limpio.bytes = evento.bytes;
  if (Number.isFinite(evento.nonce)) limpio.nonce = evento.nonce;
  for (const clave of ['metodo', 'aviso', 'error', 'titulo', 'hacia']) if (evento[clave]) limpio[clave] = String(evento[clave]).slice(0, 120);
  for (const clave of ['estado', 'cookies', 'auth']) if (Number.isFinite(evento[clave]) || typeof evento[clave] === 'boolean') limpio[clave] = evento[clave];
  if (Number.isFinite(evento.candidatos)) limpio.candidatos = evento.candidatos;
  if (Number.isFinite(evento.capasPacker)) limpio.capasPacker = evento.capasPacker;
  // Página mínima redactada (sin URLs, rutas ni tokens): qué responde el player.
  if (typeof evento.cuerpo === 'string') limpio.cuerpo = String(evento.cuerpo).slice(0, 1200);
  // Rutas de API descubiertas en el loader (sin valores de parámetros).
  for (const clave of ['rutas', 'api']) {
    if (Array.isArray(evento[clave])) limpio[clave] = evento[clave].slice(0, 12).map(String);
  }
  if (Number.isFinite(evento.scripts)) limpio.scripts = evento.scripts;
  // Forma del loader (mecanismos y literales redactados, sin valores).
  // Verificación humana (captcha del player): se informa, no se resuelve.
  if (evento.stage === 'verificacion-humana') {
    for (const clave of ['proveedor', 'titulo']) if (evento[clave]) limpio[clave] = String(evento[clave]).slice(0, 120);
    if (typeof evento.formulario === 'boolean') limpio.formulario = evento.formulario;
    if (Number.isFinite(evento.bytes)) limpio.bytes = evento.bytes;
  }
  if (evento.stage === 'loader-forma') {
    for (const clave of ['fetch', 'xhr', 'atob', 'b64', 'eval', 'sha', 'ofuscado']) {
      if (typeof evento[clave] === 'boolean') limpio[clave] = evento[clave];
    }
    if (Number.isFinite(evento.bytes)) limpio.bytes = evento.bytes;
    if (Array.isArray(evento.literales)) limpio.literales = evento.literales.slice(0, 8).map(String);
  }
  if (Number.isFinite(evento.total)) limpio.total = evento.total;
  if (Number.isFinite(evento.otrosFrames)) limpio.otrosFrames = evento.otrosFrames;
  // Pistas y modal: solo los nombres (idiomas y números de servidor), no URLs.
  if (evento.stage === 'pistas') {
    for (const clave of ['idiomas', 'servidores']) {
      if (Array.isArray(evento[clave])) limpio[clave] = evento[clave].slice(0, 12).map(String);
    }
  }
  // Diagnóstico de sitios que inyectan el player (Gnula): solo nombres de
  // etiqueta, campos, endpoints, acciones del tema e ids del modal. Nunca
  // valores de atributo ni contenido de la página.
  if (evento.stage === 'sin-pistas') {
    if (Number.isFinite(evento.bytes)) limpio.bytes = evento.bytes;
    for (const clave of ['etiquetas', 'formularios', 'campos', 'endpoints', 'acciones', 'ids']) {
      if (Array.isArray(evento[clave])) limpio[clave] = evento[clave].slice(0, 14).map(v => String(v).slice(0, 60));
    }
  }
  // Forma estructural de una página sin media (etiquetas, campos, hosts).
  if (evento.forma && typeof evento.forma === 'object') {
    const f = evento.forma;
    limpio.forma = [
      f.form ? `form:${f.metodo || 'get'}→${f.actions.join('|')}` : 'sin-form',
      f.campos.length ? `campos:${f.campos.join('|')}` : '',
      f.scripts.length ? `scripts:${f.scripts.join('|')}` : '',
      f.saltos.length ? `salta:${f.saltos.join('|')}` : '',
      f.refresh ? `refresh:${f.refresh}` : '',
      f.carga ? 'autosubmit' : '',
      f.decodifica ? 'decodifica' : '',
      f.eval ? 'eval' : '',
      f.etiquetas?.length ? `tags:${f.etiquetas.join(',')}` : '',
      f.claves?.length ? `claves:${f.claves.join(',')}` : ''
    ].filter(Boolean).join(' ');
  }
  if (evento.algorithm) limpio.algorithm = String(evento.algorithm).slice(0, 20);
  // Cierre defensivo: ningún diagnóstico (presente o futuro) puede publicar
  // queries, HTML ni la palabra token. El test de contrato lo verifica.
  const PERMITIDOS = new Set(CAMPOS_SANEADOS);
  for (const clave of Object.keys(limpio)) {
    if (!PERMITIDOS.has(clave)) delete limpio[clave];
  }
  for (const [clave, valor] of Object.entries(limpio)) {
    if (typeof valor === 'string') {
      limpio[clave] = valor
        .replace(/\?[^\s"'<>]*/g, '')
        .replace(/token/gi, 'campo')
        .replace(/<[^>]*>/g, '')
        .slice(0, 400);
    } else if (Array.isArray(valor)) {
      limpio[clave] = valor.map(String).map(t => t.replace(/\?[^\s"'<>]*/g, '').replace(/token/gi, 'campo').slice(0, 120));
    }
  }
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
      // El sitio limita ráfagas: un 403/429 es transitorio, no un fallo de
      // extracción. Se reintenta con espera creciente antes de darlo por roto.
      let streams = [];
      let intento = 0;
      for (;;) {
        intento++;
        try {
          // Presupuesto holgado: el flujo real es ficha + Anubis (PoW y espera
          // mínima) + varios players externos, cada uno con su propia página.
          streams = await resolver({ url: pageUrl }, {
            timeoutMs: Math.min(20000, presupuesto()),
            deadlineMs: presupuesto(),
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
          break;
        } catch (error) {
          const transitorio = /HTTP (403|429|503)/.test(error.message);
          if (!transitorio || intento >= 3) throw error;
          entry.stages.reintentos = [String(intento)];
          // La espera crece (0, 20 s, 40 s): ráfagas cortas se recuperan solas.
          if (intento > 1) await esperar((intento - 1) * 20000);
        }
      }
      entry.success = streams.length > 0;
      entry.verifiedMedia = streams.length;
      if (streams.length) anyVerified = true;
      console.log(`${proveedor.clave}: ${streams.length ? `${streams.length} verified HLS/MP4 response(s)` : 'no verified HLS/MP4 found'}`);
    } catch (error) {
      // El mensaje puede citar una URL: se pasa por el mismo saneado.
      entry.error = String(error.message)
        .replace(/\?[^\s"'<>]*/g, '').replace(/token/gi, 'campo').slice(0, 200);
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
module.exports = { eventoSanitizado, CAMPOS_SANEADOS, parseUrls, presupuesto };

// El script se ejecuta solo si se invoca directamente (los tests importan sus
// funciones sin lanzar la verificación en vivo).
if (require.main === module) (function ejecutar() {
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
