// TEMPORARY development probe #2 (deleted before the final commit).
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const TARGETS = [
  { id: 'eja-card', url: 'https://eja.tv/?country=es', regexes: { card: /<div class="card h-100[\s\S]*?<\/video>[\s\S]*?<\/div>/ } },
  { id: 'iptvcat-row', url: 'https://iptvcat.net/spain__1', regexes: { row: /<tr class="border-solid belongs_to_\d+"[\s\S]{0,3000}?<\/tr>/ } },
  { id: 'tvenvivo', url: 'https://www.tvenvivo.org/tudn-en-vivo-online.php', regexes: { player: /<div class="player[\s\S]{0,4000}?<\/div>\s*<div class="more/, cfg: /(?:source|opci|option|iframe|m3u8|ksdjugfssddeports|baseUrl|apiUrl|stream)[\s\S]{0,400}/gi } },
  { id: 'tvgarden', url: 'https://tvgarden.world/tv/es', regexes: { chan: /(?:data-ch|channel|stream|m3u8|api)[\s\S]{0,200}/gi } },
  { id: 'dlhd-card', url: 'https://thedaddy.li/24-7-channels.php', regexes: { card: /<a[^>]*watch\.php\?id=\d+[^>]*>[\s\S]{0,800}?<\/a>/ } },
  { id: 'dlhd-stream1', url: 'https://thedaddy.li/stream/stream-1.php' },
  { id: 'liv24-home', url: 'https://livelive24.com/', regexes: { match: /<a[^>]*watch-link[^>]*>[\s\S]{0,500}?<\/a>/, api: /(?:fetch\(|api|\.php|\.json)[\s\S]{0,160}/gi } },
  { id: 'liv24-chan', url: 'https://livelive24.com/?channel=la-1-es-' },
  { id: 'gftv-la1', url: 'https://www.globalfreetv.com/channels/La1.es', regexes: { player: /player-frame[\s\S]{0,3000}?<\/video>[\s\S]{0,2000}?<\/div>/, cfg: /(?:sources|src|m3u8|api|json)[\s\S]{0,200}/gi } }
];

(async () => {
  const results = [];
  for (const target of TARGETS) {
    const entry = { id: target.id, url: target.url };
    try {
      const response = await fetch(target.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const html = await response.text();
      entry.status = response.status;
      entry.finalUrl = response.url;
      entry.length = html.length;
      entry.samples = {};
      for (const [name, re] of Object.entries(target.regexes || {})) {
        const all = [...html.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
        entry.samples[name] = all.slice(0, 3).map(m => (m[0] || m[1] || '').replace(/\s+/g, ' ').slice(0, 2200));
        entry.samples[name + '_count'] = all.length;
      }
      // Whole page (trimmed) for smaller pages, so structure is fully visible.
      if (html.length < 120000) entry.htmlHead = html.slice(0, 12000);
      if (target.id.startsWith('dlhd') || target.id.includes('watch') || target.id.includes('chan') || target.id.includes('stream')) entry.htmlFull = html.slice(0, 30000);
    } catch (error) { entry.error = error.message; }
    console.log(target.id, entry.error || `status=${entry.status} len=${entry.length}`);
    results.push(entry);
  }
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe2.json', JSON.stringify(results, null, 1));
})();
