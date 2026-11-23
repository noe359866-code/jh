// Verificador de señales en directo.
//
// Un canal está "caído" solo cuando TODAS sus URLs dan un estado de muerte
// (404/410/451, dominio que no resuelve). Un 403/429/401 es "bloqueado" y un
// timeout es "sin confirmar": en ambos casos el canal puede seguir vivo desde una
// IP residencial o más tarde, así que no se elimina. Es "desconocido" cuando no
// hay forma de comprobarlo (fuente de catálogo o página sin resolutor).
// Nunca se marca caído un canal que no se pudo comprobar.
//
// El sondeo se hace bajo demanda (no bloquea el arranque) con tres límites:
// concurrencia, tiempo máximo por canal y presupuesto total del informe. Los
// canales que no caben en el presupuesto quedan "sin verificar" y se reintentan
// en la siguiente pasada.
//
// `probe` es inyectable y las pruebas no tocan la red.
const { mapLimit } = require('./limit');

const DEFAULTS = {
  concurrency: 24,
  timeoutMs: 9000,
  retries: 1,
  maxBytes: 8192,
  budgetMs: 180000,
  maxAttemptsPerChannel: 2,
  resultTtlMs: 6 * 60 * 60 * 1000,
  minSuccessRatio: 0.5,
  minSamples: 6,
  throttleStatuses: [429, 403]
};

// Estados que demuestran que la señal ya no existe.
const DEAD_STATUSES = [404, 410, 451, 'red', 'error'];
// Estados que indican bloqueo/limite del servidor, no muerte de la señal: el
// canal puede seguir vivo desde una IP residencial o más tarde.
const BLOCKED_STATUSES = [401, 403, 407, 429, 503];

const MEDIA_SIGNATURES = ['#extm3u', '#ext-x-', 'ftyp', 'webm', '<mpd', '<?xml', '#extinf'];

/** ¿El cuerpo descargado parece un medio reproducible? */
function looksPlayable(text) {
  const head = String(text || '').replace(/^\uFEFF/, '').trimStart().slice(0, 512).toLowerCase();
  if (!head) return false;
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return false;
  return MEDIA_SIGNATURES.some(signature => head.startsWith(signature) || head.includes(signature));
}

/** Clasifica un error de red/sonda en algo legible y estable. */
function statusOf(error) {
  if (!error) return null;
  const message = String(error.message || '');
  const match = message.match(/HTTP (\d{3})/);
  if (match) return Number(match[1]);
  if (/tiempo|timeout|aborted|timed out/i.test(message)) return 'timeout';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|socket/i.test(message)) return 'red';
  return 'error';
}

/**
 * Sondea una URL de medio. Devuelve `{ ok, status, signature, error }` sin
 * lanzar nunca: un fallo de red es un resultado más.
 */
async function probeOnce(url, { get, referer, timeoutMs, maxBytes }) {
  try {
    const response = await get(url, {
      referer,
      maxBytes,
      timeoutMs,
      // Los CDN de IPTV a veces sirven por HTTP: se permite tras validar destino.
      allowHttp: /^http:\/\//i.test(url),
      headers: { Range: 'bytes=0-4096', Accept: '*/*' }
    });
    const playable = looksPlayable(response.text);
    return {
      ok: playable,
      status: response.status,
      signature: playable,
      contentType: response.contentType || '',
      error: playable ? null : 'sin firma de medio'
    };
  } catch (error) {
    return { ok: false, status: statusOf(error), signature: false, error: error.message };
  }
}

/**
 * Sondea un medio con un reintento cuando el fallo es de red o de tiempo (un
 * 404/403 no se reintenta: ya es una respuesta del servidor).
 */
async function probeMedia(url, {
  get, referer, timeoutMs = DEFAULTS.timeoutMs, retries = DEFAULTS.retries, maxBytes = DEFAULTS.maxBytes
} = {}) {
  let result = await probeOnce(url, { get, referer, timeoutMs, maxBytes });
  for (let attempt = 0; attempt < retries && (result.status === 'timeout' || result.status === 'red'); attempt++) {
    result = await probeOnce(url, { get, referer, timeoutMs, maxBytes });
  }
  return result;
}

function isDirect(stream) {
  return stream && stream.kind !== 'page' && /^https?:\/\//i.test(stream.url || '');
}

/** Canales con al menos una vía de comprobación (medio directo o página). */
function checkable(channels) {
  return (channels || []).filter(channel => (channel.streams || []).some(stream => isDirect(stream) || stream.kind === 'page'));
}

/**
 * Verifica un canal: primero los medios directos (basta uno con firma) y, si no
 * hay, las páginas de origen mediante `resolvePage`. Sin resolutor, un canal de
 * solo páginas queda `ok: null` (desconocido), no caído.
 */
async function checkChannel(channel, {
  get, resolvePage, probe = probeMedia, timeoutMs, maxBytes,
  maxAttempts = DEFAULTS.maxAttemptsPerChannel
} = {}) {
  const streams = channel.streams || [];
  const direct = streams.filter(isDirect).slice(0, maxAttempts);
  const pages = streams.filter(stream => stream.kind === 'page').slice(0, maxAttempts);
  const attempts = [];

  const verdict = attemptsFor => {
    // Un canal es "caído" solo si TODOS sus intentos dieron un estado de muerte;
    // si alguno está bloqueado o agotó el tiempo, no se puede afirmar.
    const statuses = attemptsFor.map(attempt => attempt.status);
    if (!attemptsFor.length) return { ok: null, reason: 'sin intentos' };
    if (attemptsFor.every(attempt => DEAD_STATUSES.includes(attempt.status))) return { ok: false, reason: 'caído' };
    if (statuses.some(status => BLOCKED_STATUSES.includes(status))) return { ok: true, reason: 'bloqueado', blocked: true };
    return { ok: true, reason: 'sin confirmar', unconfirmed: true };
  };

  for (const stream of direct) {
    const result = await probe(stream.url, { get, referer: stream.referer, timeoutMs, maxBytes });
    attempts.push({ kind: 'direct', source: stream.source || null, ...result });
    if (result.ok) return { ok: true, via: 'direct', attempts };
  }

  if (!direct.length && pages.length) {
    if (!resolvePage) {
      return { ok: null, via: 'page', attempts, error: 'sin resolutor de página' };
    }
    for (const stream of pages) {
      try {
        const resolved = await resolvePage(stream);
        if (!resolved || !resolved.url) {
          attempts.push({ kind: 'page', source: stream.source || null, ok: false, status: null, error: 'no resuelto' });
          continue;
        }
        const result = await probe(resolved.url, { get, referer: resolved.referer, timeoutMs, maxBytes });
        attempts.push({ kind: 'page', source: stream.source || null, ...result });
        if (result.ok) return { ok: true, via: 'page', attempts };
      } catch (error) {
        attempts.push({ kind: 'page', source: stream.source || null, ok: false, status: statusOf(error), error: error.message });
      }
    }
  }

  // Ningún intento trajo firma: decidir si es caída real o solo un bloqueo.
  return { ...verdict(attempts), via: direct.length ? 'direct' : 'page', attempts };
}

/** Aplica un informe a los canales: `dead`, `unverified` y `health` por canal. */
function applyReport(channels, report) {
  const results = (report && report.results) || {};
  return (channels || []).map(channel => {
    const result = results[channel.id];
    if (!result) return channel;
    const error = firstAttemptWith(result, 'error').error || null;
    return {
      ...channel,
      dead: result.dead === true,
      // Motivo legible para `/health/dead.json` y la portada.
      deadReason: result.dead === true
        ? (error || (firstAttemptWith(result, 'status').status != null ? `HTTP ${firstAttemptWith(result, 'status').status}` : 'sin confirmar'))
        : null,
      unverified: result.ok === null,
      health: {
        checkedAt: report.checkedAt,
        ok: result.ok,
        via: result.via || null,
        attempts: (result.attempts || []).length,
        status: firstAttemptWith(result, 'status').status ?? null,
        error: firstAttemptWith(result, 'error').error || null
      }
    };
  });
}

function firstAttemptWith(result, key) {
  return (result.attempts || []).find(attempt => attempt[key] != null) || {};
}

function summarize(channels, report) {
  const list = channels || [];
  const hasResult = channel => Boolean(report && report.results && report.results[channel.id]);
  const checked = list.filter(hasResult);
  const dead = checked.filter(channel => report.results[channel.id].dead);
  const unknown = checked.filter(channel => report.results[channel.id].ok === null);
  const blocked = checked.filter(channel => report.results[channel.id].blocked);
  const unconfirmed = checked.filter(channel => report.results[channel.id].unconfirmed);
  const alive = checked.length - dead.length - unknown.length - blocked.length - unconfirmed.length;
  return {
    checkedAt: (report && report.checkedAt) || null,
    durationMs: (report && report.durationMs) || null,
    inconclusive: Boolean(report && report.selfCheck && report.selfCheck.inconclusive),
    channels: list.length,
    checkable: checkable(list).length,
    checked: checked.length,
    alive,
    dead: dead.length,
    blocked: blocked.length,
    unconfirmed: unconfirmed.length,
    unknown: unknown.length,
    unchecked: list.length - checked.length,
    ratio: checked.length ? Number((alive / checked.length).toFixed(3)) : null,
    deadChannels: dead.slice(0, 500).map(channel => ({
      id: channel.id,
      name: channel.name,
      country: channel.country,
      category: channel.category,
      sources: channel.sources,
      reason: report.results[channel.id].reason || null,
      status: firstAttemptWith(report.results[channel.id], 'status').status ?? null,
      error: firstAttemptWith(report.results[channel.id], 'error').error || null
    }))
  };
}

/**
 * Crea el verificador. Guarda el último informe en memoria; la persistencia en
 * disco la hace el llamador (`storage`) para no atar el motor al sistema de
 * archivos.
 */
function createChecker({
  get,
  resolvePage = null,
  channels,
  concurrency = DEFAULTS.concurrency,
  timeoutMs = DEFAULTS.timeoutMs,
  retries = DEFAULTS.retries,
  maxBytes = DEFAULTS.maxBytes,
  budgetMs = DEFAULTS.budgetMs,
  maxAttemptsPerChannel = DEFAULTS.maxAttemptsPerChannel,
  resultTtlMs = DEFAULTS.resultTtlMs,
  minSuccessRatio = DEFAULTS.minSuccessRatio,
  minSamples = DEFAULTS.minSamples,
  probe = probeMedia,
  // Se ignoran 429/403 al calcular la salud global: son límites del servidor, no
  // señales muertas.
  throttleStatuses = DEFAULTS.throttleStatuses,
  now = Date.now,
  logger = console
} = {}) {
  let report = null;
  let pending = null;

  function fresh() {
    return Boolean(report && now() - report.finishedAt < resultTtlMs);
  }

  async function run({ force = false, list, limit } = {}) {
    if (!force && report && fresh()) return { ...report, cached: true };
    if (pending) return pending;
    const startedAt = now();
    let source = list;
    if (!source) source = typeof channels === 'function' ? await channels() : channels;
    const targets = checkable(source).slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);
    const results = {};
    const skipped = [];
    const probed = new Map();
    let failures = 0;

    // El mismo medio puede repetirse en varios canales: se sondea una sola vez.
    const cachedProbe = async (url, options) => {
      if (!probed.has(url)) probed.set(url, probe(url, options));
      return probed.get(url);
    };

    pending = mapLimit(targets, concurrency, async channel => {
      if (now() - startedAt > budgetMs) {
        skipped.push(channel.id);
        return;
      }
      let result;
      try {
        result = await checkChannel(channel, {
          get, resolvePage, probe: cachedProbe, timeoutMs, maxBytes, maxAttempts: maxAttemptsPerChannel
        });
      } catch (error) {
        // Un fallo del propio verificador no marca el canal como caído.
        result = { ok: null, via: null, attempts: [], error: error.message };
        failures++;
      }
      const definitive = result.ok === false;
      results[channel.id] = {
        ok: result.ok === true ? true : definitive ? false : null,
        dead: definitive,
        blocked: Boolean(result.blocked),
        unconfirmed: Boolean(result.unconfirmed),
        reason: result.reason || null,
        via: result.via || null,
        attempts: result.attempts || [],
        error: result.error || null
      };
    }).then(() => {
      const values = Object.values(results);
      const definitive = values.filter(result => result.ok !== null);
      const alive = definitive.filter(result => result.ok).length;
      // 429 y 403 no dicen nada sobre la salud global: son límites del servidor.
      const informative = definitive.filter(result => {
        const status = firstAttemptWith(result, 'status').status;
        return !throttleStatuses.includes(status);
      });
      const informativeAlive = informative.filter(result => result.ok).length;
      const ratio = informative.length ? informativeAlive / informative.length : 1;
      const selfCheck = {
        // Si el propio entorno no tiene salida a internet, la ratio se desploma:
        // el informe se marca "no concluyente" y NO se usa para filtrar.
        // Solo se evalúa con muestra suficiente; un catálogo real puede tener
        // la mayoría de señales muertas sin que la red esté mal.
        inconclusive: informative.length >= minSamples && ratio < minSuccessRatio,
        ratio: Number(ratio.toFixed(3)),
        informative: informative.length,
        throttled: definitive.length - informative.length,
        definitive: definitive.length,
        failures
      };
      if (selfCheck.inconclusive) {
        logger.warn(`[checker] ${Math.round(ratio * 100)}% de señales responden: red del entorno sospechosa, informe no concluyente`);
      }
      const finishedAt = now();
      return {
        checkedAt: new Date(startedAt).toISOString(),
        finishedAt,
        durationMs: finishedAt - startedAt,
        total: values.length,
        alive,
        dead: definitive.length - alive,
        unknown: values.filter(result => result.ok === null).length,
        skipped: skipped.length,
        selfCheck,
        results
      };
    }).finally(() => { pending = null; });

    report = await pending;
    return report;
  }

  return {
    run,
    peek: () => report,
    fresh,
    /** Restaura un informe leído de disco (solo si sigue vigente). */
    restore: candidate => {
      if (candidate && Number.isFinite(candidate.finishedAt) && now() - candidate.finishedAt < resultTtlMs) {
        report = candidate;
        return true;
      }
      return false;
    },
    apply: list => applyReport(list, report),
    status: list => summarize(list, report),
    reset: () => { report = null; }
  };
}

module.exports = {
  createChecker,
  checkChannel,
  probeMedia,
  looksPlayable,
  applyReport,
  summarize,
  checkable,
  statusOf,
  isDirect,
  DEFAULTS,
  MEDIA_SIGNATURES,
  DEAD_STATUSES,
  BLOCKED_STATUSES
};
