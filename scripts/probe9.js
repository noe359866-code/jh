// TEMPORARY development probe #9 (deleted before the final commit).
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    return { status: response.status, finalUrl: response.url, ctype: response.headers.get('content-type'), text: await response.text() };
  } catch (error) { return { error: error.message }; }
}
const uniq = a => [...new Set(a)];
const pick = (text, re, n = 6) => uniq([...(text || '').matchAll(re)].map(m => m[1] || m[0])).slice(0, n);

(async () => {
  const out = {};

  // a) DaddyLive playlist token
  const embed = await get('https://dembed.st/premiumtv/daddy.php?id=51', { Referer: 'https://thedaddy.li/watch.php?id=51' });
  out.daddy = {
    src: (embed.text.match(/const\s+SRC\s*=\s*["']([^"']+)/) || [])[1],
    edge: (embed.text.match(/const\s+EDGE\s*=\s*["']([^"']+)/) || [])[1],
    channel: (embed.text.match(/const\s+CHANNEL\s*=\s*["']([^"']+)/) || [])[1],
    tokenCalls: pick(embed.text, /[^;{}"'`]{0,60}token[^;{}"'`]{0,120}/gi, 8)
  };
  for (const q of ['/api/playlist-token?slug=premium51', '/api/playlist-token?slug=premium51&id=51']) {
    const r = await get('https://edge.wedd48c.top' + q, { Referer: 'https://dembed.st/' });
    out.daddy['token' + q] = { status: r.status, ctype: r.ctype, sample: (r.text || '').slice(0, 200) };
  }
  if (out.daddy.src) {
    const media = await get(out.daddy.src, { Range: 'bytes=0-2048', Referer: 'https://dembed.st/', Origin: 'https://dembed.st' });
    out.daddy.media = { status: media.status, prefix: (media.text || '').slice(0, 60) };
  }

  // b) Live24: a Spanish channel and its blogger hop
  const tv = await get('https://livelive24.com/tv.json');
  let list = [];
  try { list = JSON.parse(tv.text); } catch { /* ignore */ }
  const spain = list.filter(x => /spain/i.test(x.country || ''));
  out.liv24 = { spainCount: spain.length, sampleSpain: spain.slice(0, 3), categories: uniq(list.map(x => x.category)).slice(0, 15) };
  if (spain[0]) {
    const hop = await get(spain[0].url, { Referer: 'https://livelive24.com/' });
    out.liv24.hop = {
      status: hop.status, finalUrl: hop.finalUrl, len: (hop.text || '').length,
      iframes: pick(hop.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 5),
      hls: pick(hop.text, /["'](https?:[^"'<>\s]+?\.(?:m3u8|mpd))[^"'<>\s]*/g, 5),
      vars: pick(hop.text, /(?:var|let|const)\s+\w+\s*=\s*["'][^"']{10,160}/g, 8)
    };
    if (out.liv24.hop.iframes[0]) {
      const inner = await get(new URL(out.liv24.hop.iframes[0], hop.finalUrl).href, { Referer: hop.finalUrl });
      out.liv24.inner = { status: inner.status, finalUrl: inner.finalUrl, iframes: pick(inner.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 4), hls: pick(inner.text, /["'](https?:[^"'<>\s]+?\.(?:m3u8|mpd))[^"'<>\s]*/g, 4) };
    }
  }

  // c) tvenvivo without Referer (does the embed still expose the URL?)
  const core = await get('https://www.tvenvivo.org/live/core.php?canal=la-1');
  const iframe = ((core.text || '').match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1];
  out.tvenvivo = { coreStatus: core.status, iframe: iframe ? iframe.slice(0, 90) : null };
  if (iframe) {
    const e = await get(iframe.replace(/&amp;/g, '&'));
    out.tvenvivo.embed = { status: e.status, hasLiteral: /var src = "https?:/.test(e.text || '') };
  }
  const home = await get('https://www.tvenvivo.org/');
  out.tvenvivo.home = { anchors: pick(home.text, /<a[^>]*href="([^"]*-en-vivo-online\.php)"[^>]*>([\s\S]{0,400}?)<\/a>/gi, 3) };

  // d) eja: confirm card count per page and pagination cap
  const ejaBig = await get('https://eja.tv/?offset=120&country=es&language=&category=&search=');
  out.eja = { status: ejaBig.status, cards: (ejaBig.text.match(/class="card h-100"/g) || []).length, end: /No more|no results/i.test(ejaBig.text) };

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe9.json', JSON.stringify(out, null, 1));
  console.log('probe9 done');
})();
