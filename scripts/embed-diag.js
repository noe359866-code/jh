// Diagnóstico de embeds: muestra QUÉ devuelve cada paso sin exponer URLs.
// Guarda hosts, tamaños y marcas (iframe, m3u8, base64) con las URLs enmascaradas.
const fs = require('node:fs');
const { get } = require('../engines/live/http');
const { sources } = require('../engines/live/sources');

const mask = text => String(text)
  .replace(/https?:\/\/[^\s"'<>]+/g, url => {
    try {
      const u = new URL(url);
      return `<${u.hostname}${u.pathname.replace(/[a-z0-9]{12,}/gi, '***')}>`;
    } catch { return '<url>'; }
  });

const describe = text => {
  const t = String(text || '');
  return {
    length: t.length,
    iframes: [...t.matchAll(/<iframe[^>]*\b(?:data-)?src=["']([^"']+)["']/gi)].map(m => {
      try { return new URL(m[1]).hostname; } catch { return 'relativo'; }
    }),
    m3u8: (t.match(/\.m3u8/gi) || []).length,
    scripts: (t.match(/<script/gi) || []).length,
    videoTags: (t.match(/<video/gi) || []).length,
    base64Blobs: (t.match(/["'][A-Za-z0-9+/=]{40,}["']/g) || []).length,
    head: mask(t.slice(0, 300)).replace(/\s+/g, ' ')
  };
};

(async () => {
  const out = [];
  for (const id of ['tvenvivo', 'thedaddy', 'livelive24']) {
    const source = sources.find(item => item.id === id);
    if (!source) continue;
    let entries = [];
    try {
      entries = await source.collect({ get });
    } catch (error) {
      out.push({ source: id, collectError: error.message });
      continue;
    }
    for (const entry of entries.slice(0, 2)) {
      const page = (entry.streams || []).find(s => s.kind === 'page');
      if (!page) continue;
      const paso = { source: id, canal: entry.name, url: mask(page.url) };
      try {
        const first = await get(page.url, { referer: 'https://www.tvenvivo.org/' });
        paso.paso1 = describe(first.text);
        const iframe = (String(first.text).match(/<iframe[^>]*\b(?:data-)?src=["']([^"']+)["']/i) || [])[1];
        if (iframe) {
          const abs = new URL(iframe.replace(/&amp;/g, '&'), page.url).href;
          const second = await get(abs, { referer: page.url, headers: { Origin: new URL(page.url).origin, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' } }).catch(e => ({ error: e.message }));
          paso.paso2 = second.error ? { error: second.error } : describe(second.text);
        }
      } catch (error) {
        paso.error = error.message;
      }
      out.push(paso);
    }
  }
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/embed-diag.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1).slice(0, 6000));
})().catch(error => { console.error(error.message); process.exit(1); });
