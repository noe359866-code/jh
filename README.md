# Addon Latino Stream

Addon HTTP para Stremio. Incluye catálogos **de ejemplo**, metadatos básicos y resolución de streams directos configurados por el administrador. **No incluye un catálogo actualizado.** Incluye además resolución de streams (mp4/HLS verificados) para **documaniatv.com**, **flixlatam.com** y **poseidonhd2.co** mediante una arquitectura de **proveedores** y **resolvedores de reproductores**: `GET /stream/site?url=<página del sitio>`, que solo devuelve `{ streams }`.

## Ejecutar

Requiere Node.js 22 o superior.

```sh
npm ci
npm test
npm start
```

Escucha en `0.0.0.0:8080`. Se puede cambiar el puerto con `PORT`.
Para instalarlo, utiliza la URL pública HTTPS del servidor terminada en `/manifest.json` en Stremio. El despliegue público debe proporcionar HTTPS mediante el alojamiento o un proxy inverso.

## Configurar reproducción

Por defecto `streams.json` contiene `{}`: no se promete ninguna fuente que no exista. Configura únicamente enlaces directos HLS/MP4 que tengas autorización para distribuir. Ejemplo de **estructura** (el dominio de ejemplo no reproduce contenido):

```json
{
  "movie:tt0137523": [
    { "name": "Mi fuente", "title": "Español latino", "url": "https://media.example.com/pelicula.m3u8" }
  ],
  "series:tt0944947:1:2": [
    { "name": "Mi fuente", "url": "https://media.example.com/episodio.mp4" }
  ]
}
```

También puedes definir `STREAMS_FILE=/ruta/streams.json`. El archivo se lee y valida al iniciar: reinicia el servidor después de modificarlo. Un archivo ausente o inválido impide el arranque para no ocultar errores. No guardes tokens privados en Git: usa un archivo externo al repositorio si tus URLs contienen credenciales de acceso temporales. Las URLs configuradas se entregan a los clientes del addon.

Las claves usan `movie:IMDb` o `series:IMDb:temporada:episodio`. Temporada y episodio son enteros positivos; aún no se admiten especiales de temporada cero. Anime se publica como `series`, un tipo estándar de Stremio. Las series del catálogo muestran en sus metadatos los episodios que tengan al menos una fuente configurada, ordenados numéricamente por temporada y episodio. No se inventan episodios sin fuentes ni se descarga una guía externa de episodios. También se pueden resolver episodios solicitados desde otros catálogos compatibles mediante su ID IMDb completo.

Solo se admiten URLs HTTP(S) cuya ruta termine en `.m3u8` o `.mp4` (con query string opcional). Las páginas HTML, iframes y URLs de reproductores no son archivos reproducibles. La validación de configuración comprueba la forma de la URL, **no** su disponibilidad, idioma, derechos, codecs, CORS ni reproducción en Stremio. No se hacen solicitudes a esas URLs desde el servidor.

## Endpoints

- `GET /manifest.json`: manifiesto único compartido con `manifest.json`.
- `GET /catalog/movie/movies.json`: `{ "metas": [...] }`.
- `GET /catalog/series/series.json`: catálogo de series de ejemplo.
- `GET /catalog/series/anime.json`: catálogo de anime de ejemplo.
- `GET /meta/movie/tt0137523.json`: `{ "meta": {...} }`.
- `GET /stream/movie/tt0137523.json`: `{ "streams": [...] }`.
- `GET /stream/series/tt0944947:1:2.json`: streams del episodio exacto.
- `GET /stream/site?url=<página del sitio>`: resolución de streams para `documaniatv.com`, `flixlatam.com` y `poseidonhd2.co`. **Solo devuelve `{ "streams": [...] }`**; no entrega catálogos, metadatos ni entradas de demostración.
- `GET /config`: información del estado real del addon; no es un editor de configuración.

Sin fuentes configuradas para un ID válido, se devuelve HTTP 200 con `{ "streams": [] }`. IDs mal formados dan 400; tipos, catálogos y rutas no reconocidos dan 404. No se conservan las rutas antiguas `/catalog/movies.json` porque no siguen el protocolo de Stremio.

## Docker

```sh
docker build -t latino-addon .
docker run --rm -p 8080:8080 latino-addon
```

La imagen incluye la configuración vacía y ejecuta como usuario `node`, no como root. Para usar un archivo externo legible por ese usuario:

```sh
docker run --rm -p 8080:8080 \
  -v "$PWD/mis-streams.json:/config/streams.json:ro" \
  -e STREAMS_FILE=/config/streams.json latino-addon
```

## Arquitectura: proveedores y resolvedores de reproductores

Modelado en el proyecto [Streamflix](https://git.gay/streamflix-reborn2/streamflix), todo en español:

- **Proveedores** (`engines/sites/`): cada uno corresponde a un sitio (DocumaniaTV, FlixLatam, PoseidonHD2). Su función es descubrir las URLs de **servidores** (players/embeds) en una página de contenido, equivalente a los `*Provider.kt` de Streamflix. Solo resuelven streams: no catálogos, no metadatos, no demos.
- **Resolvedores de reproductores** (`engines/resolvers/`): cada uno mapea un dominio de reproductor (o alias) a una función que, dada la URL del embed/player, devuelve streams verificados (HLS/MP4). Equivale a los `*Extractor.kt` de Streamflix. Incluye:
  - **VOE** (`voe.js`): descifra el payload AES-128-CBC de la página del player (claves por defecto del player, sobreescribibles con `VOE_KEY`/`VOE_IV`; también acepta JSON en claro) y extrae la fuente `.m3u8`. Tolera las variantes `/hls/master.txt` y similares.
  - **Streamtape** (`streamtape.js`): extrae los parámetros del script `botlink`, construye la URL `get_video` y **sigue el 302** con `redirect: 'manual'` para obtener la URI real del media. La URL `get_video` nunca se entrega como stream: no es reproducible en el cliente.
  - **Vidsrc.to** (`vidsrc.js`): obtiene el media ID de la página, pide las fuentes a su API y descifra la URL con **RC4 usando la clave completa** de `decrypt`. Si la fuente es un embed de otro reproductor, delega en el registry (un nivel, sin bucles). La clave se configura con `VIDSRC_KEYS=encrypt:decrypt`; sin ella solo puede verificar medios ya visibles en la página.
  - **Genérico** (`base.js`): barrido literal de candidatos `.m3u8`/`.mp4` y verificación por firma; es el resolvedor por defecto para hosts no reconocidos.
- **Registry** (`engines/resolvers/index.js`): dispatcher central que, dada una URL de embed, localiza el resolvedor cuyo dominio coincide y lo invoca. Equivale al dispatcher de `Extractor.kt` de Streamflix. Los hosts de reproductor conocidos (`HOSTS_REPRODUCTORES`) están autorizados explícitamente; el HTML de una página nunca amplía la allowlist.

**Flujo de resolución**: `GET /stream/site?url=` → el extractor recorre la página y sus iframes autorizados → los candidatos `.m3u8`/`.mp4` se verifican por firma → los reproductores se pasan al registry → el resolvedor correspondiente devuelve HLS/MP4 verificado → se publican con las claves de Stremio (`name`/`title`) y el nombre del sitio como contexto.

## Resolución directa de sitios (mp4/HLS)

`GET /stream/site?url=<página del sitio>` resuelve una página de **documaniatv.com**, **flixlatam.com** o **poseidonhd2.co** y devuelve **solo** `{ "streams": [...] }`: sin catálogos, sin metadatos, sin demos y sin entradas inventadas. El endpoint está siempre activo; no requiere configuración de administrador.

```
GET /stream/site?url=https://www.documaniatv.com/pelicula/xyz
→ { "streams": [ { "name": "DocumaniaTV", "title": "HLS / MP4", "url": "https://www.documaniatv.com/cdn/a.m3u8?t=1" } ] }
```

- Solo se aceptan URLs HTTPS sin credenciales y con hostname de uno de los tres sitios (con o sin `www`). Otros hosts, HTTP claro, credenciales y URLs malformadas devuelven 400 sin hacer peticiones.
- La página se analiza como HTML estático y **se recorren sus iframes** (hasta cinco páginas por extracción): URLs literales `.m3u8`/`.mp4` en atributos, `src` sin comillas, fragmentos `#t=`, `data-embed`/`data-src`, cadenas JS y entidades escapadas (`\/`, `\u002F`, `&#x2F;`, `&quot;`). Cada candidato se solicita con `Range` y se verifica por firma: una playlist HLS con `#EXT-X-STREAM-INF` o `#EXTINF`/`#EXT-X-TARGETDURATION`, o una caja `ftyp` para MP4. Una cabecera `#EXTM3U` suelta no se acepta. **Esto no prueba reproducción completa**, codecs, audio latino ni CORS.
- **No se ejecuta JavaScript**, no se usan cookies, no se resuelven CAPTCHAs ni se evade DRM. Reproductores que dependan de APIs dinámicas o de un Referer no están soportados.
- Los hosts confiables son los tres dominios del sitio más los dominios de reproductor conocidos del registry (VOE, Streamtape, Vidsrc, Doodstream, Filemoon, Vidhide, Streamwish...). Si un medio se sirve desde un CDN, añade sus hosts explícitamente con `SITES_ALLOWED_HOSTS=cdn.example.com,...` **después de comprobar que son confiables**; el HTML de la página nunca autoriza un host por sí solo. Los hosts no permitidos se omiten (la lista resultante puede quedar vacía) y se registra un evento `blocked-host`/`blocked-frame`.
- Transporte seguro: IPv4 público validado en el socket, sin redirecciones (salvo la petición `get_video` de Streamtape, que se inspecciona explícitamente), sin IPv6 ni direcciones privadas. El `lookup` inyectable se aplica también al transporte, así que la dirección validada es la que se conecta. Los mismos límites del extractor HLS/MP4 se aplican (tamaño de página, tiempo por petición, diez candidatos, dos verificaciones concurrentes) y hay caché por URL (30 s con medios, 5 s sin ellos).
- **Presupuesto de tiempo total**: además del tiempo por petición, cada extracción tiene un `deadlineMs` (20 s por defecto). Antes, diez candidatos en serie con un tiempo por petición de 10 s podían dejar la respuesta colgada durante minutos.
- Fallos del extractor: 400 para solicitudes inválidas, 502 si la extracción falla, 503 (`Retry-After: 10`) si hay saturación.
- **Verificación real**: el entorno de desarrollo solo permite salida a GitHub y registros de paquetes, no a estos dominios, así que no se afirma que funcione contra los sitios reales. Para comprobarlo, usa un URL de prueba con acceso real:

```sh
SITES_TEST_URLS=https://www.documaniatv.com/pelicula/xyz npm run test:sites-live
```

`scripts/sites-live.js` valida cada URL antes de hacer peticiones, resuelve la página y **falla si ningún sitio de la lista devuelve al menos un medio con firma válida**. Por defecto prueba los tres sitios (`documaniatv.com`, `flixlatam.com`, `poseidonhd2.co`); puedes indicar URLs concretas con `SITES_TEST_URLS` (separadas por comas). Escribe un reporte sanitizado en `reports/sites-live.json` con el resultado por sitio (disponible, hosts encontrados/bloqueados y conteos; **no URLs, queries, HTML ni tokens**), y imprime por consola cuáles devolvieron HLS/MP4. Si aparecen eventos `blocked-frame`/`blocked-host`, revisa ese dominio antes de autorizarlo en `SITES_ALLOWED_HOSTS`; nunca habilites dominios automáticamente. Los reportes locales quedan en `reports/`, fuera de Git. Las pruebas de `npm test` son deterministas y mockadas, y no sustituyen esta comprobación.

**Resultado medido** (GitHub Actions, IP de datacenter, 2026-11-21, páginas de detalle reales):

| Sitio | Páginas analizadas | Candidatos `.m3u8`/`.mp4` | Resultado |
| --- | --- | --- | --- |
| documaniatv.com | 0 | 0 | HTTP 403 (protección anti-bot: bloquea IPs de datacenter) |
| flixlatam.com | 3 (`flixlatam.com`, `embed69.org`, `uqload.vc`) | 0 | los players no exponen la URL en el HTML estático |
| poseidonhd2.co | 1 | 0 | los servidores no están en iframes ni en enlaces conocidos |

Conclusión honesta: **hoy ninguna de las tres devuelve HLS/MP4 por extracción estática**. Sobrevivir a Cloudflare (documaniatv) o a players que generan la fuente por JavaScript (embed69/uqload) exige ejecutar JS o usar una API que solo responde a sesiones de navegador; ambas cosas están fuera del alcance de este extractor por diseño. Desde una IP residencial documaniatv podría responder; el 403 es de su firewall, no del código.

En GitHub Actions, el workflow **Sites live extraction** se ejecuta al hacer push: prueba los sitios con red real y publica un resumen saneado como **comentario del commit** (los logs y artefactos del job pueden no ser accesibles), además de subir `sites-live-report` como artefacto. El reporte **no se commitea**: solo se publica como artefacto y se resume en el log. (Antes se versionaba con `git add -f`, saltándose el `.gitignore`, y quedó en el repositorio un reporte de error presentado como verificación real.) GitHub puede exigir que el workflow exista primero en la rama predeterminada; no se afirma que haya pasado: el entorno de desarrollo solo permite salida a GitHub y registros de paquetes, no a estos dominios. Si falla, inspecciona el flujo real y ajusta los hosts; no conviertas un fallo en un skip.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `PORT` | Puerto HTTP (8080 por defecto). |
| `STREAMS_FILE` | Ruta a un `streams.json` externo. |
| `SITES_ALLOWED_HOSTS` | Hosts de CDN adicionales, separados por comas. Se autorizan solo los indicados. |
| `VOE_KEY` / `VOE_IV` | Sobreescriben las claves AES-128-CBC del player VOE. |
| `VIDSRC_KEYS` | Clave RC4 de Vidsrc con formato `encrypt:decrypt`. |
| `SITES_TEST_URLS` | URLs de página para `npm run test:sites-live`. |

## Caché y diagnósticos

Cada instancia deduplica peticiones simultáneas al mismo URL, mantiene hasta 100 resultados y limita a dos trabajos distintos concurrentes por resolver. Caché de extracción: 30 segundos si hay medios y 5 segundos si no los hay; errores no se cachean. Estos límites no sustituyen controles de tráfico en el proxy. Las URLs temporales pueden expirar incluso dentro de ese período.

El workflow en vivo permite probar páginas y sube `sites-live-report` incluso cuando falla. El reporte contiene hosts encontrados/bloqueados y conteos, **no URLs, queries, HTML ni tokens**. Si aparece `blocked-frame` o `blocked-host`, revisa el dominio antes de autorizarlo; nunca habilites dominios automáticamente. Los reportes locales quedan en `reports/`, fuera de Git. Un reporte fallido sin eventos puede indicar fallo de validación o conectividad antes de iniciar el análisis HTML.

## Verificación y límites

`npm run check`, `npm test` y `npm audit --omit=dev` comprueban sintaxis, contrato HTTP, resolución de configuración y dependencias respectivamente. Las pruebas de los resolvedores usan páginas y respuestas simuladas: cubren el descifrado AES/RC4, el script `botlink` y el 302 de Streamtape, el `mediaId` de Vidsrc, la decodificación de URLs escapadas, el crawl de iframes, la allowlist y el presupuesto de tiempo, pero **no descargan videos reales ni validan reproducción**. CI está configurada para Node 22 y 24; la ejecución local se verificó en Node 22. La imagen Docker necesita una comprobación adicional en un entorno con Docker.

El extractor de sitios es estático: no se ejecuta JavaScript, no se usan cookies, no se resuelven CAPTCHAs ni se evade DRM. Reproductores que dependan de APIs dinámicas o de un Referer no están soportados. Una lista vacía puede significar formato no soportado o que los medios estén en hosts no autorizados, no necesariamente ausencia de contenido en la página.
