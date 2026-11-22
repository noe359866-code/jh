// TEMPORARY development probe #6 (deleted before the final commit).
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: response.status, finalUrl: response.url, ctype: response.headers.get('content-type'), text: await response.text() };
  } catch (error) { return { error: error.message }; }
}
const uniq = a => [...new Set(a)];
const pick = (text, re, n = 6) => uniq([...(text || '').matchAll(re)].map(m => m[1] || m[0])).slice(0, n);

(async () => {
  const out = {};

  // 1) tvenvivo: signed embed -> HLS?
  const page = await get('https://www.tvenvivo.org/tudn-en-vivo-online.php');
  const core = await get('https://www.tvenvivo.org/live/core.php?canal=tudn', { Referer: page.finalUrl });
  const embedUrl = (pick(core.text, /<iframe[^>]*\bsrc="([^"]+)"/gi, 2)[0] || '').replace(/&amp;/g, '&');
  out.tvenvivoEmbed = { url: embedUrl ? new URL(embedUrl).hostname + new URL(embedUrl).pathname : null };
  if (embedUrl) {
    const embed = await get(embedUrl, { Referer: core.finalUrl });
    out.tvenvivoEmbed.status = embed.status;
    out.tvenvivoEmbed.len = (embed.text || '').length;
    out.tvenvivoEmbed.iframes = pick(embed.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 5);
    out.tvenvivoEmbed.hls = pick(embed.text, /["'](https?:[^"'<>\\\s]+?\.(?:m3u8|mpd|mp4)[^"'<>\\\s]*)["']/g, 6);
    out.tvenvivoEmbed.jsFiles = pick(embed.text, /<script[^>]*\bsrc=["']([^"']+)/gi, 8);
    out.tvenvivoEmbed.config = pick(embed.text, /[^;{}"'`]{0,40}(?:sources|file|stream|hls|dash|channel|canal)[^;{}"'`]{0,120}/gi, 12);
    out.tvenvivoEmbed.old = pick(embed.text, /<source[^>]*>|<video[^>]*>/gi, 5);
  }

  // 2) livelive24: TV channel catalogue
  const home = await get('https://livelive24.com/');
  const jsRef = pick(home.text, /<script[^>]*\bsrc=["']([^"']*livelive[^"']*|[^"']*main[^"']*\.js)["']/gi, 5);
  out.liv24JsRefs = jsRef;
  const inline = home.text;
  out.liv24InlineFacts = {
    dataUrls: pick(inline, /["'`]((?:\.\/|\/)[^"'`\s]{2,90}\.json)["'`]/g, 10),
    ntvContext: (inline.match(/[^;\n]{0,120}ntv\.json[^;\n]{0,160}/gi) || []).slice(0, 4),
    tvFetch: (inline.match(/[^;\n]{0,140}(?:tvChannels|tv_channels|tvchannels|fetch\()[^;\n]{0,160}/gi) || []).slice(0, 8)
  };
  for (const p of ['/test/ntv/tv.json', '/test/ntv/tv_channels.json', '/test/ntv/channels.json', '/test/ntv/live.json', '/test/ntv/ntv_tv.json', '/test/ntv/tvchannels.json']) {
    const r = await get('https://livelive24.com' + p);
    out['liv24probe' + p] = { status: r.status, sample: (r.text || '').slice(0, 400) };
  }
  const watch = await get('https://livelive24.st/live24.html?url=la-1-es-');
  out.liv24Watch = {
    status: watch.status, len: (watch.text || '').length,
    iframes: pick(watch.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 4),
    hls: pick(watch.text, /["'](https?:[^"'<>\\\s]+?\.(?:m3u8|mpd|webm)[^"'<>\\\s]*)["']/g, 4),
    js: pick(watch.text, /<script[^>]*\bsrc=["']([^"']+)/gi, 6),
    vars: pick(watch.text, /var\s+\w+\s*=\s*["'][^"']{0,160}/g, 8)
  };

  // 3) DaddyLive: extraction pattern across several ids
  out.daddy = {};
  for (const id of [1, 51, 300, 800]) {
    const w = await get('https://thedaddy.li/watch.php?id=' + id);
    const embed = pick(w.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 2);
    const e = embed[0] ? await get(embed[0].replace(/&amp;/g, '&'), { Referer: 'https://thedaddy.li/watch.php?id=' + id }) : null;
    out.daddy['id' + id] = {
      embedHost: embed[0] ? new URL(embed[0]).hostname : null,
      srcVar: (e && e.text ? (e.text.match(/SRC\s*=\s*["']([^"']+)/) || [])[1] : null),
      m3u8: (e && e.text ? pick(e.text, /["'](https?:[^"'<>\\\s]+?\.m3u8[^"'<>\\\s]*)["']/g, 3) : [])
    };
  }

  // 4) globalfreetv pagination and multiple streams
  for (const c of ['ES', 'MX']) {
    const pages = {};
    for (const page of [1, 2, 3, 4]) {
      const r = await get(`https://www.globalfreetv.com/countries/${c}?page=${page}`);
      pages['page' + page] = uniq([...(r.text || '').matchAll(/\/channels\/([A-Za-z0-9._-]+)/g)].map(m => m[1])).length;
    }
    out['gftvPages' + c] = pages;
  }
  const multi = await get('https://www.globalfreetv.com/channels/24Horas.es');
  out.gftvPayload = {
    status: multi.status,
    streamsBlock: (multi.text.match(/streams:\$R\[\d+\]=\[[\s\S]{0,900}?\]/) || [''])[0].replace(/\s+/g, ' ').slice(0, 900),
    streamStatus: (multi.text.match(/streamStatus:"([^"]+)"/) || [])[1],
    country: (multi.text.match(/country:"([^"]+)"/) || [])[1]
  };

  // 5) eja: sizes per Spanish-speaking country
  out.eja = {};
  for (const c of ['es', 'mx', 'ar', 'co', 'cl', 'pe', 've', 'ec', 'gt', 'hn', 'sv', 'ni', 'cr', 'pa', 'cu', 'do', 'pr', 'uy', 'py', 'bo', 'us']) {
    const r = await get('https://eja.tv/?country=' + c);
    out.eja[c] = ((r.text || '').match(/(\d+) live iptv channels/i) || [])[1] || null;
  }
  const ejaMx = await get('https://eja.tv/?country=mx');
  out.ejaMxFirstCard = (ejaMx.text.match(/<div class="card h-100">[\s\S]{0,1600}?<\/video>/) || [''])[0].replace(/\s+/g, ' ').slice(0, 1200);

  // 6) iptvcat: name+clipboard pairs and slug sanity
  const spain = await get('https://iptvcat.net/spain__9');
  out.iptvcatSpain9 = { status: spain.status, title: (spain.text.match(/<title>([^<]+)/) || [])[1] };
  const pairs = [...(spain.text || '').matchAll(/<span class="channel_name"[\s\S]{0,1500}?data-clipboard-text="([^"]+)"[\s\S]{0,400}?<\/tr>/g)];
  out.iptvcatPairCount = pairs.length;
  out.iptvcatPairSample = pairs.slice(0, 2).map(m => m[0].replace(/\s+/g, ' ').slice(0, 500));
  const names = [...(spain.text || '').matchAll(/<span class="channel_name"[^>]*>([\s\S]{0,200}?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  out.iptvcatNames = names.slice(0, 5);

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe6.json', JSON.stringify(out, null, 1));
  console.log('probe6 done');
})();
