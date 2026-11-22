// Verificación de señales de punta a punta (necesita red real).
//
// Recolecta el catálogo, sondea cada canal y deja:
//   reports/health.json        informe completo (sin URLs ni tokens)
//   reports/dead.txt            lista legible de canales caídos
//   reports/playlist-*.m3u      copias de las listas SIN los canales caídos
//
//   npm run verify                 # todo
//   LIMIT=40 npm run verify        # muestra (desarrollo)
//   CONCURRENCY=32 npm run verify  # más paralelismo
//   FAIL_ON_DEAD=1 npm run verify  # sale con 1 si hay caídos (CI estricta)
const fs = require('node:fs');
const path = require('node:path');
const { createCatalog } = require('../engines/live/catalog');
const { createChecker } = require('../engines/live/checker');
const { buildM3u } = require('../engines/live/m3u');
const { get } = require('../engines/live/http');
const { byId } = require('../engines/live/sources');

const number = name => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const LIMIT = number('LIMIT');
const CONCURRENCY = number('CONCURRENCY');
const BUDGET_MS = number('CHECK_BUDGET_MS');

// Las listas del servidor, sin duplicar la definición: antes este script tenía
// su propia copia (solo all/es/latam/deportes) y no generaba ninguna de país.
const { PLAYLISTS } = require('../index');

function resolvePage(stream) {
  const source = { 'www.tvenvivo.org': 'tvenvivo', 'thedaddy.li': 'thedaddy' }[new URL(stream.url).hostname];
  if (!source) return Promise.resolve(null);
  return byId(source).resolve(stream.url, { get });
}

async function main() {
  const catalog = createCatalog({
    sources: require('../engines/live/sources').sources,
    fetchGet: get,
    // Misma extracción de embeds que el servidor.
    extract: (channels, options) => {
      const ex = require('../engines/live/extract');
      return ex.enrich(channels, { ...options, byId: require('../engines/live/sources').byId, stats: ex.sharedStats });
    }
  });
  const loaded = await catalog.load({ force: true });
  console.log(`Catálogo: ${loaded.counts.total} canales (${loaded.counts.playable} con medio directo)`);
  if (loaded.status._extract) {
    const ex = loaded.status._extract;
    console.log(`Extracción de embeds: ${ex.extracted} HLS extraídos de ${ex.targets} canales con página ` +
      `(fallidos ${ex.failed}, omitidos ${ex.skipped}, ${Math.round((ex.ms || 0) / 1000)} s)`);
    if (ex.bySource) console.log('  por fuente:', JSON.stringify(ex.bySource));
    if (ex.reasons) console.log('  motivos:', JSON.stringify(ex.reasons));
  }

  const extractStats = loaded.status._extract || null;
  const checker = createChecker({ get, resolvePage, channels: loaded.channels, concurrency: CONCURRENCY, budgetMs: BUDGET_MS });
  const report = await checker.run({ limit: LIMIT });
  const bloqueados = Object.values(report.results).filter(result => result.blocked).length;
  const sinConfirmar = Object.values(report.results).filter(result => result.unconfirmed).length;
  console.log(`Verificación: ${report.total} canales en ${Math.round(report.durationMs / 1000)} s · ` +
    `vivos ${report.alive} · caídos ${report.dead} · bloqueados ${bloqueados} · ` +
    `tiempo agotado ${sinConfirmar} · sin verificar ${report.unknown} · omitidos ${report.skipped}`);
  if (report.selfCheck.inconclusive) {
    console.warn(`Aviso: solo el ${Math.round(report.selfCheck.ratio * 100)}% de las señales verificables responden ` +
      `(${report.selfCheck.informative} medibles, ${report.selfCheck.throttled} limitadas por 403/429). ` +
      'Puede ser la red de este entorno; revisa el informe antes de confiar en él.');
  }

  const channels = checker.apply(loaded.channels);
  const dead = channels.filter(channel => channel.dead);
  const written = {};

  // Informe completo: solo ids y motivos, sin URLs.
  fs.mkdirSync('reports', { recursive: true });
  const slim = {
    checkedAt: report.checkedAt,
    durationMs: report.durationMs,
    inconclusive: report.selfCheck.inconclusive,
    extraction: extractStats,
    totals: {
      checked: report.total,
      alive: report.alive,
      dead: report.dead,
      blocked: bloqueados,
      unconfirmed: sinConfirmar,
      unknown: report.unknown,
      skipped: report.skipped
    },
    blocked: bloqueados,
    unconfirmed: sinConfirmar,
    dead: dead.map(channel => ({
      id: channel.id,
      name: channel.name,
      country: channel.country,
      sources: channel.sources,
      status: channel.health && channel.health.status,
      error: channel.health && channel.health.error,
      attempts: channel.health && channel.health.attempts
    }))
  };
  fs.writeFileSync(path.join('reports', 'health.json'), JSON.stringify(slim, null, 2) + '\n');
  fs.writeFileSync(
    path.join('reports', 'dead.txt'),
    dead.length
      ? dead.map(channel => `${channel.id}\t${channel.name}\t${channel.country}\t${channel.sources.join('+')}`).join('\n') + '\n'
      : 'Sin canales caídos.\n'
  );

  // Listas sin caídos (mismas rutas y atributos que el servidor).
  //
  // `all` va primero y cada lista se escribe en cuanto se genera: si el proceso
  // se corta a mitad (24 listas sobre miles de canales), al menos quedan las
  // anteriores en lugar de un directorio vacío.
  const vivos = channels.filter(channel => !channel.dead);
  const orden = ['all', ...Object.keys(PLAYLISTS).filter(id => id !== 'all')];
  for (const variant of orden) {
    const definition = PLAYLISTS[variant];
    if (!definition) continue;
    try {
      const { body, count } = await buildM3u(vivos.filter(definition.filter), { siteName: 'TV en Español' });
      fs.writeFileSync(path.join('reports', `playlist-${variant}.m3u`), body);
      written[variant] = count;
    } catch (error) {
      console.warn(`Lista ${variant} no generada: ${error.message}`);
    }
  }
  console.log(`Listas escritas en reports/: ${Object.entries(written).map(([id, count]) => `${id} (${count})`).join(', ')}`);

  // Desglose por país: solo los que tienen canales vivos, de mayor a menor. Es
  // lo que alimenta las categorías de Stremio, así que se deja en el informe.
  const byCountry = new Map();
  for (const channel of channels) {
    if (channel.dead) continue;
    const key = channel.origin || channel.country || '??';
    byCountry.set(key, (byCountry.get(key) || 0) + 1);
  }
  const ordered = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Países con canales vivos: ${ordered.map(([code, count]) => `${code} ${count}`).join(' · ')}`);
  fs.writeFileSync(
    path.join('reports', 'countries.json'),
    JSON.stringify(Object.fromEntries(ordered), null, 2) + '\n'
  );

  const failOnDead = process.env.FAIL_ON_DEAD === '1';
  process.exitCode = report.selfCheck.inconclusive ? 2 : failOnDead && dead.length ? 1 : 0;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
