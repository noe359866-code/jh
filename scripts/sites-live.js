// Intentionally outside test/: normal CI is deterministic and offline.
// Live verification for the direct site stream resolver. Requires outbound
// access to the target sites; the development sandbox only reaches GitHub and
// package registries, so this runs manually (or from GitHub Actions) where the
// network allows it. Scans every configured page URL and reports which sites
// returned verified HLS/MP4.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve, validateSiteUrl, findSite } = require('../engines/sites');

const DEFAULT_URLS = [
  'https://www.documaniatv.com/',
  'https://flixlatam.com/',
  'https://www.poseidonhd2.co/'
];

function parseUrls() {
  const raw = (process.env.SITES_TEST_URLS || process.env.SITES_TEST_URL || '').trim();
  if (!raw) return DEFAULT_URLS;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

const report = {
  startedAt: new Date().toISOString(),
  success: false,
  tested: [],
  events: []
};

(async () => {
  const urls = parseUrls();
  assert.ok(urls.length, 'Set SITES_TEST_URLS (or SITES_TEST_URL) with at least one site page URL');
  let anyVerified = false;
  for (const pageUrl of urls) {
    const entry = { site: null, success: false, verifiedMedia: 0, error: null };
    try {
      // Validate before any network call so bad input fails fast.
      const { site } = validateSiteUrl(pageUrl);
      entry.site = site.key;
      const streams = await resolve({ url: pageUrl }, { onEvent: event => {
        // Only controlled fields: never log paths, queries, page bodies, or signed URLs.
        if (report.events.length < 200) report.events.push({ ...event, site: site.key });
      } });
      entry.success = streams.length > 0;
      entry.verifiedMedia = streams.length;
      if (streams.length) anyVerified = true;
      console.log(`${site.key}: ${streams.length ? `${streams.length} verified HLS/MP4 response(s)` : 'no verified HLS/MP4 found'} (${pageUrl.length ? '' : ''}page tested)`);
    } catch (error) {
      entry.error = error.message;
      console.error(`${pageUrl}: failed - ${error.message}`);
    }
    report.tested.push(entry);
  }
  report.success = anyVerified;
  const winners = report.tested.filter(entry => entry.success).map(entry => entry.site);
  console.log(winners.length
    ? `Verified HLS/MP4 on: ${winners.join(', ')}. This is not a full playback test.`
    : 'No site returned verified HLS/MP4. Inspect the sanitized report for blocked hosts.');
  assert.ok(anyVerified, 'No verified HLS/MP4 found on any tested site');
})().catch(() => {
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/sites-live.json', JSON.stringify(report, null, 2) + '\n');
});
