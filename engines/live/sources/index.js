// Registro de fuentes del agregador.
//
// Este proyecto ya **no** recorre webs de terceros ni resuelve embeds: agrega
// listas M3U. Por defecto solo las privadas del usuario (ver `extra.js`); el
// catálogo público de listas abiertas solo se recolecta si se pide
// (`PUBLIC_LISTS=1` o `?publico=1`), y en ese caso se puede limitar con
// `PUBLIC_SOURCES=cinecity,pluto,…`.
//
// `direct`  : la lista trae la URL del medio (HLS/MPEG-TS) tal cual.
// `catalog` : la lista no da un medio reproducible directo (no se usa hoy).
const extra = require('./extra');

// Listas públicas conocidas, con id, módulo y etiqueta para `/config`.
const PUBLIC = [
  { id: 'cinecity', module: './cinecity' },
  { id: 'telechancho', module: './telechancho' },
  { id: 'iptvchile', module: './iptvchile' },
  { id: 'samsungtvplus', module: './samsungtvplus' },
  { id: 'pluto', module: './pluto' },
  { id: 'd9kod', module: './d9kod' },
  { id: 'usa', module: './usa' },
  { id: 'iptvorg', module: './iptvorg' },
  { id: 'tdtchannels', module: './tdtchannels' },
  { id: 'freetv', module: './freetv' }
];

const PUBLIC_IDS = PUBLIC.map(entry => entry.id);

/** ¿Se recolecta el catálogo público? `PUBLIC_LISTS=1` o `PUBLIC_LISTS=0`. */
function publicEnabled(env = process.env) {
  const value = String(env.PUBLIC_LISTS ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'si' || value === 'sí';
}

/** Ids públicos permitidos (`PUBLIC_SOURCES=a,b`); vacío = todas. */
function publicFilter(env = process.env) {
  const list = String(env.PUBLIC_SOURCES || '').split(',').map(value => value.trim()).filter(Boolean);
  return list.length ? list : PUBLIC_IDS;
}

/**
 * Fuentes activas. Las privadas van primero: si el usuario pide una lista
 * combinada, lo que más importa es que sus canales estén en el catálogo.
 */
function buildSources({ env = process.env, extraConfig = extra } = {}) {
  const sources = [...extraConfig.sources];
  if (!publicEnabled(env)) return sources;
  const allowed = new Set(publicFilter(env));
  for (const entry of PUBLIC) {
    if (!allowed.has(entry.id)) continue;
    sources.push(require(entry.module));
  }
  return sources;
}

const sources = buildSources();

const MODE = {
  // Las listas (públicas y privadas) publican medios directos.
  ...Object.fromEntries(PUBLIC_IDS.map(id => [id, 'direct'])),
  ...Object.fromEntries(extra.sources.map(source => [source.id, 'direct']))
};

function byId(id) {
  return sources.find(source => source.id === id) || null;
}

module.exports = {
  sources,
  byId,
  MODE,
  extra,
  PUBLIC,
  PUBLIC_IDS,
  buildSources,
  publicEnabled,
  publicFilter,
  // Compatibilidad con scripts/tests antiguos.
  allSources: () => buildSources({ env: { PUBLIC_LISTS: '1' } })
};
