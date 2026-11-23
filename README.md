# Agregador de listas M3U privadas (IPTV/Xtream)

Junta **varias listas M3U privadas** (proveedores IPTV, Xtream Codes) en **una sola
lista** lista para VLC, Kodi, TiviMate, IPTVnator o cualquier reproductor, con
**verificador de señales** que excluye los canales caídos.

- **Privadas por defecto.** El catálogo son *tus* listas y nada más. Las listas
  abiertas de internet solo entran si lo pides (`PUBLIC_LISTS=1` o
  `?publico=1`), y no se recolectan si no las usas.
- **Una lista combinada.** `/playlist/<nombre>.m3u` reúne todas tus listas en un
  único archivo, sin duplicados, más una lista por cada lista configurada y otra
  por país (`es`, `mx`, `ar`…).
- **Sin credenciales en el repositorio.** Tu configuración vive en
  `config/extra-playlists.json`, que está ignorado por git; los informes solo
  muestran el host de cada lista.
- **Verificador.** Los canales caídos (404/410/DNS) se excluyen de las listas;
  un 403/429/timeout **no** se marca caído (puede ser la red o el momento).

> Este proyecto ya **no** es un addon de Stremio ni recorre webs de terceros:
> esos scrapers y el resolutor de embeds se retiraron. El motor está pensado para
> agregar listas M3U.

## Arranque

```bash
npm ci
cp config/extra-playlists.example.json config/extra-playlists.json
# edita el archivo con tus listas
npm start                 # http://localhost:8080
PORT=3000 npm start
```

Con Docker (las credenciales se montan, no se hornean):

```bash
docker build -t agregador-iptv .
docker run --rm -p 8080:8080 \
  -v "$PWD/config/extra-playlists.json:/app/config/extra-playlists.json:ro" \
  -v "$PWD/reports:/app/reports" \
  agregador-iptv
```

## Configuración

### Listas privadas

Dos formas, y se pueden combinar:

```bash
# 1) archivo (ignorado por git)
cp config/extra-playlists.example.json config/extra-playlists.json

# 2) variable de entorno (útil en Docker/CI)
EXTRA_PLAYLISTS="Nexon=http://host/get.php?username=USUARIO&password=CLAVE&type=m3u_plus&output=mpegts" npm start
```

```json
{
  "id": "nexon",
  "name": "Nexon",
  "playlists": [
    { "id": "nexon", "name": "Nexon IPTV", "url": "http://nexon…/get.php?username=…&password=…&type=m3u_plus&output=mpegts" },
    { "id": "otra",  "name": "Otra lista",  "url": "https://ejemplo.example/lista.m3u8", "country": "MX" }
  ]
}
```

`id`/`name` de nivel superior nombran la **lista combinada**. Cada elemento de
`playlists` acepta:

| Campo | Por defecto | Para qué |
|---|---|---|
| `url` | — | URL de la lista (`get.php…`, `.m3u`, `.m3u8`) |
| `name` | host de la URL | nombre de la fuente en `/config` y en la lista combinada |
| `id` | `extra-<slug>` | id de la fuente (también da nombre a su lista suelta) |
| `country` | ninguno | país por defecto si la lista no lo dice (`"MX"`) |
| `spanishOnly` | `false` | filtro estricto de español, para listas mundiales |
| `assumeHls` | `true` | Xtream sirve medios sin extensión (`/live/usuario/clave/1234`): se publican como directos en vez de ignorarse |
| `maxEntries` | `8000` | tope de canales de esa lista (máximo 20000) |

Máximo **12 listas**. Una lista que no responde no tumba el catálogo: queda con
`ok: false` en `/config` y el resto se publica igual.

### Listas abiertas (opcional)

```bash
PUBLIC_LISTS=1 npm start                       # todas las listas públicas soportadas
PUBLIC_LISTS=1 PUBLIC_SOURCES=pluto,freetv npm start   # solo esas
```

Las listas públicas son las que ya conocía el proyecto: CineCity, Telechancho,
iptv-chile, Samsung TV Plus ES, Pluto TV, D9Kod, iptv-org (`usa`, y una por país),
TDTChannels y Free-TV. Sin `PUBLIC_LISTS` **no se descargan**.

### Otras variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `8080` | puerto HTTP |
| `CACHE_TTL` | `1800000` (30 min) | TTL del catálogo en ms (mínimo 60 s) |
| `EPG_URL` | TDTChannels | `x-tvg-url` de las listas; `EPG_URL=` lo desactiva |
| `SITE_NAME` | `Agregador IPTV` | nombre en `/` y `/config` |
| `EXTRA_PLAYLISTS_FILE` | `config/extra-playlists.json` | otra ruta de configuración |
| `CHECK_BUDGET_MS` | `25000` | tope para `?check=1` antes de responder con el informe anterior |
| `LIMIT`, `CONCURRENCY`, `FAIL_ON_DEAD` | — | `npm run verify` |

## Rutas HTTP

| Ruta | Descripción |
|---|---|
| `GET /playlist/:id.m3u` | lista combinada, una por lista configurada, región (`all`, `es`, `latam`, `deportes`) y país (`mx`, `ar`…) |
| `GET /playlist.m3u` | atajo: redirige a la lista combinada (`all` si no hay listas privadas) |
| `GET /playlists.json` | índice con recuentos y marca `private` |
| `GET /health.json` | informe del verificador (vivos, caídos, sin verificar) |
| `GET /health/dead.json` | canales caídos con su motivo y sus URLs |
| `GET /config` | estado y tiempos de cada fuente, listas configuradas (solo host) |
| `GET /` | portada con los enlaces |

Parámetros de las listas:

- `?dead=1` — incluye los canales caídos (para depurar).
- `?check=1` — verifica antes de responder (con presupuesto; si tarda, responde
  con el informe anterior y sigue en segundo plano).
- `?publico=1` — añade las listas abiertas **a esa respuesta**, sin tocar el
  catálogo cacheado.

Todas las respuestas llevan CORS abierto. Si la recolección falla por completo se
devuelve `503` con `Retry-After`; un catálogo vacío nunca sustituye a la última
copia buena (`/config` la marca con `stale: true`).

## Verificador de señales

Un canal está **caído** solo si todas sus URLs dan un estado de muerte (404/410/451,
dominio que no resuelve). Un 403/429 es **bloqueado** y un timeout **sin
confirmar**: en ambos casos se conserva, porque puede depender de la red o del
momento. Nunca se marca caído un canal que no se pudo comprobar.

- Se ejecuta al arrancar (en segundo plano) y bajo demanda; el informe se guarda
  en `reports/health.json` para no volver a sondear todo tras un reinicio.
- Límites: concurrencia, tiempo por canal y presupuesto total. Los canales que no
  caben quedan «sin verificar» y se reintentan en la siguiente pasada.
- `npm run verify` hace la pasada completa contra la red real y deja
  `reports/health.json`, `reports/dead.txt`, `reports/countries.json` y una copia
  de cada lista en `reports/playlist-*.m3u` **sin** los caídos.

```bash
LIMIT=40 npm run verify          # muestra rápida
CONCURRENCY=32 npm run verify    # más paralelismo
FAIL_ON_DEAD=1 npm run verify    # sale con 1 si hay caídos (CI estricta)
```

## Detalles de la normalización

- **País.** Se deduce del nombre (bandera, sufijo `[CL]`/`(ES)`), de `tvg-country`,
  de `group-title` (incluye los formatos Xtream `ESPAÑA | GENERALISTAS`,
  `Mexico - Deportes`, `ES - La 1`) y, si no hay nada, del `country` configurado
  para esa lista. Sin país identificable el canal queda como internacional, no se
  descarta.
- **Categoría.** `group-title` se traduce a Generalista, Deportes, Noticias,
  Infantil, Música, Cine y series o Documentales; si el grupo es un país
  (`Italy`), no se usa como categoría.
- **Idioma.** Se descarta la entrada que declare `tvg-language` no español
  (`por`, `pt`, `eng`, `fra`, `deu`, `ita`…). Con `spanishOnly` (listas
  mundiales) solo entra lo que demuestra ser español.
- **Duplicados.** Dos entradas con la misma URL de medio cuentan una vez; el mismo
  canal en dos listas se agrupa y conserva todas sus señales.
- **M3U de salida.** `#EXTINF` con `tvg-id` (el de la EPG de origen si lo trae),
  `tvg-logo`, `tvg-country` real, `group-title` «País · Categoría», `#EXTGRP` y
  `#EXTVLCOPT` con `User-Agent` (y `Referer` cuando la lista lo declara). Las
  comas del nombre se sustituyen: rompen la entrada en la mayoría de reproductores.

## Estructura

```
index.js                    servidor HTTP y listas publicadas
engines/live/
  catalog.js                agrega fuentes, deduplica y cachea
  checker.js                verificador de señales
  http.js                   descargas con validación de destino
  m3u.js                    escritura y lectura de M3U
  countries.js, text.js     países, nombres, categorías
  limit.js                  concurrencia limitada
  sources/
    index.js                registro (privadas + públicas opcionales)
    extra.js                listas privadas: configuración y credenciales
    playlist.js             parser común y normalización
    cinecity.js … freetv.js listas públicas conocidas
scripts/verify.js           pasada de verificación completa
test/                       pruebas sin red (`npm test`)
```

## Limitaciones honestas

- **No resuelve embeds ni ejecuta JavaScript.** Los canales cuyo medio solo se
  monta en un navegador (Xtream con reproductor web, blogspots) no se pueden
  agregar; las listas M3U de proveedor sí, porque traen la URL del medio.
- **`mpegts`** se publica como URL directa: funciona en VLC/Kodi/TiviMate, pero
  algunos reproductores prefieren HLS. Muchos proveedores sirven las dos cosas:
  si tu listado admite `output=hls`, esa variante es más compatible.
- **La verificación depende de tu red.** Desde una IP residencial el resultado es
  mucho más fiable que desde un servidor; los 403/429 nunca se dan por caídos.
- **Las cifras cambian a diario**: los proveedores publican y retiran señales sin
  aviso. `/config` muestra el estado en la última recolección.

## Aviso legal

La herramienta solo descarga y organiza listas M3U que tú aportas. No incluye ni
distribuye contenido: la legalidad de cada lista y de su emisión es
responsabilidad de quien la usa.
