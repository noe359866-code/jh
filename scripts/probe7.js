// TEMPORARY development probe #7 (deleted before the final commit).
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
const strip = s => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const out = {};

  // 1) iptvcat: full row, then text-only rendering of the first 3 rows
  const spain = await get('https://iptvcat.net/spain__1');
  const rows = [...(spain.text || '').matchAll(/<tr class="border-solid[^"]*"[\s\S]*?<\/tr>/g)].map(m => m[0]);
  out.iptvcat = {
    status: spain.status,
    rowCount: rows.length,
    firstRowLength: rows[0] ? rows[0].length : 0,
    firstRowClean: rows[0] ? strip(rows[0]).slice(0, 400) : null,
    firstRowClip: rows[0] ? (rows[0].match(/data-clipboard-text="([^"]+)"/) || [])[1] : null,
    nameViaRegex: rows[0] ? (rows[0].match(/class="channel_name"[^>]*>([\s\S]*?)<\/span>\s*<\/td>/) || [])[1] : null,
    tailOfRow: rows[0] ? rows[0].slice(-1600).replace(/\s+/g, ' ') : null
  };

  // 2) TV Garden data paths
  out.tvgarden = {};
  for (const p of ['/api/tv/channels/es.json', '/api/tv/es/channels.json', '/api/tv/countries/es.json', '/api/tv/spain.json', '/api/tv/es.json', '/api/tv/channels/spain.json', '/api/tv/mx/channels.json']) {
    const r = await get('https://tvgarden.world' + p);
    out.tvgarden[p] = { status: r.status, ctype: r.ctype, sample: (r.text || '').slice(0, 220) };
  }

  // 3) livelive24: find loadTVData definition and its URL
  const home = await get('https://livelive24.com/');
  const tvDefs = [...(home.text || '').matchAll(/[^;{}]{0,200}loadTVData[^;{}]{0,400}/g)].map(m => m[0].replace(/\s+/g, ' '));
  out.liv24 = { status: home.status, tvDefs: tvDefs.slice(0, 4), jsonRefs: pick(home.text, /["'`]([^"'`]*\.json[^"'`]*)["'`]/g, 8) };
  const ntv = await get('https://livelive24.com/test/ntv/ntv.json');
  out.liv24.ntv = { status: ntv.status, ctype: ntv.ctype, length: (ntv.text || '').length, sample: (ntv.text || '').slice(0, 700) };
  try {
    const items = JSON.parse(ntv.text);
    out.liv24.ntvSummary = { count: items.length, cats: uniq(items.map(i => i.category)).slice(0, 12), channels: items.filter(i => /tv|channel/i.test(i.category || '')).length };
  } catch { /* ignore */ }

  // 4) globalfreetv: full streams block + referrer
  for (const id of ['24Horas.es', 'La1.es', 'CanalSur2.es']) {
    const r = await get('https://www.globalfreetv.com/channels/' + id);
    const block = (r.text || '').match(/streams:\$R\[\d+\]=\[[\s\S]*?streamStatus/);
    out['gftv' + id] = {
      status: r.status,
      block: block ? block[0].replace(/\s+/g, ' ').slice(0, 1200) : null,
      urls: pick(r.text, /url:"(https?:[^"]+)"/g, 4),
      refs: pick(r.text, /http_referrer:"([^"]*)"/g, 3),
      agents: pick(r.text, /user_agent:"([^"]*)"/g, 3)
    };
  }

  // 5) tvenvivo: obfuscated config payload
  const core = await get('https://www.tvenvivo.org/live/core.php?canal=tudn', { Referer: 'https://www.tvenvivo.org/tudn-en-vivo-online.php' });
  const embedUrl = pick(core.text, /<iframe[^>]*\bsrc="([^"]+)"/gi, 1)[0];
  if (embedUrl) {
    const embed = await get(embedUrl.replace(/&amp;/g, '&'), { Referer: core.finalUrl });
    const varMatch = (embed.text || '').match(/window\['([^']+)'\]\s*=\s*'([^']+)'/);
    out.tvenvivo = {
      embedUrl: new URL(embedUrl).origin + new URL(embedUrl).pathname,
      status: embed.status,
      obfVar: varMatch ? varMatch[1] : null,
      obfLength: varMatch ? varMatch[2].length : 0,
      obfPrefix: varMatch ? varMatch[2].slice(0, 120) : null,
      base64Attempt: (() => { try { return Buffer.from(varMatch[2], 'base64').toString('utf8').slice(0, 200); } catch { return null; } })(),
      longScripts: [...(embed.text || '').matchAll(/<script(?![^>]*src)[^>]*>([\s\S]{800,20000}?)<\/script>/g)].length,
      m3u8Anywhere: (embed.text || '').includes('.m3u8'),
      hlsKeywords: pick(embed.text, /[^;{}"']{0,60}(?:\.m3u8|playlist|master)[^;{}"']{0,80}/g, 8)
    };
  }

  // 6) DaddyLive 24/7 chain (3 hops)
  out.daddy = {};
  for (const id of [51, 206]) {
    const w = await get('https://thedaddy.li/watch.php?id=' + id);
    const first = pick(w.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 2);
    const hop1 = first[0] ? await get(new URL(first[0], 'https://thedaddy.li/').href, { Referer: 'https://thedaddy.li/watch.php?id=' + id }) : null;
    const second = hop1 ? pick(hop1.text, /<iframe[^>]*\bsrc=["']([^"']+)/gi, 2) : [];
    const hop2 = second[0] ? await get(second[0].replace(/&amp;/g, '&'), { Referer: hop1.finalUrl }) : null;
    out.daddy['id' + id] = {
      iframe1: first, iframe2: second,
      src: hop2 ? (hop2.text.match(/SRC\s*=\s*["']([^"']+)/) || [])[1] : null,
      m3u8: hop2 ? pick(hop2.text, /["'](https?:[^"'<>\\\s]+?\.m3u8[^"'<>\\\s]*)["']/g, 3) : []
    };
  }

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe7.json', JSON.stringify(out, null, 1));
  console.log('probe7 done');
})();
