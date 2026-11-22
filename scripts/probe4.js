// TEMPORARY development probe #4 (deleted before the final commit).
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function get(url, extra = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...extra }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    return { status: response.status, finalUrl: response.url, ctype: response.headers.get('content-type'), text, length: text.length };
  } catch (error) { return { error: error.message }; }
}

function fact(r, limit = 3000) {
  if (!r || r.error) return { error: r && r.error };
  return { status: r.status, finalUrl: r.finalUrl, ctype: r.ctype, length: r.length, sample: r.text.slice(0, limit) };
}

(async () => {
  const out = {};

  // TV Garden data API
  for (const p of ['/api/tv/es.json', '/api/tv/countries_metadata.json', '/api/tv/mx.json', '/api/tv/categories/metadata.json']) {
    const r = await get('https://tvgarden.world' + p);
    out['tvgarden' + p] = fact(r, 1200);
  }

  // EJA pagination and language filter
  out.ejaOffset = fact(await get('https://eja.tv/?offset=6&country=es&language=&category=&search='), 200);
  const ejaOffset = await get('https://eja.tv/?offset=6&country=es&language=&category=&search=');
  out.ejaOffsetCards = ejaOffset.text ? (ejaOffset.text.match(/class="card h-100"/g) || []).length : null;
  const ejaSpa = await get('https://eja.tv/?language=spa');
  out.ejaSpa = { cards: ejaSpa.text ? (ejaSpa.text.match(/class="card h-100"/g) || []).length : null, total: ((ejaSpa.text || '').match(/(\d+) live iptv channels/i) || [])[1], next: ((ejaSpa.text || '').match(/href="\?offset=(\d+)[^"]*"/) || [])[1] };

  // IPTVCAT: resolve one signed mini playlist
  const mini = await get('https://list.iptvcat.net/my_list/s/adfa227ff2725d80166b27e86197e7b5.m3u8');
  out.iptvcatMini = fact(mini, 800);
  const iptvCat = await get('https://iptvcat.net/mexico__6');
  out.iptvcatMexico = { status: iptvCat.status, rows: (iptvCat.text.match(/border-solid belongs_to_/g) || []).length, clipboards: (iptvCat.text.match(/data-clipboard-text/g) || []).length, pages: [...new Set([...iptvCat.text.matchAll(/href="(\/[a-z_]+__\d+\/\d+)"/g)].map(m => m[1]))].slice(0, 5) };

  // TVENVIVO player core + homepage links
  for (const p of ['/live/core.php?canal=tudn', '/live2/core.php?canal=tudn', '/live3/core.php?canal=tudn']) {
    out['tvenvivo' + p] = fact(await get('https://www.tvenvivo.org' + p), 2500);
  }
  const tvHome = await get('https://www.tvenvivo.org/');
  out.tvenvivoHome = {
    status: tvHome.status,
    channelLinks: [...new Set([...tvHome.text.matchAll(/href="([^"]*-en-vivo-online\.php)"/g)].map(m => m[1]))].slice(0, 12),
    totalLinks: (tvHome.text.match(/-en-vivo-online\.php/g) || []).length
  };

  // LIVELIVE24: find LIST_API_BASE and channel page
  const ll = await get('https://livelive24.com/');
  const listBase = ll.text.match(/LIST_API_BASE\s*=\s*([^;]{0,200})/);
  out.livelive24 = {
    status: ll.status,
    listApiBase: listBase ? listBase[0] : null,
    apiHosts: [...new Set([...ll.text.matchAll(/https?:\/\/[a-z0-9.-]*(?:api|live)[a-z0-9.-]*\.[a-z]{2,}[^\s"'<)]*/gi)].map(m => m[0]))].slice(0, 15),
    tvApi: (ll.text.match(/[^;]{0,120}(?:tv|channels)[A-Z_]*API[A-Z_]*\s*=\s*[^;]{0,140}/gi) || []).slice(0, 5),
    channelParam: (ll.text.match(/[^;]{0,160}\?channel=[^;]{0,160}/gi) || []).slice(0, 3)
  };

  // GLOBALFREETV: country lists and channel payload shape
  const gCountries = await get('https://www.globalfreetv.com/countries');
  out.gftvCountries = { status: gCountries.status, all: [...new Set([...gCountries.text.matchAll(/"(\/countries\/[^"]+)"/g)].map(m => m[1]))].slice(0, 40) };
  for (const c of ['ES', 'MX', 'AR']) {
    const r = await get('https://www.globalfreetv.com/countries/' + c);
    out['gftv' + c] = { status: r.status, channels: [...new Set([...r.text.matchAll(/\/channels\/([A-Za-z0-9._-]+)/g)].map(m => m[1]))].length };
  }
  const gCh = await get('https://www.globalfreetv.com/channels/La1.es');
  const payload = gCh.text.match(/streams:\$R\[\d+\]=\[\$R\[\d+\]=\{[\s\S]{0,600}?\}\]/);
  out.gftvChannelPayload = payload ? payload[0] : null;

  // DADDY embed
  out.daddyEmbed = fact(await get('https://dembed.st/premiumtv/daddy.php?id=1'), 1500);

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe4.json', JSON.stringify(out, null, 1));
  console.log('probe4 done');
})();
