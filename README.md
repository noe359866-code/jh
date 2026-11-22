# TV en Español · Addon de Stremio y listas M3U

Canales de **televisión en directo en español** (España y Latinoamérica), recopilados
en vivo desde siete webs públicas. El proyecto expone un **addon de Stremio** y
**listas M3U** listas para VLC, Kodi, TiviMate, IPTVnator o cualquier reproductor
compatible.

> Sustituye por completo al antiguo addon de películas y series: ahora el catálogo
> es solo TV en directo, y solo canales en español.

## Estado real (última verificación en vivo)

Medido el **22/11/2026** ejecutando `npm run test:live` contra las siete fuentes:

| Fuente | Modo | Canales | Reproducibles | Notas |
|---|---|---:|---:|---|
| iptvcat.net | directo | 1.170 | 1.170 | mini‑M3U firmadas por tarjeta (`data-clipboard-text`) |
| tvgarden.world | directo | 1.211 | 1.186 | API JSON por país (`/api/tv/countries/<cc>.json`) |
| eja.tv | directo | 699 | 699 | paginación `?offset=` de 6 en 6, filtro `language=spa` |
| globalfreetv.com | directo | 243 | 243 | HTML SSR; 45 canales/país por límite de peticiones |
| tvenvivo.org | página | 70 | 25 | requiere resolver `core.php?canal=` |
| thedaddy.li | página | 29 | 0 | el CDN solo emite token a navegador real → mejor esfuerzo |
| livelive24.com | catálogo | 29 | 0 | solo publica la página del canal (`externalUrl`) |

**Total: 1.870 canales · 1.845 con medio reproducible · 336 de España · 1.534 de Latinoamérica.**
`playlistEntries` = 2.830 entradas M3U (un canal puede aportar varias señales).

Estas cifras cambian a diario: las fuentes son webs de terceros y publican y retiran
señales sin aviso. El endpoint `/config` devuelve el estado de cada fuente en el
momento de la última recolección.

## Arranque

```bash
npm ci
npm start                 # http://localhost:8080
PORT=3000 npm start       # otro puerto
CACHE_TTL=600000 npm start  # TTL del catálogo en ms (por defecto 30 min)
```

Con Docker:

```bash
docker build -t tv-espanol .
docker run --rm -p 8080:8080 tv-espanol
```

## Stremio

Instala el addon con la URL del manifiesto:

```
https://TU-DOMINIO/manifest.json
```

En Stremio: **Addons → Instalar desde URL → pega la URL**. El addon declara tipo
`tv` con cuatro catálogos:

| Catálogo | ID | Filtros |
|---|---|---|
| TV en español · Todos | `todos` | `genre` (país y categoría), `skip` |
| TV · España | `espana` | `skip` |
| TV · Latinoamérica | `latinoamerica` | `skip` |
| TV · Deportes | `deportes` | `skip` |

Cada canal es un `meta` con póster (si la fuente lo trae), país, categoría y las
fuentes que lo aportan. Las señales se entregan como HLS directo; cuando el origen
exige `Referer` o `User-Agent`, se envían como `proxyHeaders` para que el
reproductor de Stremio los use.

## Listas M3U

| Lista | Ruta | Contenido |
|---|---|---|
| Todo | `/playlist/all.m3u` (alias `/playlist.m3u`) | todos los canales |
| España | `/playlist/es.m3u` | solo España |
| Latinoamérica | `/playlist/latam.m3u` | solo Latinoamérica |
| Deportes | `/playlist/deportes.m3u` | solo deportes |

Ejemplo:

```
https://TU-DOMINIO/playlist/all.m3u
https://TU-DOMINIO/playlist/es.m3u?pages=1
```

- `?pages=1` resuelve además las **fuentes de página** (TVEnVivo y DaddyLive) antes de
  escribir la lista. Sin el parámetro solo se publican medios directos, que es lo más
  rápido y estable.
- La respuesta lleva `X-Channel-Count` y se cachea 5 minutos.
- Cada entrada incluye `tvg-id`, `tvg-logo`, `group-title` (`España · Deportes`,
  `Latinoamérica · Noticias`…), y `#EXTVLCOPT` con `Referer`/`User-Agent` cuando la
  fuente los exige.
- `/playlists.json` da recuentos por lista y `/config` el estado de cada fuente.

## Rutas HTTP

| Ruta | Descripción |
|---|---|
| `GET /manifest.json` | manifiesto del addon (`org.tvespanol.live`) |
| `GET /catalog/tv/:id.json` | catálogo paginado (`skip`, `genre`) |
| `GET /meta/tv/:id.json` | metadatos de un canal |
| `GET /stream/tv/:id.json` | señales reproducibles de un canal |
| `GET /playlist/:variant.m3u` | listas M3U (`all`, `es`, `latam`, `deportes`) |
| `GET /playlists.json` | índice de listas con recuentos |
| `GET /config` | estado y tiempos de cada fuente |
| `GET /stream/page?url=` | resuelve una página de origen (solo `tvenvivo.org` y `thedaddy.li`) |
| `GET /` | portada con enlaces |

Todas las respuestas llevan CORS abierto. Si el catálogo aún no está listo se
devuelve `503` con `Retry-After`.

## Fuentes y modos

| Fuente | Modo | Cómo se extrae |
|---|---|---|
| eja.tv | directo | listado `/?country=<cc>&offset=N`, 6 tarjetas por página, `<source src>` m3u8 |
| iptvcat.net | directo | listado por país (`spain__9`, `mexico__6`…), 100 filas, mini‑M3U en `data-clipboard-text` |
| tvgarden.world | directo | API JSON por país con `stream_urls[]` |
| globalfreetv.com | directo | HTML SSR: `channel:$R[n]={…}` + `streams:$R[m]=[…]` con `url` y `http_referrer` |
| tvenvivo.org | página | `core.php?canal=<slug>` → iframe → `var src = "…m3u8"` |
| thedaddy.li | página | `watch.php?id=N` → `stream-N.php` → embed → `const SRC` |
| livelive24.com | catálogo | `tv.json`, solo enlaces a la página del canal |

**Modos:** `directo` = el canal ya trae una URL de medio; `página` = hay que resolver
una cadena de iframes al reproducir; `catálogo` = la fuente solo aporta el nombre y el
enlace a su página, así que el canal se publica como enlace externo.

Solo se incluyen **países de habla hispana**: España (ES) y Latinoamérica (MX, AR, CO,
CL, PE, VE, EC, GT, HN, SV, NI, CR, PA, CU, DO, PR, UY, PY, BO) más las señales en
español de EE. UU. Todos los canales se etiquetan con su país de origen.

## Verificación

```bash
npm test        # 18 pruebas unitarias (parser + addon + rutas HTTP), sin red
npm run check   # node --check sobre todo el motor
npm run test:live   # comprobación real contra las 7 fuentes (necesita red)
SOURCE=eja,tvgarden npm run test:live   # solo algunas fuentes
```

`test:live` escribe `reports/live-check.json` (sin URLs ni tokens), imprime un resumen
por fuente y sale con código 1 si no hay ningún canal reproducible.

También hay dos workflows: `test.yml` (Node 22/24 + build de Docker) y
`live-check.yml` (recolección diaria a las 04:17 UTC, con artefacto del informe).

## Limitaciones conocidas (honestas)

- **DaddyLive (thedaddy.li)** y **Live24** son **mejor esfuerzo**. El CDN de DaddyLive
  (`edge.wedd48c.top`) responde `403` al endpoint de token y al `.m3u8` para cualquier
  cliente que no sea un navegador real: la aplicación no ejecuta JavaScript ni resuelve
  CAPTCHAs, así que esos canales quedan como enlace a la página del origen.
- **TVEnVivo** publica cada vez más canales mediante iframes de terceros
  (`tvporinternet.org`, chats) sin HLS estático; solo se publican los que exponen
  `var src = "…m3u8"`.
- **Global Free TV** se recorta a 45 canales por país para que la recolección quepa en
  el tiempo límite; subirlo multiplica las peticiones.
- **eja.tv** devuelve 6 canales por página y no publica marcador de fin: se corta al
  llegar al total anunciado o al tope de páginas.
- Las URLs firmadas de iptvcat y las de TVEnVivo **caducan**; por eso el catálogo se
  refresca cada 30 minutos y las listas cada 5.
- Geobloqueo: algunos canales solo emiten dentro de su país; se marcan con
  "puede estar geobloqueado" cuando la fuente lo indica, pero no se puede comprobar
  desde el servidor.
- No se ejecuta JavaScript de terceros, no se usan cookies y no se resuelven CAPTCHAs.

## Estructura

```
index.js                     servidor Express (addon + M3U + rutas)
engines/live/http.js         descargas con validación de destino y redirecciones
engines/live/limit.js        concurrencia limitada
engines/live/text.js         limpieza de nombres, slugs e identificadores
engines/live/catalog.js      recolección, caché con TTL y fusión de fuentes
engines/live/m3u.js          generación y lectura de listas M3U
engines/live/addon.js        manifiesto, catálogos, meta y streams
engines/live/sources/*.js    un recolector por web
scripts/live-check.js        verificación real contra las siete fuentes
test/                        pruebas unitarias con instantáneas de HTML/JSON
```

## Aviso legal

El proyecto no aloja ni retransmite contenido: solo indexa enlaces que esas webs
publican abiertamente. Úsalo para uso personal y respeta la legislación de tu país y
las condiciones de cada sitio.
