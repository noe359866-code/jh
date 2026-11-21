const { lookup } = require('node:dns').promises;
const { publicAddress, publicFetch } = require('./network');
function decode(text) {
  return text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&');
}
function parsePage(html, base) {
  const media = new Set();
  const frames = new Set();
  const text = decode(html);
  for (const match of text.matchAll(/["']([^"'<>\s]+\.(?:m3u8|mp4)(?:\?[^"'<>\s]*)?)["']/gi)) {
    try { media.add(new URL(match[1], base).href); } catch { /* malformed candidate */ }
  }
  for (const match of text.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try { frames.add(new URL(match[1], base).href); } catch { /* malformed frame */ }
  }
  return { media: [...media], frames: [...frames] };
}

// Fetch compartido para proveedores y resolvedores. Aplica las políticas de
// seguridad: solo HTTPS, sin credenciales, destinos públicos IPv4, sin
// redirecciones. No ejecuta scripts, no maneja cookies, no resuelve CAPTCHAs.
function createFetcher({
  allowedHosts = [],
  fetchImpl = publicFetch,
  lookupImpl = lookup,
  timeoutMs = 10000,
  maxBytes = 2 * 1024 * 1024,
  pageReferer,
  onEvent = () => {}
} = {}) {
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  const DEFAULT_HEADERS = {
    // Los sitios públicos suelen rechazar peticiones sin User-Agent de navegador.
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  async function request(raw, headers = {}) {
    const url = new URL(raw);
    onEvent({ stage: 'request', host: url.hostname });
    if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password
      || !hosts.has(url.hostname)) {
      onEvent({ stage: 'blocked-host', host: url.hostname });
      throw new Error('Enlace no permitido: host no confiable');
    }
    const addresses = await lookupImpl(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw new Error('Destino no público bloqueado');
    }
    // Referencia al origen del sitio al verificar medios: algunos hosts
    // rechazan peticiones Range sin un Referer del mismo sitio.
    const referer = typeof pageReferer === 'string' && pageReferer ? pageReferer : undefined;
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}), ...headers } });
    if (!response.ok) throw new Error(`Solicitud fallida: HTTP ${response.status}`);
    return response;
  }
  async function readLimited(response) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('Respuesta excede el límite de tamaño');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  async function getText(raw, headers = {}) {
    const response = await request(raw, headers);
    return (await readLimited(response)).toString('utf8');
  }
  async function verify(url) {
    const response = await request(url, { Range: 'bytes=0-65535' });
    const reader = response.body.getReader();
    let prefix = Buffer.alloc(0);
    try {
      while (prefix.length < 512) {
        const { done, value } = await reader.read();
        if (done) break;
        prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 65536)]);
      }
    } finally { await reader.cancel(); }
    const hls = prefix.toString('utf8').replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
    const mp4 = prefix.length >= 12 && prefix.toString('ascii', 4, 8) === 'ftyp';
    return hls || mp4;
  }
  return { request, getText, verify, readLimited, parsePage };
}


// Extractores genéricos: recorre la página (y iframes del mismo sitio)
// buscando candidatos literales .m3u8/.mp4 y verifica la firma. Es el
// resolvedor por defecto para hosts de reproductor no reconocidos.
function createExtractor({ allowedHosts = ['documaniatv.com', 'flixlatam.com', 'poseidonhd2.co'],
  fetchImpl = publicFetch, lookupImpl = lookup,
  timeoutMs = 10000, maxPages = 5, maxBytes = 2 * 1024 * 1024,
  name = 'Sites', title = 'HLS / MP4', pageReferer, onEvent = () => {} } = {}) {
  const fetcher = createFetcher({ allowedHosts, fetchImpl, lookupImpl, timeoutMs, maxBytes, pageReferer, onEvent });
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  async function extract(pageUrl) {
    const queue = [pageUrl];
    const visited = new Set();
    const candidates = new Set();
    const streams = [];
    while (queue.length && visited.size < maxPages) {
      const page = queue.shift();
      if (visited.has(page)) continue;
      visited.add(page);
      const html = await fetcher.getText(page);
      const parsed = fetcher.parsePage(html, page);
      onEvent({ stage: 'page', host: new URL(page).hostname, candidates: parsed.media.length, frames: parsed.frames.length });
      for (const url of parsed.media) candidates.add(url);
      for (const frame of parsed.frames) {
        if (hosts.has(new URL(frame).hostname) && queue.length < maxPages) queue.push(frame);
        else if (!hosts.has(new URL(frame).hostname)) onEvent({ stage: 'blocked-frame', host: new URL(frame).hostname });
      }
    }
    for (const url of [...candidates].slice(0, 10)) {
      try {
        const verified = await fetcher.verify(url);
        onEvent({ stage: 'candidate', host: new URL(url).hostname, verified });
        if (verified) streams.push({ name, title, url });
      } catch { onEvent({ stage: 'candidate-failed', host: new URL(url).hostname }); }
    }
    return streams;
  }
  return { extract, verify: fetcher.verify };
}

module.exports = { createFetcher, createExtractor, parsePage, publicAddress };
