// TEMPORARY development probe #10 (deleted before the final commit).
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    return { status: response.status, finalUrl: response.url, ctype: response.headers.get('content-type'), text: await response.text() };
  } catch (error) { return { error: error.message }; }
}
const uniq = a => [...new Set(a)];
const pick = (text, re, n = 8) => uniq([...(text || '').matchAll(re)].map(m => m[1] || m[0])).slice(0, n);
(async () => {
  const out = {};
  const ch = await get('https://livelive24.com/', { Referer: 'https://livelive24.com/' });
  out.channelPage = { status: ch.status, len: (ch.text || '').length, iframes: pick(ch.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 5), hls: pick(ch.text, /["'](https?:[^"'<>\s]+?\.(?:m3u8|mpd))[^"'<>\s]*/g, 5), vars: pick(ch.text, /(?:var|let|const)\s+\w+\s*=\s*["'][^"']{10,200}/g, 10), srcTags: pick(ch.text, /<source[^>]*>/gi, 4), body: (ch.text || '').replace(/\s+/g, ' ').slice(0, 700) };
  const tv = await get('https://livelive24.com/tv.json');
  let list = []; try { list = JSON.parse(tv.text); } catch {}
  const spain = list.filter(x => /spain/i.test(x.country || ''));
  out.spain = spain.slice(0, 3).map(x => ({ name: x.channel_name, url: x.url, cat: x.category }));
  if (spain[0]) {
    const hop = await get(spain[0].url, { Referer: 'https://livelive24.com/' });
    out.hop = { status: hop.status, finalUrl: hop.finalUrl, len: (hop.text || '').length, iframes: pick(hop.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 5), hls: pick(hop.text, /["'](https?:[^"'<>\s]+?\.(?:m3u8|mpd))[^"'<>\s]*/g, 5), vars: pick(hop.text, /(?:var|let|const)\s+\w+\s*=\s*["'][^"']{10,200}/g, 10) };
    if (out.hop.iframes[0]) {
      const inner = await get(new URL(out.hop.iframes[0], hop.finalUrl).href, { Referer: hop.finalUrl });
      out.inner = { status: inner.status, finalUrl: inner.finalUrl, iframes: pick(inner.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 4), hls: pick(inner.text, /["'](https?:[^"'<>\s]+?\.(?:m3u8|mpd))[^"'<>\s]*/g, 4), vars: pick(inner.text, /(?:var|let|const)\s+\w+\s*=\s*["'][^"']{10,200}/g, 8) };
    }
  }
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe10.json', JSON.stringify(out, null, 1));
  console.log('probe10 done');
})();
