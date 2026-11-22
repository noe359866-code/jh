// TEMPORARY development probe #8 (deleted before the final commit).
const fs = require('node:fs');
const zlib = require('node:zlib');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    let text;
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) { try { text = zlib.gunzipSync(buffer).toString('utf8'); } catch { text = buffer.toString('utf8'); } }
    else text = buffer.toString('utf8');
    return { status: response.status, finalUrl: response.url, ctype: response.headers.get('content-type'), text };
  } catch (error) { return { error: error.message }; }
}

(async () => {
  const out = {};

  // a) livelive24 TV list
  const tv = await get('https://livelive24.com/tv.json');
  out.liv24tv = { status: tv.status, ctype: tv.ctype, length: (tv.text || '').length, sample: (tv.text || '').slice(0, 900) };
  try {
    const list = JSON.parse(tv.text);
    out.liv24tvSummary = {
      count: list.length, keys: Object.keys(list[0] || {}),
      countries: [...new Set(list.map(x => x.country).filter(Boolean))].slice(0, 20),
      spanish: list.filter(x => /^(es|mx|ar|co|cl|pe|ve|ec|gt|hn|sv|ni|cr|pa|cu|do|pr|uy|py|bo)$/i.test(x.country || '')).length,
      esSample: list.filter(x => /^es$/i.test(x.country || '')).slice(0, 3)
    };
  } catch (error) { out.liv24tvSummary = { error: error.message }; }

  // b) TV Garden data
  const tvg = await get('https://tvgarden.world/api/tv/countries/es.json');
  out.tvgardenEs = { status: tvg.status, length: (tvg.text || '').length, sample: (tvg.text || '').slice(0, 500) };
  try {
    const list = JSON.parse(tvg.text);
    out.tvgardenEsSummary = { count: list.length, keys: Object.keys(list[0] || {}), first: list[0], sample: list.slice(0, 2) };
  } catch (error) { out.tvgardenEsSummary = { error: error.message }; }
  const tvgMx = await get('https://tvgarden.world/api/tv/countries/mx.json');
  try { out.tvgardenMxCount = JSON.parse(tvgMx.text).length; } catch { out.tvgardenMxCount = null; }

  // c) tvenvivo signed embed: literal HLS + verification
  const page = await get('https://www.tvenvivo.org/tudn-en-vivo-online.php');
  const core = await get('https://www.tvenvivo.org/live/core.php?canal=tudn', { Referer: page.finalUrl });
  const iframe = ((core.text || '').match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1];
  if (iframe) {
    const embed = await get(iframe.replace(/&amp;/g, '&'), { Referer: core.finalUrl });
    const urls = [...new Set([...(embed.text || '').matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+?\.m3u8[^"'<>\\\s]*/g)].map(m => m[0].replace(/\\\//g, '/')))];
    out.tvenvivo = { embedStatus: embed.status, found: urls.slice(0, 4) };
    if (urls[0]) {
      const media = await get(urls[0], { Range: 'bytes=0-2048', Referer: embed.finalUrl, Origin: 'https://deportes.ksdjugfssddeports.com' });
      out.tvenvivo.verify = { status: media.status, prefix: (media.text || '').slice(0, 60) };
    }
    // Where does the literal URL live? show context around it.
    const idx = (embed.text || '').indexOf('.m3u8');
    out.tvenvivo.context = idx > 0 ? embed.text.slice(Math.max(0, idx - 600), idx + 300).replace(/\s+/g, ' ') : null;
  }

  // d) iptvcat chunk parse
  const spain = await get('https://iptvcat.net/spain__2');
  const markers = [...(spain.text || '').matchAll(/<tr class="border-solid belongs_to_\d+">/g)].map(m => m.index);
  const chunks = markers.slice(0, 3).map((start, i) => (spain.text || '').slice(start, markers[i + 1] || start + 4000));
  out.iptvcat = {
    status: spain.status,
    rows: markers.length,
    chunkLengths: chunks.map(c => c.length),
    clean: chunks.map(c => c.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' | ').replace(/\s+/g, ' ').slice(0, 300)),
    clipboards: chunks.map(c => (c.match(/data-clipboard-text="([^"]+)"/) || [])[1] || null),
    titles: chunks.map(c => (c.match(/<span class="channel_name"[^>]*title="([^"]*)"/) || [])[1] || null),
    nameInner: chunks.map(c => (c.match(/<span class="channel_name"[^>]*>([\s\S]{0,120}?)<\/span>/) || [])[1] || '').map(s => s.replace(/<[^>]+>/g, '').trim())
  };

  // e) eja: US Spanish filter
  const usSpa = await get('https://eja.tv/?country=us&language=spa');
  out.ejaUsSpa = { total: ((usSpa.text || '').match(/(\d+) live iptv channels/i) || [])[1] };

  // g) DaddyLive media verification with Referer
  out.daddy = {};
  const dl = await get('https://edge.wedd48c.top/premium51/index.m3u8', { Range: 'bytes=0-2048', Referer: 'https://dembed.st/' });
  out.daddy.direct = { status: dl.status, ctype: dl.ctype, prefix: (dl.text || '').slice(0, 80) };

  // h) globalfreetv: does the /channels page support country filter and full pagination?
  const gCh = await get('https://www.globalfreetv.com/channels?country=ES');
  out.gftvChannels = { status: gCh.status, channels: [...new Set([...(gCh.text || '').matchAll(/\/channels\/([A-Za-z0-9._-]+)/g)].map(m => m[1]))].length, esIds: [...new Set([...(gCh.text || '').matchAll(/\/channels\/([A-Za-z0-9._-]+\.es)/g)].map(m => m[1]))].slice(0, 5) };

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/probe8.json', JSON.stringify(out, null, 1));
  console.log('probe8 done');
})();
