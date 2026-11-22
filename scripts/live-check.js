// Verificación en vivo (red real). Recorre cada fuente, informa cuántos canales
// y medios verificados devuelve y escribe `reports/live-check.json` sin URLs ni
// tokens. Falla si ninguna fuente aporta canales reproducibles.
//
//   SOURCE=tvgarden npm run test:live     # una sola fuente
//   npm run test:live                     # todas
//
// En GitHub Actions tiene sentido (el entorno de desarrollo no llega a estos
// dominios). No sustituye a `npm test`, que es determinista y sin red.
const fs = require('node:fs');
const { createCatalog } = require('../engines/live/catalog');
const { get } = require('../engines/live/http');
const { sources, byId, MODE } = require('../engines/live/sources');
const addon = require('../engines/live/addon');
const { buildM3u } = require('../engines/live/m3u');

const only = (process.env.SOURCE || '').split(',').map(value => value.trim()).filter(Boolean);
const selected = only.length ? sources.filter(source => only.includes(source.id)) : sources;

const report = { startedAt: new Date().toISOString(), ok: false, sources: {}, totals: {}, checks: [] };

function signature(text) {
  const head = String(text || '').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('#EXTM3U');
}

(async () => {
  const catalog = createCatalog({ sources: selected, fetchGet: get });
  const loaded = await catalog.load({ force: true });
  report.sources = loaded.status;
  report.totals = loaded.counts;
  console.log(`Canales: ${loaded.counts.total} (reproducibles: ${loaded.counts.playable}; ES: ${loaded.counts.es}; LATAM: ${loaded.counts.latam})`);
  for (const [id, status] of Object.entries(loaded.status)) {
    const line = `${id} [${MODE[id] || 'direct'}] ${status.ok ? `${status.entries} canales` : `error: ${status.error}`}`;
    console.log(`  - ${line}`);
  }

  // Muestra la resolución bajo demanda de las fuentes `page` (máx. 2 por fuente).
  for (const channel of loaded.channels.filter(entry => entry.streams.some(stream => stream.kind === 'page')).slice(0, 4)) {
    const page = channel.streams.find(stream => stream.kind === 'page');
    const resolver = byId(page.source);
    let resolved = null;
    try {
      resolved = resolver && resolver.resolve ? await resolver.resolve(page.url, { get }) : null;
    } catch (error) {
      resolved = { error: error.message };
    }
    const check = { channel: channel.id, source: page.source, resolved: Boolean(resolved && resolved.url), error: resolved && resolved.error };
    report.checks.push(check);
    console.log(`  página ${channel.id} (${page.source}): ${check.resolved ? 'HLS resuelto' : `sin resolver${check.error ? ` (${check.error})` : ''}`}`);
  }

  // Verificación de firma sobre una muestra de medios directos (máx. 6).
  const samples = loaded.channels.filter(channel => channel.streams.some(stream => stream.kind !== 'page')).slice(0, 6);
  for (const channel of samples) {
    const stream = channel.streams.find(entry => entry.kind !== 'page');
    let ok = false;
    try {
      const response = await get(stream.url, { headers: { Range: 'bytes=0-2048' }, referer: stream.referer, maxBytes: 4096 });
      ok = signature(response.text);
    } catch {
      ok = false;
    }
    report.checks.push({ channel: channel.id, source: stream.source, signature: ok });
    console.log(`  firma ${channel.id} (${stream.source}): ${ok ? 'HLS' : 'sin firma'}`);
  }

  const { count } = await buildM3u(loaded.channels, {});
  report.playlistEntries = count;
  console.log(`Entradas M3U directas: ${count}`);

  report.ok = loaded.counts.playable > 0;
  if (!report.ok) console.error('Ninguna fuente aportó medios reproducibles.');
  process.exitCode = report.ok ? 0 : 1;
})().catch(error => {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/live-check.json', JSON.stringify(report, null, 2) + '\n');
});
