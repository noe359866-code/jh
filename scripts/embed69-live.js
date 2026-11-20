// Intentionally outside test/: normal CI is deterministic and offline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve } = require('../engines/embed69');
const report = { startedAt: new Date().toISOString(), success: false, verifiedMedia: 0, events: [] };
(async () => {
  const request = { type: process.env.EMBED69_TEST_TYPE || 'movie', imdbId: process.env.EMBED69_TEST_IMDB,
    season: process.env.EMBED69_TEST_SEASON, episode: process.env.EMBED69_TEST_EPISODE };
  assert.match(request.imdbId || '', /^tt\d{7,}$/, 'Set EMBED69_TEST_IMDB to an authorized test title');
  assert.ok(['movie', 'episode'].includes(request.type), 'Test type must be movie or episode');
  const streams = await resolve(request, { onEvent: event => {
    // Only controlled fields: never log paths, queries, page bodies, or signed URLs.
    if (report.events.length < 100) report.events.push(event);
  } });
  assert.ok(streams.length, 'No verified HLS/MP4 found');
  report.success = true;
  report.verifiedMedia = streams.length;
  console.log(`Verified ${streams.length} media response(s). This is not a full playback test.`);
})().catch(() => {
  console.error('Live extraction failed. Inspect the sanitized report for availability and blocked hosts.');
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/embed69-live.json', JSON.stringify(report, null, 2) + '\n');
});
