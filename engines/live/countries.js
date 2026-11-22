// Países de habla hispana y sus nombres para mostrar.
//
// El catálogo guarda dos cosas por canal:
//   - `country`  : región de navegación (`ES`, `US` o `LATAM`).
//   - `origin`   : país real del canal (`MX`, `AR`, `US`…), que es lo que permite
//                  tener una categoría por país.
//
// Los países hispanos se listan aquí para no repetir la tabla en cuatro sitios y
// para que las categorías de Stremio, las listas M3U y los filtros usen el mismo
// orden.

// Orden de presentación: España y Estados Unidos primero, después Latinoamérica
// por tamaño de catálogo esperado y alfabético dentro de cada bloque.
const COUNTRIES = [
  { code: 'ES', name: 'España' },
  { code: 'US', name: 'Estados Unidos' },
  { code: 'MX', name: 'México' },
  { code: 'AR', name: 'Argentina' },
  { code: 'CO', name: 'Colombia' },
  { code: 'CL', name: 'Chile' },
  { code: 'PE', name: 'Perú' },
  { code: 'VE', name: 'Venezuela' },
  { code: 'EC', name: 'Ecuador' },
  { code: 'GT', name: 'Guatemala' },
  { code: 'HN', name: 'Honduras' },
  { code: 'SV', name: 'El Salvador' },
  { code: 'NI', name: 'Nicaragua' },
  { code: 'CR', name: 'Costa Rica' },
  { code: 'PA', name: 'Panamá' },
  { code: 'CU', name: 'Cuba' },
  { code: 'DO', name: 'República Dominicana' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'UY', name: 'Uruguay' },
  { code: 'PY', name: 'Paraguay' },
  { code: 'BO', name: 'Bolivia' }
];

const BY_CODE = new Map(COUNTRIES.map(country => [country.code, country]));

// Códigos que el catálogo usa como país pero que en realidad son regiones o
// agrupaciones de las fuentes de origen. Nunca generan categoría propia.
const REGIONS = new Set(['LATAM', 'INT', 'Internacional']);

/** Región de navegación (`ES` / `US` / `LATAM`) a partir del país real. */
function regionOf(code) {
  if (code === 'ES') return 'ES';
  if (code === 'US') return 'US';
  return 'LATAM';
}

/**
 * Deduce el país real de un canal a partir de lo que dan las fuentes. Acepta un
 * código ISO (`MX`), un nombre (`Mexico`, `España`) o una etiqueta regional
 * (`LATAM`) y devuelve el código de dos letras o `null` si no se puede saber.
 */
function countryOf(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (BY_CODE.has(upper)) return upper;
  const plain = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const country of COUNTRIES) {
    const name = country.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (plain === name) return country.code;
  }
  return null;
}

/** Nombre para mostrar de un país; `null` si el código es una región. */
function countryName(code) {
  const country = BY_CODE.get(String(code || '').toUpperCase());
  return country ? country.name : null;
}

/** ¿Es un país con categoría propia? */
function isCountry(code) {
  return BY_CODE.has(String(code || '').toUpperCase());
}

module.exports = { COUNTRIES, REGIONS, regionOf, countryOf, countryName, isCountry, BY_CODE };
