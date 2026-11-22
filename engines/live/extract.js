// Extracción de HLS de las fuentes que sirven embeds.
//
// Algunas webs no publican el `.m3u8` en el HTML: dan una página con un iframe
// (`core.php`, `dembed.st`, blogspot…) y el reproductor saca el HLS de ahí. Esas
// fuentes se marcaban como `page` y el medio se resolvía al reproducir.
//
// Esta fase lo resuelve **durante la recolección**: recorre la cadena de embeds,
// comprueba que el `.m3u8` responde con firma HLS y lo deja en el catálogo como
// medio directo. Si algo falla (embed roto, token caducado, 403 del CDN), el canal
// conserva su enlace de página y se resuelve al reproducir, como antes.
//
// Límites para no castigar a los orígenes: concurrencia, presupuesto de tiempo y
// un solo intento por canal. Lo que no entra en el presupuesto se reintenta en la
// siguiente recolección.
const { mapLimit } = require('./limit');
const { probeMedia } = require('./checker');

const DEFAULTS = {
  concurrency: 10,
  budgetMs: 60000,
  probeTimeoutMs: 6000
};

function hasDirect(channel) {
  return (channel.streams || []).some(stream => stream.kind !== 'page' && /^https?:\/\//i.test(stream.url || ''));
}

/** Canales a enriquecer: tienen página de origen y ningún medio directo todavía. */
function extractable(channels) {
  return (channels || []).filter(channel =>
    !hasDirect(channel) && (channel.streams || []).some(stream => stream.kind === 'page'));
}

/**
 * Extrae el HLS de un canal y, si responde, lo antepone a sus medios.
 * Devuelve `'extracted' | 'failed' | 'skipped'`.
 */
async function extractChannel(channel, { get, byId, probe = probeMedia, probeTimeoutMs = DEFAULTS.probeTimeoutMs } = {}) {
  const page = (channel.streams || []).find(stream => stream.kind === 'page');
  if (!page) return 'skipped';
  const source = byId(page.source);
  if (!source || typeof source.resolve !== 'function') return 'skipped';

  let resolved = null;
  try {
    resolved = await source.resolve(page.url, { get });
  } catch {
    return 'failed';
  }
  if (!resolved || !/^https?:\/\//i.test(resolved.url || '')) return 'failed';

  // Sin firma HLS no se publica: sería anunciar un medio que no reproduce (el CDN
  // de DaddyLive devuelve 403 a cualquier cliente que no sea un navegador real).
  let result;
  try {
    result = await probe(resolved.url, { get, referer: resolved.referer, timeoutMs: probeTimeoutMs, retries: 0 });
  } catch {
    return 'failed';
  }
  if (!result || !result.ok) return 'failed';

  channel.streams.unshift({
    url: resolved.url,
    referer: resolved.referer || null,
    source: page.source,
    kind: 'hls',
    extracted: true
  });
  return 'extracted';
}

/**
 * Enriquece la lista de canales en sitio (muta `channel.streams`). Devuelve el
 * recuento por resultado, sin lanzar nunca: la recolección no debe romperse
 * porque un embed falle.
 */
async function enrich(channels, {
  get,
  byId,
  concurrency = DEFAULTS.concurrency,
  budgetMs = DEFAULTS.budgetMs,
  probe = probeMedia,
  probeTimeoutMs = DEFAULTS.probeTimeoutMs,
  now = Date.now,
  status = null
} = {}) {
  const targets = extractable(channels);
  const counts = { targets: targets.length, extracted: 0, failed: 0, skipped: 0 };
  if (!targets.length) return counts;
  const startedAt = now();

  await mapLimit(targets, concurrency, async channel => {
    if (now() - startedAt > budgetMs) {
      counts.skipped++;
      return;
    }
    let outcome;
    try {
      outcome = await extractChannel(channel, { get, byId, probe, probeTimeoutMs });
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'extracted') {
      counts.extracted++;
      if (status) status[channel.sources[0]] = { ...(status[channel.sources[0]] || {}), extracted: (status[channel.sources[0]] && status[channel.sources[0]].extracted || 0) + 1 };
    } else if (outcome === 'failed') {
      counts.failed++;
    } else {
      counts.skipped++;
    }
  });

  return counts;
}

/**
 * Busca un `.m3u8` literal en HTML/JS y lo devuelve desescapado.
 * Acepta `https://…`, `https:\/\/…` (barras escapadas) y `https%3A%2F%2F…`,
 * dentro de una cadena entrecomillada o como atributo HTML.
 */
function unescapeJsUrl(value) {
  return String(value)
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function findHlsLiteral(text) {
  const raw = String(text || '');

  // A) Cadena entrecomillada. El `.m3u8` puede ser el final de la URL o llevar
  // query (`?token=…`), así que se acepta cualquier cosa menos comilla/espacio.
  const quoted = raw.match(/["'](https?(?::|%3A)(?:(?!["'<>\s]).){0,1500}?\.m3u8(?:(?!["'<>\s]).){0,600})["']/i);
  if (quoted) {
    const cleaned = unescapeJsUrl(quoted[1]);
    const decoded = /^https?%3A/i.test(cleaned) ? decodeURIComponent(cleaned) : cleaned;
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }

  // B) Sin comillas (atributo `src`, `file:` de un JSON…).
  const bare = raw.match(/(https?:\/\/[^"'<>\s]{0,1500}?\.m3u8[^"'<>\s]{0,600})/i);
  return bare ? unescapeJsUrl(bare[1]) : null;
}

/**
 * Extractor genérico para fuentes sin cadena propia: busca un `.m3u8` en la
 * página, o sigue hasta 3 iframes/redirecciones de reproductor. Devuelve
 * `{ url, referer }` o `null`.
 */
async function genericResolve(pageUrl, { get, maxHops = 3 } = {}) {
  const seen = new Set();
  let current = pageUrl;
  let referer = null;
  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(current)) break;
    seen.add(current);
    let response;
    try {
      response = await get(current, { referer, allowHttp: true, maxBytes: 512 * 1024 });
    } catch {
      return null;
    }
    const text = String(response.text || '');

    // 1) HLS literal en el HTML o en el JS del reproductor. Las barras suelen
    // venir escapadas (`https:\/\/…`) dentro de una cadena de JavaScript.
    const url = findHlsLiteral(text);
    if (url) {
      return { url, referer: new URL(current).origin + '/' };
    }

    // 2) Siguiente iframe del reproductor.
    const iframe = (text.match(/<iframe[^>]*\bsrc="([^"]+)"/i) || [])[1];
    if (!iframe) return null;
    const next = new URL(iframe.replace(/&amp;/g, '&'), current);
    // Los embeds de blogspot/google no llevan a un reproductor propio.
    if (/blogspot\.com|googleusercontent|google\.com\/sorry/i.test(next.hostname + next.pathname)) return null;
    referer = current;
    current = next.href;
  }
  return null;
}

module.exports = { enrich, extractChannel, extractable, hasDirect, genericResolve, findHlsLiteral, DEFAULTS };
