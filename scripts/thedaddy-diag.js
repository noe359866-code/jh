// Diagnóstico puntual de la cadena de resolución de thedaddy.li.
// Se usa desde el workflow temporal de verificación en vivo.
const fs = require('node:fs');
const path = require('node:path');
const { get } = require('../engines/live/http');
const td = require('../engines/live/sources/thedaddy');

(async () => {
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
    const resolved = await td.resolve(watchUrl, { get }).catch(error => ({ error: error.message }));
    out.push({ step: 'resolve', resolved });
  }
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(path.join('reports', 'thedaddy-diag.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
})().catch(error => {
  console.error('ERROR', error.message);
  process.exit(1);
});
