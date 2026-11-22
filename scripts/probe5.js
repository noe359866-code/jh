// TEMPORARY development probe #5 (deleted before the final commit).
const fs = require('node:fs');
const zlib = require('node:zlib');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    let text;
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) { try { text = zlib.gunzipSync(buffer).toString('utf8'); } catch { text = buffer.toString('utf8'); } }
    else text = buffer.toString('utf8');
    return { status: response.status, finalUrl: response.url, ctype: response.headers.get('content-type'), text };
  } catch (error) { return { error: error.message }; }
}
const cards = html => (html.match(/class="card h-100"/g) || []).length;

(async () => {
  const out = {};

  // 1) eja: find a page-size parameter
  for (const q of ['limit=48', 'limit=100', 'limit=500', 'per_page=100', 'page=2', 'limit=0&offset=0']) {
    const r = await get('https://eja.tv/?country=es&' + q);
    out['eja:' + q] = { status: r.status, cards: r.text ? cards(r.text) : null, total: ((r.text || '').match(/(\d+) live iptv channels/i) || [])[1] };
  }
  const ejaJson = await get('https://eja.tv/api.php?country=es');
  out['eja:api.php'] = { status: ejaJson.status, ctype: ejaJson.ctype, sample: (ejaJson.text || '').slice(0, 200) };

  // 2) TV Garden: API layout from the bundle + metadata
  const meta = await get('https://tvgarden.world/api/tv/countries_metadata.json');
  out.tvgardenMetadata = { status: meta.status, sample: (meta.text || '').slice(0, 600) };
  const bundle = await get('https://tvgarden.world/assets/index-CBAd3Qpf.js');
  if (bundle.text) {
    const apiPaths = [...new Set([...bundle.text.matchAll(/["'`](\/api\/[^"'`]{2,80})["'`]/g)].map(m => m[1]))];
    out.tvgardenBundle = { status: bundle.status, length: bundle.text.length, apiPaths: apiPaths.slice(0, 30), countriesRef: (bundle.text.match(/[^"'`]{0,60}countries_metadata[^"'`]{0,80}/g) || []).slice(0, 5) };
    const probePaths = apiPaths.map(p => p.replace(/\$\{[^}]+\}/g, 'es')).slice(0, 8);
    out.tvgardenApiProbes = {};
    for (const p of probePaths) {
      const r = await get('https://tvgarden.world' + p);
      out.tvgardenApiProbes[p] = { status: r.status, sample: (r.text || '').slice(0, 300) };
    }
  }

  // 3) tvenvivo: player core with a browser-like Referer
  const ref = 'https://www.tvenvivo.org/tudn-en-vivo-online.php';
  for (const p of ['/live/core.php?canal=tudn', '/live2/core.php?canal=tudn', '/live3/core.php?canal=tudn']) {
    const r = await get('https://www.tvenvivo.org' + p, { Referer: ref, Accept: 'text/html,application/xhtml+xml' });
    out['tvenvivo' + p] = { status: r.status, finalUrl: r.finalUrl, len: (r.text || '').length, iframes: [...new Set([...(r.text || '').matchAll(/<iframe[^>]*\bsrc=["']([^"']+)/gi)].map(m => m[1]))].slice(0, 6), hls: [...new Set([...(r.text || '').matchAll(/["'](https?:[^"'<>\\\s]+?\.(?:m3u8|mp4|webm|mpd)[^"'<>\\\s]*)["']/g)].map(m => m[1]))].slice(0, 6) };
  }

  // 4) livelive24: TV list json and catalog endpoints
  for (const p of ['/test/ntv/ntv.json', '/test/ntv/ntv_channels.json', '/ntv.json']) {
    const r = await get('https://livelive24.com' + p);
    out['liv24' + p] = { status: r.status, ctype: r.ctype, sample: (r.text || '').slice(0, 700) };
  }
  const llHome = await get('https://livelive24.com/');
  out.liv24Home = {
    ntvRefs: [...new Set([...(llHome.text || '').matchAll(/[^"'`\s]{0,80}ntv[^"'`\s]{0,80}/gi)].map(m => m[0]))].slice(0, 10),
    playerRefs: [...new Set([...(llHome.text || '').matchAll(/[^"'`\s]{0,60}(?:player|embed|watch)[^"'`\s]{0,60}/gi)].map(m => m[0]))].slice(0, 12)
  };

  // 5) DaddyLive embed: is any m3u8 discoverable statically?
  const embed = await get('https://dembed.st/premiumtv/daddy.php?id=1');
  out.daddy = {
    status: embed.status, len: (embed.text || '').length,
    m3u8: [...new Set([...(embed.text || '').matchAll(/["'](https?:[^"'<>\\\s]+?\.m3u8[^"'<>\\\s]*)["']/g)].map(m => m[1]))].slice(0, 5),
    literalM3u8: (embed.text || '').includes('.m3u8'),
    keys: [...new Set([...(embed.text || '').matchAll(/(?:jwplayer|file|source|src|hls|dash|playlist)\s*[:=]\s*["'][^"']{5,120}/gi)].map(m => m[0]))].slice(0, 10)
  };

  // 6) iptvcat: which country slugs exist for Spanish-speaking countries
  const iptvHome = await get('https://iptvcat.net/');
  const slugs = [...new Set([...(iptvHome.text || '').matchAll(/href="\/([a-z_]+__\d+)"/g)].map(m => m[1]))];
  const wanted = /^(spain|mexico|argentina|colombia|chile|peru|venezuela|ecuador|guatemala|honduras|el_salvador|nicaragua|costa_rica|panama|cuba|dominican_republic|puerto_rico|uruguay|paraguay|bolivia|united_states)/;
  out.iptvcatSlugs = slugs.filter(s => wanted.test(s));
  const testSlug = await get('https://iptvcat.net/' + (out.iptvcatSlugs[0] || 'spain__1'));
  out.iptvcatRowSample = testSlug.text ? (testSlug.text.match(/<tr class="border-solid belongs_to_[\s\S]{0,900}?<\/td>/) || [''])[0].replace(/\s+/g, ' ') : null;

  // 7) globalfreetv: country slug list + pagination on a country page
  const gAll = await get('https://www.globalfreetv.com/countries');
  out.gftvSlugs = [...new Set([...(gAll.text || '').matchAll(/\/countries\/([a-z-]+)"/g)].map(m => m[1]))];
  const gEs = await get('https://www.globalfreetv.com/countries/ES?page=2');
  out.gftvEsPage2 = { status: gEs.status, channels: [...new Set([...(gEs.text || '').matchAll(/\/channels\/([A-Za-z0-9._-]+)/g)].map(m => m[1]))].slice(0, 6), count: ((gEs.text || '').match(/\/channels\/[A-Za-z0-9._-]+/g) || []).length };

  // 8) Signature check on real media found on eja
  const ejaPage = await get('https://eja.tv/?country=es');
  const src = (ejaPage.text || '').match(/<source src="(https?:\/\/[^"#]+)/);
  if (src) {
    const media = await get(src[1], { Range: 'bytes=0-4096', Referer: 'https://eja.tv/' });
    out.ejaMediaCheck = { host: new URL(src[1]).hostname, status: media.status, prefix: (media.text || '').slice(0, 40) };
  }

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe5.json', JSON.stringify(out, null, 1));
  console.log('probe5 done');
})();
