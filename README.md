# TV en Español · Addon de Stremio y listas M3U

Canales de **televisión en directo en español** (España y Latinoamérica), recopilados
en vivo desde siete webs públicas. El proyecto expone un **addon de Stremio** y
**listas M3U** listas para VLC, Kodi, TiviMate, IPTVnator o cualquier reproductor
compatible.

> Sustituye por completo al antiguo addon de películas y series: ahora el catálogo
> es solo TV en directo, y solo canales en español.

## Estado real (última verificación en vivo)

Medido el **22/11/2026** ejecutando `npm run test:live` contra las siete fuentes:

| Fuente | Modo | Canales | Notas |
|---|---|---:|---|
| tvgarden.world | directo | 1.211 | API JSON por país (`/api/tv/countries/<cc>.json`) |
| iptvcat.net | directo | 1.170 | mini‑M3U firmadas por tarjeta (`data-clipboard-text`) |
| eja.tv | directo | 699 | paginación `?offset=` de 6 en 6, filtro `language=spa` |
| globalfreetv.com | directo | 243 | HTML SSR; 45 canales/país por límite de peticiones |
| tvenvivo.org | embed | 70 | cadena `core.php`/iframe; hoy la resuelve JavaScript |
| thedaddy.li | embed | 29 | el CDN solo emite token a un navegador real |
| livelive24.com | embed | 29 | el reproductor es un blogspot sin HLS estático |

**Total: 1.857 canales únicos · 1.832 con medio reproducible o resoluble ·
323 de España · 1.534 de Latinoamérica · 2.830 entradas M3U** (un canal puede
aportar varias señales).

En la misma pasada se comprobaron 10 canales al azar: **6 devolvieron una firma HLS
válida** (`#EXTM3U`) y los 4 restantes eran de DaddyLive, que no resuelve sin
navegador (ver limitaciones).

Estas cifras cambian a diario: las fuentes son webs de terceros y publican y retiran
señales sin aviso. El endpoint `/config` devuelve el estado de cada fuente en el
momento de la última recolección.

## Arranque

```bash
npm ci
npm start                 # http://localhost:8080
PORT=3000 npm start       # otro puerto
CACHE_TTL=600000 npm start  # TTL del catálogo en ms (por defecto 30 min, mínimo 1 min)
```

Con Docker:

```bash
docker build -t tv-espanol .
docker run --rm -p 8080:8080 tv-espanol

# conservar el informe del verificador entre reinicios
docker run --rm -p 8080:8080 -v "$PWD/reports:/app/reports" tv-espanol
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
| TV · Caídos (verificador) | `caidos` | `skip` |

Cada canal es un `meta` con póster (si la fuente lo trae), país, categoría y las
fuentes que lo aportan. Las señales se entregan como HLS directo; cuando el origen
exige `Referer` o `User-Agent`, se envían como `proxyHeaders` para que el
reproductor de Stremio los use.

## Fuentes

Además de los siete sitios que se recorren, el catálogo incorpora seis listas M3U
externas de canales en español. Se descargan en cada pasada, se normalizan con el
mismo parser (`engines/live/sources/playlist.js`) y pasan por el verificador como
cualquier otra fuente:

| Fuente | Lista | Aporta |
|---|---|---|
| CineCity | `CINECITY2023/cinecity` (`principal.m3u`, rama `cinecity.net`) | cine, deportes y regionales de Argentina y México |
| Telechancho | `telechancho.github.io/infinity.m3u` | generalistas, noticias y radios de Argentina |
| iptv-chile | `Orieus-lesauce/iptv-chile` (`CL.m3u`) | 23 canales nacionales chilenos (Mega, CHV, TVN, La Red…) |
| Samsung TV Plus ES | `BuddyChewChew/app-m3u-generator` (`samsungtvplus_es.m3u`) | 194 canales FAST de España, servidos vía `jmp2.uk` |
| Pluto TV | `iprtl/m3u` (rama `live`, `Pluto.m3u`) | solo los canales hispanos de sus 850 entradas |
| D9Kod | `s.id/d9Kod` | lo que publique el acortador, verificado antes de listarse |

Detalles de la normalización:

- **Solo español.** Se descarta la entrada si declara `tvg-language` distinto de
  español (`por`, `pt`, `eng`, `fra`, `deu`, `ita`…). Nada se inventa: un canal
  sin país identificable se queda como internacional, no se elimina.
- **País por tres vías**, en este orden: bandera o sufijo del nombre (`Mega [CL]`,
  `La 1 (ES)`), `tvg-country`/`group-title` (`🌍 Mexico`, `🏙️ Buenos Aires`) y
  lista de procedencia (Samsung ES → España). España va a la lista `es` y el resto
  de países hispanos a `latam`; ambos entran también en `all`.
- **Redirectores.** `jmp2.uk` y `s.id` sirven un `#EXTM3U` aunque la URL no acabe
  en `.m3u8`: se tratan como medio directo y el verificador sigue el 302 y
  comprueba la firma del destino final. Si el destino no responde, el canal queda
  caído y no se publica.
- **Tolerancia.** Líneas `EXTINF` mal formadas, URLs `rtmp://` y entradas sin URL
  se ignoran sin romper la lista. Una lista que no responde no tumba el catálogo:
  las demás siguen aportando canales.

Medición en CI (última pasada): catálogo **3803 canales, 3388 con medio directo**;
listas `all` **4210**, `es` **516**, `latam` **3694**, `deportes` **170**. Las seis
listas dominan el catálogo (solas eran 1860 canales antes de incorporarlas).

## Listas M3U

| Lista | Ruta | Contenido |
|---|---|---|
| Todo | `/playlist/all.m3u` (alias `/playlist.m3u`) | todos los canales |
| España | `/playlist/es.m3u` | solo España |
| Latinoamérica | `/playlist/latam.m3u` | solo Latinoamérica |
| Deportes | `/playlist/deportes.m3u` | solo deportes |

Los canales caídos (según el verificador) se excluyen de todas ellas; añade
`?dead=1` para incluirlos.

Ejemplo:

```
https://TU-DOMINIO/playlist/all.m3u
https://TU-DOMINIO/playlist/es.m3u?pages=1
```

- `?pages=1` resuelve además las **fuentes de página** (TVEnVivo y DaddyLive) antes de
  escribir la lista. Sin el parámetro solo se publican medios directos, que es lo más
  rápido y estable.
- La respuesta lleva `X-Channel-Count` (y `X-Checked-At` si hay informe de salud) y
  se cachea 5 minutos.
- Cada entrada incluye `tvg-id`, `tvg-logo`, `group-title` (`España · Deportes`,
  `Latinoamérica · Noticias`…), y `#EXTVLCOPT` con `Referer`/`User-Agent` cuando la
  fuente los exige.
- `/playlists.json` da recuentos por lista y `/config` el estado de cada fuente.

## Verificador de señales (canales caídos)

No todos los canales que publican las webs siguen emitiendo. El servidor los
**sondea** y quita de las listas solo los que están demostrablemente muertos.

**Qué se considera caído** (para no borrar canales buenos por error):

| Resultado del sondeo | Veredicto | ¿Se elimina? |
|---|---|---|
| `404`, `410`, `451`, DNS roto | **caído** | sí |
| `401`, `403`, `429`, `503` | bloqueado (límite o geobloqueo) | no |
| timeout / sin firma inesperada | tiempo agotado (sin confirmar) | no |
| fuente de catálogo o página sin resolutor | desconocido | no |

El sondeo pide solo los primeros 8 KB de cada medio, reintenta una vez los fallos
de red/tiempo, reutiliza el resultado cuando el mismo medio aparece en varios
canales y tiene un presupuesto total de tiempo: lo que no cabe se reintenta en la
siguiente pasada. Si el propio entorno se queda sin salida a internet, el informe
se marca **no concluyente** y no se usa para filtrar.

**Medición real** (22/11/2026, 1.764 canales sondeados en 170 s):

| Vivos | Caídos | Bloqueados | Tiempo agotado |
|---:|---:|---:|---:|
| 1.655 | **109** | 291 | 95 |

De los 109 caídos, 81 eran `404` y 28 dominios que ya no resuelven.

**En Stremio**: los caídos desaparecen de los catálogos normales y de las listas;
se pueden revisar en el catálogo **`TV · Caídos (verificador)`**, donde cada ficha
explica el motivo. También está `GET /health/dead.json`.

**En M3U**: se excluyen por defecto. `?dead=1` los devuelve para depurar.

Control:

- El informe se calcula **al arrancar** (en segundo plano, sin retrasar el
  `listen`) y se guarda en `reports/health.json`; tras un reinicio se reutiliza
  mientras tenga menos de 6 h.
- `?check=1` en una lista o en `/health.json` fuerza un sondeo nuevo (con
  presupuesto de 25 s; si tarda más se responde con el informe anterior).
- Desactivar: `createApp({ checker: null })`.

```bash
npm run verify                 # informe + listas sin caídos en reports/
LIMIT=40 npm run verify        # muestra rápida
CONCURRENCY=32 npm run verify  # más paralelismo
FAIL_ON_DEAD=1 npm run verify  # exit 1 si hay caídos (CI estricta)
```

Deja `reports/health.json`, `reports/dead.txt` y copias `reports/playlist-*.m3u`
ya filtradas. El workflow `verify.yml` lo ejecuta a diario a las 04:47 UTC y
publica los artefactos.

## Extracción de HLS de los embeds

Las fuentes con reproductor (`tvenvivo`, `thedaddy`, `livelive24`) no publican el
`.m3u8` en el HTML: dan una página con un iframe. El servidor **intenta extraer el
HLS al recolectar**, no solo al reproducir:

1. Sigue la cadena documentada de cada fuente (`core.php`, `watch.php`, blogspot).
2. Si falla, usa un extractor genérico que busca el `.m3u8` en:
   URL literal, barras escapadas (`https:\/\/…`), base64, JSON escapado,
   rutas relativas, `<video>`, `<source>` y hasta 3 iframes anidados.
3. Solo publica el HLS si el medio responde con **firma HLS** (los primeros 4 KB).
4. Si no, el canal conserva su enlace de página y se resuelve al reproducir.

Límites: 3 canales en paralelo, pausa entre canales, reintento ante `403/429`,
presupuesto de 100 s y `EXTRACT_HLS=0` para desactivarla. Un origen que no entrega
ni un HLS en dos recolecciones seguidas queda **penalizado 6 h** (no se gasta el
presupuesto en él y se reintenta más tarde).

**Resultado medido** (22/11/2026): de **124 canales con embed, 0 HLS extraídos**.
Los motivos, verificados con sonda:

| Fuente | Qué devuelve realmente |
|---|---|
| tvenvivo | el iframe regional responde un *loader* de 1.9 KB que monta el reproductor con JavaScript; `core.php` ya no expone `var src` |
| thedaddy | `dembed.st` responde **403** salvo con un navegador real; el CDN también |
| livelive24 | la página de blogspot (24 KB) no tiene iframes ni `.m3u8` |

Es decir: **esos canales no se pueden resolver sin ejecutar JavaScript**, y el
proyecto no lo hace (sin navegador headless, sin cookies, sin CAPTCHAs). La
extracción queda implementada y probada; en cuanto un origen vuelva a servir el
HLS de forma estática, se publicará automáticamente sin tocar código.

## Rutas HTTP

| Ruta | Descripción |
|---|---|
| `GET /manifest.json` | manifiesto del addon (`org.tvespanol.live`) |
| `GET /catalog/tv/:id.json` | catálogo paginado (`skip`, `genre`) |
| `GET /meta/tv/:id.json` | metadatos de un canal |
| `GET /stream/tv/:id.json` | señales reproducibles de un canal |
| `GET /playlist/:variant.m3u` | listas M3U (`all`, `es`, `latam`, `deportes`) |
| `GET /playlists.json` | índice de listas con recuentos y salud |
| `GET /health.json` | informe del verificador (vivos, caídos, bloqueados) |
| `GET /health/dead.json` | canales caídos en formato Stremio |
| `GET /config` | estado y tiempos de cada fuente |
| `GET /stream/page?url=` | resuelve una página de origen (solo `tvenvivo.org` y `thedaddy.li`) |
| `GET /` | portada con enlaces |

Todas las respuestas llevan CORS abierto. Si la recolección falla por completo (o
no está lista) se devuelve `503` con `Retry-After`. Un catálogo vacío nunca
sustituye a la última copia buena: se sigue sirviendo esa copia y `/config` la marca
con `stale: true` y `staleReason`.

## Fuentes y modos

| Fuente | Modo | Cómo se extrae |
|---|---|---|
| eja.tv | directo | listado `/?country=<cc>&offset=N`, 6 tarjetas por página, `<source src>` m3u8 |
| iptvcat.net | directo | listado por país (`spain__9`, `mexico__6`…), 100 filas, mini‑M3U en `data-clipboard-text` |
| tvgarden.world | directo | API JSON por país con `stream_urls[]` |
| globalfreetv.com | directo | HTML SSR: `channel:$R[n]={…}` + `streams:$R[m]=[…]` con `url` y `http_referrer` |
| tvenvivo.org | embed | `core.php?canal=<slug>` → iframe → `var src = "…m3u8"` |
| thedaddy.li | embed | `watch.php?id=N` → `stream-N.php` → embed → `const SRC` |
| livelive24.com | embed | reproductor intermedio (blogspot) → `.m3u8` literal si existe |
| CineCity, Telechancho, iptv-chile, Samsung TV Plus ES, Pluto TV, D9Kod | directo | listas M3U propias, descargadas y normalizadas (ver «Fuentes») |

**Modos:** `directo` = el canal ya trae una URL de medio; `página` = hay que resolver
una cadena de iframes al reproducir; `catálogo` = la fuente solo aporta el nombre y el
enlace a su página, así que el canal se publica como enlace externo.

Solo se incluyen **países de habla hispana**: España (ES) y Latinoamérica (MX, AR, CO,
CL, PE, VE, EC, GT, HN, SV, NI, CR, PA, CU, DO, PR, UY, PY, BO) más las señales en
español de EE. UU. Todos los canales se etiquetan con su país de origen.

## Verificación

```bash
npm test        # 53 pruebas unitarias (parser + addon + rutas + verificador + extracción), sin red
npm run check   # node --check sobre todo el motor
npm run test:live   # comprobación real contra las 13 fuentes (necesita red)
SOURCE=eja,tvgarden npm run test:live   # solo algunas fuentes
npm run verify  # sondeo de señales y listas limpias (necesita red)
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
engines/live/checker.js      verificador de señales (caído / bloqueado / sin confirmar)
engines/live/extract.js      extracción de HLS de embeds al recolectar
engines/live/sources/*.js    un recolector por web
scripts/live-check.js        verificación real contra las siete fuentes
scripts/verify.js            sondeo de cada canal + listas sin caídos
test/                        pruebas unitarias con instantáneas de HTML/JSON
```

## Aviso legal

El proyecto no aloja ni retransmite contenido: solo indexa enlaces que esas webs
publican abiertamente. Úsalo para uso personal y respeta la legislación de tu país y
las condiciones de cada sitio.
