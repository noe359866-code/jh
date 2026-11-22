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

/** Busca la fuente por id o por nombre visible (`tvenvivo` / `tvenvivo.org`). */
function resolveSource(byId, sourceName) {
  if (!sourceName || typeof byId !== 'function') return null;
  const direct = byId(sourceName);
  if (direct) return direct;
  const name = String(sourceName).toLowerCase();
  for (const source of require('./sources').sources) {
    if (source.id === name || String(source.name || '').toLowerCase() === name) return source;
  }
  return null;
}

const DEFAULTS = {
  // Bajo a propósito: los orígenes con embeds (DaddyLive, TVEnVivo) devuelven
  // 403 si se les piden decenas de cadenas a la vez.
  concurrency: 3,
  budgetMs: 100000,
  probeTimeoutMs: 6000,
  // Pausa entre canales del mismo origen para no disparar su limitador.
  pauseMs: 250,
  // Si un origen no entrega ni un HLS en varias recolecciones seguidas, se deja
  // de intentar un tiempo: gastar 90 s por vuelta para 0 resultados no compensa.
  penaltyAfter: 2,
  penaltyMs: 6 * 60 * 60 * 1000
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
 * Devuelve `'extracted' | 'failed' | 'skipped'`; el motivo detallado se escribe
 * en `diag.reason` (para diagnóstico, nunca en el resultado público).
 */
async function extractChannel(channel, {
  get, byId, probe = probeMedia, timeoutMs = DEFAULTS.probeTimeoutMs, diag = null,
  pauseMs = DEFAULTS.pauseMs, wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  // El estado público es siempre 'failed'/'skipped'; el motivo va a `diag`.
  const note = (reason, outcome = 'failed') => {
    if (diag) diag.reason = reason;
    return outcome;
  };
  const page = (channel.streams || []).find(stream => stream.kind === 'page');
  if (!page) return 'skipped';
  // `stream.source` es el nombre visible (`tvenvivo.org`), no el id del registro
  // (`tvenvivo`): se resuelve por id y, si no, por nombre.
  const source = resolveSource(byId, page.source);
  if (!source || typeof source.resolve !== 'function') return note('sin resolutor para la fuente', 'skipped');

  let resolved = null;
  // Un 403/429 en la cadena suele ser el limitador del origen: se espera y se
  // reintenta una vez antes de dar el canal por fallido.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resolved = await source.resolve(page.url, { get });
      break;
    } catch (error) {
      const temporal = /HTTP (403|429|503)/.test(String(error.message));
      if (temporal && attempt === 0 && pauseMs) {
        await wait(Math.max(pauseMs * 4, 1000));
        continue;
      }
      // La cadena propia puede haberse quedado corta (reproductor nuevo,
      // iframe anidado): se prueba el extractor genérico antes de rendirse.
      resolved = await genericResolve(page.url, { get });
      if (resolved) break;
      return note(`cadena de embed: ${String(error.message).slice(0, 60)}`);
    }
  }
  if (!resolved || !/^https?:\/\//i.test(resolved.url || '')) {
    // Fallback: el HTML de la página puede esconder el m3u8 en un JSON/base64
    // aunque la cadena documentada ya no funcione.
    resolved = await genericResolve(page.url, { get });
    if (!resolved) return note('la cadena no expone m3u8');
  }

  // Sin firma HLS no se publica: sería anunciar un medio que no reproduce (el CDN
  // de DaddyLive devuelve 403 a cualquier cliente que no sea un navegador real).
  let result;
  try {
    result = await probe(resolved.url, { get, referer: resolved.referer, timeoutMs, retries: 0 });
  } catch (error) {
    return note(`sondeo: ${String(error.message).slice(0, 60)}`);
  }
  if (!result || !result.ok) return note(`HLS no responde (${result && result.status !== undefined ? result.status : 'sin estado'})`);

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
  pauseMs = DEFAULTS.pauseMs,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  penaltyAfter = DEFAULTS.penaltyAfter,
  penaltyMs = DEFAULTS.penaltyMs,
  // Estado entre recolecciones (penalizaciones). Inyectable para pruebas.
  stats = new Map(),
  now = Date.now,
  status = null
} = {}) {
  const nowMs = () => now();
  const penalized = name => {
    const entry = stats.get(name);
    return Boolean(entry && entry.until && entry.until > nowMs());
  };
  const all = extractable(channels);
  const targets = all.filter(channel => {
    const page = (channel.streams || []).find(stream => stream.kind === 'page');
    return !penalized((page && page.source) || 'desconocida');
  });
  const counts = {
    targets: targets.length,
    candidates: all.length,
    extracted: 0,
    failed: 0,
    skipped: 0,
    penalizedSources: [...new Set(all.map(channel => {
      const page = (channel.streams || []).find(stream => stream.kind === 'page');
      return (page && page.source) || 'desconocida';
    }).filter(penalized))],
    bySource: {},
    reasons: {}
  };
  if (!targets.length) return counts;
  const startedAt = now();

  let progress = 0;
  await mapLimit(targets, concurrency, async channel => {
    progress++;
    if (progress > 0 && pauseMs) await wait(pauseMs);
    if (now() - startedAt > budgetMs) {
      counts.skipped++;
      return;
    }
    let outcome;
    const diag = {};
    try {
      outcome = await extractChannel(channel, { get, byId, probe, timeoutMs: probeTimeoutMs, diag, pauseMs, wait });
    } catch (error) {
      outcome = 'failed';
      diag.reason = `excepción: ${String(error.message).slice(0, 60)}`;
    }
    // Diagnóstico: qué fuente falla y por qué (sin URLs).
    const page = (channel.streams || []).find(stream => stream.kind === 'page');
    const key = (page && page.source) || 'desconocida';
    counts.bySource[key] = counts.bySource[key] || { extraidos: 0, fallidos: 0, omitidos: 0 };
    counts.bySource[key][outcome === 'extracted' ? 'extraidos' : outcome === 'failed' ? 'fallidos' : 'omitidos']++;
    if (diag.reason) counts.reasons[diag.reason] = (counts.reasons[diag.reason] || 0) + 1;
    if (outcome === 'extracted') {
      counts.extracted++;
      // Una entrada puede no traer `sources` (canal construido a mano o de una
      // fuente sin id): sin esta guarda la recolección reventaba al extraer.
      if (status) {
        const owner = (channel.sources || [])[0] || key;
        status[owner] = { ...(status[owner] || {}), extracted: ((status[owner] && status[owner].extracted) || 0) + 1 };
      }
    } else if (outcome === 'failed') {
      counts.failed++;
    } else {
      counts.skipped++;
    }
  });

  // Penalizar orígenes que no dieron ni un HLS en esta pasada: gastar el
  // presupuesto completo cada recolección para cero resultados no compensa.
  for (const [name, data] of Object.entries(counts.bySource)) {
    if (!data.fallidos && !data.extraidos) continue;
    const prev = stats.get(name) || { fails: 0, until: 0 };
    if (data.extraidos > 0) {
      stats.set(name, { fails: 0, until: 0 });
      continue;
    }
    const fails = prev.fails + 1;
    stats.set(name, { fails, until: fails >= penaltyAfter ? now() + penaltyMs : 0 });
  }

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

/** Quita barras invertidas y signos de cierre que arrastra el regex. */
function trimUrl(url) {
  return String(url)
    .replace(/[\\'"<>\s]+$/, '')
    .replace(/\\+$/, '')
    // `…/i.m3u8&t=2` → `…/i.m3u8?t=2` (query sin `?` por el escapado).
    .replace(/(\.m3u8)&/i, '$1?');
}

function absolutize(url, base) {
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function findHlsLiteral(text, { base = null } = {}) {
  const raw = String(text || '');

  // A) Cadena entrecomillada. El `.m3u8` puede ser el final de la URL o llevar
  // query (`?token=…`), así que se acepta cualquier cosa menos comilla/espacio.
  const quoted = raw.match(/["'](https?(?::|%3A)(?:(?!["'<>\s]).){0,1500}?\.m3u8(?:(?!["'<>\s]).){0,600})["']/i);
  if (quoted) {
    const cleaned = unescapeJsUrl(quoted[1]);
    const decoded = /^https?%3A/i.test(cleaned) ? decodeURIComponent(cleaned) : cleaned;
    if (/^https?:\/\//i.test(decoded)) return trimUrl(decoded);
  }

  // B) Sin comillas (atributo `src`, `file:` de un JSON…).
  const bare = raw.match(/(https?:\/\/[^"'<>\s]{0,1500}?\.m3u8[^"'<>\s]{0,600})/i);
  if (bare) return trimUrl(unescapeJsUrl(bare[1]));

  // C) Ruta relativa dentro de un reproductor (`file: "/hls/x/index.m3u8"`).
  const relative = raw.match(/["'](\/(?!\/)[^"'<>\s]{0,600}?\.m3u8[^"'<>\s]{0,300})["']/i);
  if (relative) return trimUrl(absolutize(unescapeJsUrl(relative[1]), base));

  return null;
}

/**
 * Muchos reproductores no escriben la URL: la guardan en base64 o en un JSON
 * escapado (`{\"sources\":[{…}]}`). Se intentan ambos envoltorios envolviendo
 * el texto decodificado.
 */
function findHlsDeep(text, { base = null } = {}) {
  const direct = findHlsLiteral(text, { base });
  if (direct) return direct;
  const raw = String(text || '');

  // Base64 con un `.m3u8` dentro (solo cadenas largas y válidas).
  for (const match of raw.matchAll(/["']([A-Za-z0-9+/=]{40,4000})["']/g)) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      if (decoded.includes('.m3u8')) {
        const found = findHlsLiteral(decoded, { base });
        if (found) return found;
      }
    } catch { /* no era base64 */ }
  }

  // JSON escapado dentro de una cadena (\"file\":\"https:\/\/…m3u8\").
  if (raw.includes('\\"') || raw.includes('%22')) {
    // `\/` y `\u0026` primero, comillas escapadas después: si se sustituyen al
    // revés queda una barra suelta al final de la URL.
    const unescaped = unescapeJsUrl(raw).replace(/\\"/g, '"').replace(/%22/g, '"');
    const found = findHlsLiteral(unescaped, { base });
    if (found) return found;
  }

  return null;
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
      response = await get(current, {
        referer,
        allowHttp: true,
        maxBytes: 1024 * 1024,
        // Muchos embeds solo responden como iframe de terceros.
        headers: referer
          ? { Origin: referer.replace(/\/$/, ''), 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' }
          : {}
      });
    } catch {
      return null;
    }
    const text = String(response.text || '');

    // 1) HLS literal en el HTML o en el JS del reproductor. Las barras suelen
    // venir escapadas (`https:\/\/…`) dentro de una cadena de JavaScript.
    const url = findHlsDeep(text, { base: current });
    if (url) {
      return { url, referer: new URL(current).origin + '/' };
    }

    // 1b) `<video>`/`<source>` con el m3u8 (a veces en `data-src`).
    const mediaTag = text.match(/<(?:source|video)[^>]+\b(?:data-)?src=["']([^"']*\.m3u8[^"']*)["']/i);
    if (mediaTag) {
      return { url: absolutize(mediaTag[1], current), referer: new URL(current).origin + '/' };
    }

    // 2) Siguiente iframe del reproductor. Algunos usan `data-src` o van en un
    // `<video><source>`.
    const iframe = (text.match(/<iframe[^>]*\b(?:data-)?src=["']([^"']+)["']/i) || [])[1];
    if (!iframe) return null;
    const next = new URL(iframe.replace(/&amp;/g, '&'), current);
    // Los embeds de blogspot/google no llevan a un reproductor propio.
    if (/blogspot\.com|googleusercontent|google\.com\/sorry/i.test(next.hostname + next.pathname)) return null;
    referer = current;
    current = next.href;
  }
  return null;
}

// Penalizaciones compartidas entre recolecciones del mismo proceso.
const sharedStats = new Map();

module.exports = {
  enrich, extractChannel, extractable, hasDirect, genericResolve,
  findHlsLiteral, findHlsDeep, resolveSource, sharedStats, DEFAULTS
};
