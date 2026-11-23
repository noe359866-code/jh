// Listas M3U adicionales configuradas por el usuario (IPTV/Xtream privados).
//
// Las URLs de estas listas NO viven en el repositorio: suelen llevar usuario y
// contraseña del proveedor, y publicarlas en GitHub dejaría la cuenta expuesta.
// Se leen de dos sitios, en este orden:
//
//   1. `config/extra-playlists.json` (ignorado por git).
//   2. La variable de entorno `EXTRA_PLAYLISTS` con URLs separadas por comas
//      (`https://host/lista.m3u8` o `Nombre=https://host/get.php?…`).
//
// Cada lista se convierte en una fuente más del catálogo, con el mismo parser y
// el mismo verificador que las demás; si una lista no responde, el catálogo
// sigue funcionando con el resto.
//
// Los enlaces de Xtream (`type=m3u_plus&output=mpegts`) no acaban en `.m3u8`:
// sus medios son `/live/usuario/clave/1234` o `/usuario/clave/1234.ts`. Como la
// lista los declara como medios, `assumeHls` evita clasificarlos como páginas a
// resolver (se publicarían como enlaces sin reproductor y se perderían).
const fs = require('node:fs');
const path = require('node:path');
const { createPlaylistSource } = require('./playlist');
const { slug } = require('../text');

// Ruta por defecto del archivo de configuración. `EXTRA_PLAYLISTS_FILE` permite
// montar otro (Docker) sin tocar la imagen.
const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'config', 'extra-playlists.json');

// Un catálogo con veinte proveedores privados multiplicaría la recolección sin
// aportar nada: se aceptan unos pocos.
const MAX_LISTS = 12;

// Parámetros de URL que no deben aparecer en los informes (`/config`, logs).
const SECRET_PARAMS = /^(username|user|password|pass|token|auth|apikey|api_key|key)$/i;

/**
 * Versión publicable de una URL: misma forma, credenciales sustituidas. Se usa
 * como etiqueta de la fuente en `/config` y en los mensajes de error.
 */
function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.test(key)) url.searchParams.set(key, '***');
    }
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.href;
  } catch {
    return String(value).replace(/\/\/[^/@]*@/, '//***@');
  }
}

/** Etiqueta corta y sin credenciales para una lista: `nexon.flixip.vip`. */
function labelFor(value) {
  try {
    return new URL(value).hostname || redactUrl(value);
  } catch {
    return redactUrl(value);
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeDefinition(raw, index, { requireUrl = true } = {}) {
  const value = typeof raw === 'string' ? { url: raw } : raw;
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  if (requireUrl && !isHttpUrl(url)) return null;
  const name = String(value.name || value.label || '').trim() || labelFor(url);
  const id = slug(String(value.id || name || `extra-${index + 1}`), `extra-${index + 1}`);
  return {
    id: id.startsWith('extra-') ? id : `extra-${id}`,
    name,
    url,
    // Etiqueta que aparece en `/config`; nunca la URL con contraseña.
    label: String(value.label || '').trim() || labelFor(url),
    // País por defecto de la lista (`"MX"`), como en las listas públicas.
    country: value.country ? String(value.country).trim().toUpperCase() : null,
    // Filtro estricto de español, por si la lista es mundial.
    spanishOnly: Boolean(value.spanishOnly),
    // Xtream y compañía sirven medios sin extensión: se publican como directos.
    assumeHls: value.assumeHls === undefined ? true : Boolean(value.assumeHls),
    // Un Xtream completo trae decenas de miles de entradas; el límite evita que
    // una lista privada ahogue al resto del catálogo.
    maxEntries: Number(value.maxEntries) > 0 ? Math.min(Number(value.maxEntries), 20000) : 8000
  };
}

/**
 * Definiciones a partir del contenido de `config/extra-playlists.json`.
 * Acepta un array de URLs o de objetos `{ id, name, url, country }`.
 */
function parseExtraConfig(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data && data.playlists) ? data.playlists : []);
  const out = [];
  const seen = new Set();
  for (const [index, raw] of list.entries()) {
    const definition = normalizeDefinition(raw, index);
    if (!definition || seen.has(definition.url)) continue;
    seen.add(definition.url);
    out.push(definition);
    if (out.length >= MAX_LISTS) break;
  }
  return out;
}

/**
 * Definiciones a partir de `EXTRA_PLAYLISTS`. Admite `url` o `Nombre=url`
 * separados por comas o saltos de línea.
 */
function parseExtraEnv(value) {
  const out = [];
  const seen = new Set();
  for (const part of String(value || '').split(/[,\n]/)) {
    const entry = part.trim();
    if (!entry) continue;
    // Un `=` dentro de la propia URL (query string) no separa la etiqueta.
    const raw = /^https?:\/\//i.test(entry)
      ? { url: entry }
      : (() => {
        const index = entry.indexOf('=');
        return index > 0 ? { name: entry.slice(0, index).trim(), url: entry.slice(index + 1).trim() } : { url: entry };
      })();
    const definition = normalizeDefinition(raw, out.length);
    if (!definition || seen.has(definition.url)) continue;
    seen.add(definition.url);
    out.push(definition);
    if (out.length >= MAX_LISTS) break;
  }
  return out;
}

/**
 * Lee las definiciones del archivo y del entorno. No lanza nunca: una configuración
 * rota solo deja el catálogo público, que es lo que había antes de existir esto.
 * Devuelve `{ definitions, file, error }`.
 */
function loadDefinitions({ env = process.env, readFile = null, file = null } = {}) {
  const target = file || env.EXTRA_PLAYLISTS_FILE || DEFAULT_FILE;
  const definitions = [];
  const seen = new Set();
  let error = null;

  const add = list => {
    for (const definition of list) {
      if (seen.has(definition.url)) continue;
      seen.add(definition.url);
      definitions.push(definition);
    }
  };

  const reader = readFile || (target => {
    if (!fs.existsSync(target)) return null;
    return fs.readFileSync(target, 'utf8');
  });
  try {
    const text = reader(target);
    if (text) add(parseExtraConfig(text));
  } catch (cause) {
    error = `No se pudo leer ${path.basename(String(target))}: ${cause.message}`;
  }

  if (env.EXTRA_PLAYLISTS) add(parseExtraEnv(env.EXTRA_PLAYLISTS));

  return { definitions: definitions.slice(0, MAX_LISTS), file: target, error };
}

/** Convierte una definición en una fuente del catálogo. */
function createSource(definition) {
  return createPlaylistSource({
    id: definition.id,
    name: definition.name,
    urls: [definition.url],
    defaultCountry: definition.country,
    spanishOnly: definition.spanishOnly,
    assumeHls: definition.assumeHls,
    maxEntries: definition.maxEntries,
    // El informe de `/config` se etiqueta con el host, nunca con las credenciales.
    labels: { [definition.url]: definition.label }
  });
}

const loaded = loadDefinitions();

module.exports = {
  sources: loaded.definitions.map(createSource),
  definitions: loaded.definitions.map(({ url, ...rest }) => rest),
  configFile: loaded.file,
  configError: loaded.error,
  parseExtraConfig,
  parseExtraEnv,
  loadDefinitions,
  redactUrl,
  labelFor,
  MAX_LISTS,
  createSource
};
