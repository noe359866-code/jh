const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

// El script en vivo importaba `validateSiteUrl`/`findSite`, que no existen en
// engines/sites: fallaba SIEMPRE con "validateSiteUrl is not a function" y
// dejaba un reporte de error como si fuera una verificación real. Este test
// fija el contrato: valida la URL, intenta la extracción y escribe el reporte
// saneado, sin URLs ni queries.
const RAIZ = path.join(__dirname, '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'sites-live.js');
// Presupuesto corto: el contrato se prueba sin depender de cuánto tarde la red
// real (con el presupuesto de producción el proceso podía pasarse del timeout
// del propio test y fallar de forma intermitente en CI).
const ENTORNO_BASE = {
  ...process.env,
  SITES_TEST_URLS: 'https://flixlatam.com/pelicula/patton',
  SITES_LIVE_BUDGET_MS: '6000'
};
delete ENTORNO_BASE.SITES_ALLOWED_HOSTS;

function ejecutar() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-live-'));
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { cwd, env: ENTORNO_BASE, timeout: 60000 }, (error, stdout, stderr) => {
      const reporte = JSON.parse(fs.readFileSync(path.join(cwd, 'reports', 'sites-live.json'), 'utf8'));
      resolve({ codigo: error ? error.code : 0, stdout, stderr, reporte });
    });
  });
}

test('sites-live valida la URL, intenta la extracción y escribe un reporte sin secretos', async () => {
  const { stdout, stderr, reporte } = await ejecutar();
  // Ya no hay error de importación: el fallo, si existe, es de red real.
  assert.doesNotMatch(stderr, /is not a function/);
  assert.equal(reporte.tested.length, 1);
  assert.equal(reporte.tested[0].site, 'flixlatam');
  assert.equal(reporte.tested[0].host, 'flixlatam.com');
  // El reporte solo contiene host y conteos: ni rutas, ni queries, ni tokens.
  const serializado = JSON.stringify(reporte);
  assert.doesNotMatch(serializado, /patton|pelicula|\?|token|csrf/i);
  // La lista de campos es única (la exporta el propio script) y además el
  // saneado es defensivo: nada puede llevar queries ni la palabra token aunque
  // un diagnóstico nuevo se olvide de redactarlo.
  const { CAMPOS_SANEADOS, eventoSanitizado } = require('../scripts/sites-live.js');
  const CLAVES = new Set(CAMPOS_SANEADOS);
  for (const evento of reporte.events) {
    assert.ok(Object.keys(evento).every(clave => CLAVES.has(clave)), `evento con campo inesperado: ${JSON.stringify(evento)}`);
  }
  assert.match(stdout, /sanitized report/);
});

test('sites-live falla con código distinto de cero si no hay medios verificados', async () => {
  // En este entorno no hay salida a los sitios, así que el resultado es un
  // fallo real y debe reflejarse: nunca un éxito silencioso.
  const { codigo, reporte } = await ejecutar();
  if (!reporte.success) assert.notEqual(codigo, 0);
  else assert.equal(codigo, 0);
});

test('el saneado es defensivo: ningún diagnóstico puede publicar queries ni tokens', () => {
  // Aunque un evento futuro añada campos nuevos con secretos, el saneado los
  // corta: el reporte nunca puede filtrar queries, HTML ni la palabra token.
  const { eventoSanitizado } = require('../scripts/sites-live.js');
  const sucio = eventoSanitizado({
    stage: 'prueba', host: 'player.example', titulo: 'x?token=abc',
    cuerpo: '<script src="/a.js?tok=1"></script>', rutas: ['/dl?file=abc&token=xyz'],
    campo_inventado: 'https://host/x?token=secreto', bytes: 10
  });
  const serializado = JSON.stringify(sucio);
  assert.doesNotMatch(serializado, /\?|\btoken\b|csrf/i);
  assert.doesNotMatch(serializado, /<script/);
  assert.equal(sucio.bytes, 10);
});

test('los campos no declarados se descartan del reporte (no basta con redactarlos)', () => {
  // El test de contrato no debe tener que perseguir cada diagnóstico nuevo:
  // cualquier campo fuera de CAMPOS_SANEADOS desaparece.
  const { eventoSanitizado, CAMPOS_SANEADOS } = require('../scripts/sites-live.js');
  const evento = eventoSanitizado({
    stage: 'nuevo', host: 'player.example',
    diagnostico_futuro: 'algo', otraCosa: ['x'], total: 3
  });
  assert.ok(Object.keys(evento).every(clave => CAMPOS_SANEADOS.includes(clave)));
  assert.equal(evento.diagnostico_futuro, undefined);
  assert.equal(evento.total, 3);
});
