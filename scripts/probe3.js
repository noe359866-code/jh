// TEMPORARY development probe #3 (deleted before the final commit).
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  return { status: response.status, url: response.url, html: await response.text() };
}

function around(html, re, before = 400, after = 1200, limit = 4) {
  const out = [];
  const regex = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of html.matchAll(regex)) {
    if (out.length >= limit) break;
    const start = Math.max(0, m.index - before);
    out.push(html.slice(start, m.index + m[0].length + after).replace(/\s+/g, ' '));
  }
  return out;
}

(async () => {
  const report = {};

  // eja: does limit=0 return everything? how many cards?
  {
    const r = await get('https://eja.tv/?country=es&limit=0');
    report.eja = {
      status: r.status,
      cards: (r.html.match(/class="card h-100"/g) || []).length,
      offsetPagination: around(r.html, /offset=\d+/, 100, 100, 3),
      totalText: around(r.html, /\d+\s+(?:live\s+)?(?:iptv\s+)?channels/i, 300, 300, 2)
    };
  }

  // iptvcat: full row, clipboard attr, and page 2 link
  {
    const r = await get('https://iptvcat.net/spain__1');
    const row = r.html.match(/<tr class="border-solid belongs_to_\d+"[\s\S]*?<\/tr>/);
    report.iptvcat = {
      status: r.status,
      rowLength: row ? row[0].length : 0,
      row: row ? row[0].replace(/\s+/g, ' ').slice(0, 9000) : null,
      clipboards: [...new Set([...r.html.matchAll(/data-clipboard-text="([^"]+)"/g)].map(m => m[1]))].slice(0, 5),
      pages: [...new Set([...r.html.matchAll(/href="(\/[a-z_]+__\d+\/\d+)"/g)].map(m => m[1]))].slice(0, 6)
    };
  }

  // tvenvivo: scripts and the player bootstrap
  {
    const r = await get('https://www.tvenvivo.org/tudn-en-vivo-online.php');
    report.tvenvivo = {
      status: r.status,
      scripts: [...new Set([...r.html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 25),
      embedHost: around(r.html, /ksdjugfssddeports/, 500, 900, 3),
      optionHits: around(r.html, /(?:opcion|option|source-btn|data-option|playerSrc|player-src)/i, 300, 900, 4),
      phpRefs: [...new Set([...r.html.matchAll(/["']([^"']*\.php[^"']*)["']/g)].map(m => m[1]))].slice(0, 25).filter(s => !s.includes('www.tvenvivo.org/tudn'))
    };
  }

  // tvgarden: app bundle + api endpoints
  {
    const r = await get('https://tvgarden.world/tv/es');
    report.tvgarden = {
      status: r.status,
      scripts: [...new Set([...r.html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 25),
      inlineApi: around(r.html, /(?:fetch\(|\/api\/|\.json)/, 200, 600, 6),
      appConfig: around(r.html, /(?:window\.__|__NUXT__|__NEXT_DATA__|dataLayer|apiBase|API_BASE)/, 100, 800, 4)
    };
  }

  // livelive24: app bundle + api endpoints
  {
    const r = await get('https://livelive24.com/');
    report.livelive24 = {
      status: r.status,
      scripts: [...new Set([...r.html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 25),
      inlineApi: around(r.html, /(?:fetch\(|\/api\/|channels|streamId|baseUrl|apiUrl)/i, 200, 700, 8)
    };
  }

  // globalfreetv: stream config inside channel page
  {
    const r = await get('https://www.globalfreetv.com/channels/La1.es');
    report.globalfreetv = {
      status: r.status,
      streamContext: around(r.html, /rtvelivestream\.rtve\.es/, 900, 600, 2),
      jsonScripts: [...r.html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]{0,400}?)</g)].slice(0, 4).map(m => m[1])
    };
    const listing = await get('https://www.globalfreetv.com/countries/MX');
    report.globalfreetv.mx = {
      status: listing.status,
      channelLinks: [...new Set([...listing.html.matchAll(/\/channels\/([A-Za-z0-9._-]+)/g)].map(m => m[1]))].slice(0, 15),
      count: (listing.html.match(/\/channels\/[A-Za-z0-9._-]+/g) || []).length
    };
    const countries = await get('https://www.globalfreetv.com/countries');
    report.globalfreetv.countries = {
      status: countries.status,
      hrefs: [...new Set([...countries.html.matchAll(/\/countries\/([A-Za-z]{2})/g)].map(m => m[1]))].slice(0, 40)
    };
  }

  // dlhd stream page: what is inside the player page?
  {
    const r = await get('https://thedaddy.li/stream/stream-1.php');
    report.dlhd = {
      status: r.status,
      iframes: [...new Set([...r.html.matchAll(/<iframe[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 10),
      hls: [...new Set([...r.html.matchAll(/["'](https?:[^"'<>\\\s]+?\.(?:m3u8|mp4|webm|mpd)[^"'<>\\\s]*)["']/g)].map(m => m[1]))].slice(0, 10),
      scriptSrcs: [...new Set([...r.html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 15),
      sourceTags: around(r.html, /<source[^>]*>/i, 100, 300, 3),
      jsUrls: around(r.html, /(?:m3u8|\.php\?|src\s*=|atob|eval\()/i, 200, 600, 6)
    };
  }

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe3.json', JSON.stringify(report, null, 1));
  console.log('probe3 done');
})();
