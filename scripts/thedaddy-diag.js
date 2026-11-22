// Diagnóstico puntual de la cadena de resolución de thedaddy.li.
// Se usa desde el workflow temporal de verificación en vivo.
const fs = require('node:fs');
const path = require('node:path');
const { get } = require('../engines/live/http');
const td = require('../engines/live/sources/thedaddy');

async function main() {
  const out = [];
  const html = await get('https://thedaddy.li/24-7-channels.php').then(r => r.text);
  const items = td.parseList(html).filter(item => td.isSpanishSignal(item.name));
  out.push({ step: 'list', items: items.length, sample: items.slice(0, 5) });
  const first = items[0];
  if (first) {
    const watchUrl = `https://thedaddy.li/watch.php?id=${first.id}`;
    const watch = await get(watchUrl, { referer: 'https://thedaddy.li/' });
    out.push({
      step: 'watch',
      status: watch.status,
      length: watch.text.length,
      iframes: [...watch.text.matchAll(/<iframe[^>]*\bsrc="([^"]+)"/gi)].map(match => match[1]).slice(0, 3),
      snippets: [...watch.text.matchAll(/[^"'<>\\\s]{0,60}(?:m3u8|stream-?\d+\.php)[^"'<>\\\s]{0,60}/gi)].map(m => m[0]).slice(0, 5)
    });
    const hops = [];
    let currentUrl = watchUrl;
    let referer = 'https://thedaddy.li/';
    for (let hop = 0; hop < 4; hop++) {
      let response;
      try {
        response = await get(currentUrl, { referer, allowHttp: true });
      } catch (error) {
        hops.push({ hop, url: currentUrl, error: error.message });
        break;
      }
      const iframe = (response.text.match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1];
      hops.push({
        hop,
        url: currentUrl,
        status: response.status,
        length: response.text.length,
        iframe: iframe || null,
        src: (response.text.match(/(?:const|var|let)\s+SRC\s*=\s*["']([^"']+)["']/i) || [])[1] || null,
        title: (response.text.match(/<title>([^<]*)<\/title>/i) || [])[1] || null
      });
      if (!iframe) break;
      referer = currentUrl;
      currentUrl = new URL(iframe, currentUrl).href;
    }
    out.push({ step: 'hops', hops });
  }
  fs.mkdirSync('reports', { recursive: true });
  return out;
}

(async () => {
  let out;
  try {
    out = await main();
  } catch (error) {
    out = [{ step: 'error', error: error.message }];
  }
  const file = path.join('reports', 'thedaddy-diag.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
})();
