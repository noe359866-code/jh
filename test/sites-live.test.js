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
const ENTORNO_BASE = { ...process.env, SITES_TEST_URLS: 'https://www.documaniatv.com/pelicula/xyz' };
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
  assert.equal(reporte.tested[0].site, 'documaniatv');
  assert.equal(reporte.tested[0].host, 'www.documaniatv.com');
  // El reporte solo contiene host y conteos: ni rutas, ni queries, ni tokens.
  const serializado = JSON.stringify(reporte);
  assert.doesNotMatch(serializado, /pelicula|xyz|\?|token/i);
  const CLAVES = new Set(['stage', 'host', 'site', 'verified', 'candidates', 'frames', 'error']);
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
