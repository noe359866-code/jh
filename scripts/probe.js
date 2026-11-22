// TEMPORARY development probe. Fetches target pages from a machine with real
// outbound access (GitHub Actions) and writes structural facts so the parsers
// can be written against the live markup. Deleted before the final commit.
const fs = require('node:fs');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const TARGETS = [
  { id: 'eja-country', url: 'https://eja.tv/?country=es', card: /<div class="card[\s\S]{0,2600}?<\/div>\s*<\/div>/ },
  { id: 'eja-lang-all', url: 'https://eja.tv/?language=spa&limit=0', card: /<div class="card[\s\S]{0,2600}?<\/div>\s*<\/div>/ },
  { id: 'iptvcat-spain', url: 'https://iptvcat.net/spain__1', card: /<tr class="border-solid[^"]*"[\s\S]{0,2600}?<\/tr>/ },
  { id: 'tvenvivo-page', url: 'https://www.tvenvivo.org/tudn-en-vivo-online.php', card: /<div[^>]*id="player[\s\S]{0,1200}?<\/div>/ },
  { id: 'tvgarden-es', url: 'https://tvgarden.world/tv/es' },
  { id: 'thedaddy-list', url: 'https://thedaddy.li/24-7-channels.php', card: /<a[^>]{0,400}watch\.php\?id=\d+[\s\S]{0,600}?<\/a>/ },
  { id: 'thedaddy-watch', url: 'https://thedaddy.li/watch.php?id=1' },
  { id: 'livelive24-home', url: 'https://livelive24.com/' },
  { id: 'globalfreetv-ch', url: 'https://www.globalfreetv.com/channels/La1.es' },
  { id: 'globalfreetv-es', url: 'https://www.globalfreetv.com/countries/ES' }
];

function uniq(list) { return [...new Set(list)]; }

function analyse(id, url, status, finalUrl, type, html) {
  const out = { id, url, status, finalUrl, type, length: html.length, facts: {} };
  const pick = (re) => uniq([...html.matchAll(re)].map(m => m[1])).slice(0, 25);
  out.facts.iframes = pick(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
  out.facts.videoSources = pick(/<(?:video|source)[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
  out.facts.hls = pick(/["'](https?:\\?\/\\?\/[^"'<>\s]+?\.(?:m3u8|mp4|webm|mpd)(?:\?[^"'<>\s]*)?)["']/gi).map(s => s.replace(/\\\//g, '/'));
  out.facts.scriptSrc = pick(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
  out.facts.dataAttrs = uniq([...html.matchAll(/\s(data-[a-z0-9-]+)=/gi)].map(m => m[1])).slice(0, 40);
  out.facts.classes = uniq([...html.matchAll(/class="([^"]{2,120})"/g)].map(m => m[1])).slice(0, 60);
  // Any JSON-ish blob that mentions a channel list or a stream.
  const jsonHits = uniq([...html.matchAll(/(?:var|let|const|window\.\w+)\s*[=:]\s*(\[[\s\S]{40,600}?\]|\{[\s\S]{40,600}?\})\s*;?/g)].map(m => m[1]));
  out.facts.jsBlobs = jsonHits.slice(0, 6).map(s => s.slice(0, 700));
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]{20,4000}?)<\/script>/gi)].map(m => m[1]);
  out.facts.inlineScripts = inline.filter(s => /m3u8|stream|player|source|channel|api/i.test(s)).slice(0, 5).map(s => s.replace(/\s+/g, ' ').slice(0, 900));
  return out;
}

(async () => {
  const results = [];
  for (const target of TARGETS) {
    const entry = { id: target.id, url: target.url };
    try {
      const response = await fetch(target.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const html = await response.text();
      Object.assign(entry, analyse(target.id, target.url, response.status, response.url, response.headers.get('content-type'), html));
      if (target.card) {
        const m = html.match(target.card);
        entry.facts.cardSample = m ? m[0].replace(/\s+/g, ' ').slice(0, 2500) : null;
      }
      entry.facts.title = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || null;
    } catch (error) {
      entry.error = error.message;
    }
    console.log(target.id, entry.error || `status=${entry.status} len=${entry.length} iframes=${entry.facts.iframes.length} hls=${entry.facts.hls.length}`);
    results.push(entry);
  }
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe.json', JSON.stringify(results, null, 1));
})();
