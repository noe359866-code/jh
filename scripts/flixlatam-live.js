const fs = require('node:fs');
const { createProvider } = require('../engines/flixlatam');
const report = { startedAt: new Date().toISOString(), success: false, verifiedMedia: 0, events: [] };
(async () => {
  if (!process.env.FLIXLATAM_TEST_PAGE) throw new Error('A test page is required');
  const provider = createProvider({ pages: {}, onEvent: event => {
    if (report.events.length < 100) report.events.push(event);
  } });
  const streams = await provider.extract(process.env.FLIXLATAM_TEST_PAGE);
  report.verifiedMedia = streams.length;
  if (!streams.length) throw new Error('No verified media');
  report.success = true;
  console.log(`Verified ${streams.length} HLS/MP4 response(s); full playback not tested.`);
})().catch(error => {
  const code = error.cause?.code || error.code;
  report.failure = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ? code
    : report.events.some(event => event.stage === 'page') ? 'NO_VERIFIED_MEDIA' : 'PAGE_REQUEST_FAILED';
  console.error('Extraction failed. Check the sanitized report; no media URL is printed.');
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  if (process.env.GITHUB_ACTIONS === 'true' && !report.success) {
    const diagnostic = JSON.stringify({ failure: report.failure, events: report.events }).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log('::error title=FlixLatam live diagnostics::' + diagnostic);
  }
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/flixlatam-live.json', JSON.stringify(report, null, 2) + '\n');
});
