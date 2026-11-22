// Diagnóstico puntual de la cadena de resolución de thedaddy.li.
// Se usa desde el workflow temporal de verificación en vivo; escribe siempre un
// volcado (incluso si falla a medias) para que el diagnóstico sea legible.
const fs = require('node:fs');
const path = require('node:path');
const { get } = require('../engines/live/http');
const td = require('../engines/live/sources/thedaddy');

const out = [];
let flushed = false;

function flush() {
  if (flushed) return;
  flushed = true;
  try {
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(path.join('reports', 'thedaddy-diag.json'), JSON.stringify(out, null, 1));
  } catch (error) {
    console.error('no se pudo escribir el diagnóstico:', error.message);
  }
}

process.on('exit', flush);

async function main() {
  const html = await get('https://thedaddy.li/24-7-channels.php').then(r => r.text);
  const items = td.parseList(html).filter(item => td.isSpanishSignal(item.name));
  out.push({ step: 'list', items: items.length, sample: items.slice(0, 6) });
  const first = items[0];
  if (!first) return;

  const watchUrl = `https://thedaddy.li/watch.php?id=${first.id}`;
  const watch = await get(watchUrl, { referer: 'https://thedaddy.li/' });
  out.push({
    step: 'watch',
    status: watch.status,
    length: watch.text.length,
    iframes: [...watch.text.matchAll(/<iframe[^>]*\bsrc="([^"]+)"/gi)].map(match => match[1]).slice(0, 3)
  });

  const playerUrl = `https://thedaddy.li/stream/stream-${first.id}.php`;
  const player = await get(playerUrl, { referer: watchUrl });
  out.push({ step: 'player', status: player.status, length: player.text.length, iframe: (player.text.match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1] || null });
  const embedUrl = new URL((player.text.match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1] || '', playerUrl).href;
  out.push({ step: 'embed-url', embedUrl });

  const variants = [
    ['sin-referer', {}],
    ['referer-thedaddy', { referer: 'https://thedaddy.li/' }],
    ['referer-watch', { referer: watchUrl }],
    ['referer-player', { referer: playerUrl }],
    ['referer-self', { referer: 'https://dembed.st/' }],
    ['con-origin', { referer: playerUrl, headers: { Origin: 'https://thedaddy.li', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' } }],
    ['sin-sec-fetch', { referer: playerUrl, headers: { 'Sec-Fetch-Dest': '', 'Sec-Fetch-Mode': '', 'Sec-Fetch-Site': '' } }]
  ];
  for (const [name, options] of variants) {
    try {
      const response = await get(embedUrl, options);
      out.push({ step: 'embed', variant: name, status: response.status, length: response.text.length, hasSrc: /SRC\s*=/.test(response.text), head: response.text.slice(0, 200).replace(/\s+/g, ' ') });
    } catch (error) {
      out.push({ step: 'embed', variant: name, error: error.message });
    }
  }

  // Con la combinación válida, extraer el SRC y comprobar si el medio responde.
  try {
    const ok = await get(embedUrl, { referer: playerUrl, headers: { Origin: 'https://thedaddy.li', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' } });
    const src = (ok.text.match(/(?:const|var|let)\s+SRC\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
    out.push({ step: 'src', src });
    if (src) {
      for (const [name, headers] of [['sin-referer', {}], ['referer-embed', { referer: embedUrl }], ['referer-thedaddy', { referer: 'https://thedaddy.li/' }]]) {
        try {
          const probe = await get(src, { headers, maxBytes: 4096, timeoutMs: 10000 });
          out.push({ step: 'media', variant: name, status: probe.status, length: probe.text.length, head: probe.text.slice(0, 80) });
        } catch (error) {
          out.push({ step: 'media', variant: name, error: error.message });
        }
      }
    }
  } catch (error) {
    out.push({ step: 'src-error', error: error.message });
  }

  for (const url of [`https://thedaddy.li/cast/stream-${first.id}.php`, `https://thedaddy.li/plus/stream-${first.id}.php`]) {
    try {
      const response = await get(url, { referer: watchUrl });
      out.push({ step: 'alternate', url, status: response.status, length: response.text.length, iframe: (response.text.match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1] || null });
    } catch (error) {
      out.push({ step: 'alternate', url, error: error.message });
    }
  }
}

main()
  .catch(error => out.push({ step: 'error', error: error.message }))
  .finally(() => {
    flush();
    console.log(JSON.stringify(out, null, 1).slice(0, 5000));
  });
