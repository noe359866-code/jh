const { lookup } = require('node:dns').promises;
const { publicAddress, publicFetch } = require('../embed69/network');
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
  const scripts = [];
  for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try { scripts.push(new URL(match[1], base).href); } catch { /* malformed script */ }
  }
  // Players may expose extensionless URLs in a typed <source> element.
  for (const match of text.matchAll(/<source\b[^>]*>/gi)) {
    const src = match[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    const type = match[0].match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (src && type && /^(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|video\/mp4)$/i.test(type[1])) {
      try { media.add(new URL(src[1], base).href); } catch { /* malformed source */ }
    }
  }
  return { media: [...media], frames: [...frames], scripts };
}

// No script execution, cookie handling, CAPTCHA solving, or DRM circumvention.
function createExtractor({ allowedHosts = ['embed69.org'], fetchImpl = publicFetch, lookupImpl = lookup,
  timeoutMs = 10000, maxPages = 5, maxBytes = 2 * 1024 * 1024, name = 'Media', followScripts = false, onEvent = () => {} } = {}) {
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  async function request(raw, headers = {}) {
    const url = new URL(raw);
    onEvent({ stage: 'request', host: url.hostname });
    if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password
      || !hosts.has(url.hostname)) {
      onEvent({ stage: 'blocked-host', host: url.hostname });
      throw new Error('Extractor URL is not allowed');
    }
    const addresses = await lookupImpl(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Non-public destination blocked');
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers });
    onEvent({ stage: 'response', host: url.hostname, status: response.status });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Media request failed: HTTP ${response.status}`);
    }
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
        if (size > maxBytes) throw new Error('Response exceeds extractor size limit');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  async function verify(url) {
    const response = await request(url, { Range: 'bytes=0-65535' });
    // Read only a prefix, including when a server ignores Range.
    const reader = response.body.getReader();
    let prefix = Buffer.alloc(0);
    try {
      while (prefix.length < 512) {
        const { done, value } = await reader.read();
        if (done) break;
        prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 65536)]);
      }
    } finally { await reader.cancel(); }
    const hls = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
    const mp4 = prefix.length >= 12 && prefix.toString('ascii', 4, 8) === 'ftyp';
    return hls || mp4;
  }
  async function extract(pageUrl) {
    const queue = [pageUrl];
    const visited = new Set();
    const candidates = new Set();
    const streams = [];
    while (queue.length && visited.size < maxPages) {
      const page = queue.shift();
      if (visited.has(page)) continue;
      visited.add(page);
      let parsed;
      try {
        const response = await request(page);
        parsed = parsePage((await readLimited(response)).toString('utf8'), page);
      } catch (error) {
        if (page === pageUrl) throw error;
        onEvent({ stage: 'page-failed', host: new URL(page).hostname });
        continue;
      }
      onEvent({ stage: 'page', host: new URL(page).hostname, candidates: parsed.media.length, frames: parsed.frames.length, scripts: parsed.scripts.length });
      for (const url of parsed.media) candidates.add(url);
      for (const frame of [...parsed.frames, ...(followScripts ? parsed.scripts : [])]) {
        if (hosts.has(new URL(frame).hostname) && queue.length < maxPages) queue.push(frame);
        else if (!hosts.has(new URL(frame).hostname)) onEvent({ stage: 'blocked-frame', host: new URL(frame).hostname });
      }
    }
    for (const url of [...candidates].slice(0, 10)) {
      try {
        const verified = await verify(url);
        onEvent({ stage: 'candidate', host: new URL(url).hostname, verified });
        if (verified) streams.push({ name, title: 'HLS / MP4', url });
      } catch { onEvent({ stage: 'candidate-failed', host: new URL(url).hostname }); }
    }
    return streams;
  }
  return { extract, verify };
}
module.exports = { createExtractor, parsePage, publicAddress };
