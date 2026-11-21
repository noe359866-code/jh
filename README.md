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
  - **VOE** (`voe.js`): descifra el payload AES-128-CBC de la página del player y extrae la fuente `.m3u8`.
  - **Streamtape** (`streamtape.js`): extrae los parámetros del script `botlink` y construye la URL `get_video`.
  - **Vidsrc.to** (`vidsrc.js`): obtiene el media ID y descifra la URL del embed con RC4.
  - **Genérico** (`base.js`): barrido literal de candidatos `.m3u8`/`.mp4` y verificación por firma; es el resolvedor por defecto para hosts no reconocidos.
- **Registry** (`engines/resolvers/index.js`): dispatcher central que, dada una URL de embed, localiza el resolvedor cuyo dominio coincide y lo invoca. Equivale al dispatcher de `Extractor.kt` de Streamflix.

**Flujo de resolución**: `GET /stream/site?url=` → el proveedor descubre los servidores en la página → cada servidor se pasa al registry → el resolvedor correspondiente resuelve la URL a HLS/MP4 verificado → se devuelven los streams con el nombre del sitio como contexto.

## Resolución directa de sitios (mp4/HLS)

`GET /stream/site?url=<página del sitio>` resuelve una página de **documaniatv.com**, **flixlatam.com** o **poseidonhd2.co** y devuelve **solo** `{ "streams": [...] }`: sin catálogos, sin metadatos, sin demos y sin entradas inventadas. El endpoint está siempre activo; no requiere configuración de administrador.

```
GET /stream/site?url=https://www.documaniatv.com/pelicula/xyz
→ { "streams": [ { "name": "DocumaniaTV", "title": "HLS / MP4", "url": "https://www.documaniatv.com/cdn/a.m3u8?t=1" } ] }
```

- Solo se aceptan URLs HTTPS sin credenciales y con hostname de uno de los tres sitios (con o sin `www`). Otros hosts, HTTP claro, credenciales y URLs malformadas devuelven 400 sin hacer peticiones.
- La página se analiza como HTML estático: URLs literales `.m3u8`/`.mp4` en atributos, cadenas JS y iframes. Cada candidato se solicita con `Range` y se verifica por firma: `#EXTM3U` para HLS o caja `ftyp` para MP4. **Esto no prueba reproducción completa**, codecs, audio latino ni CORS.
- **No se ejecuta JavaScript**, no se usan cookies, no se resuelven CAPTCHAs ni se evade DRM. Reproductores que dependan de APIs dinámicas o de un Referer no están soportados.
- Los hosts confiables son solo los dominios de los tres sitios. Si un medio se sirve desde un CDN, añade sus hosts explícitamente con `SITES_ALLOWED_HOSTS=cdn.example.com,...` **después de comprobar que son confiables**; nunca se autorizan automáticamente. Los hosts no permitidos se omiten (la lista resultante puede quedar vacía).
- Transporte seguro: IPv4 público validado en el socket, sin redirecciones, sin IPv6 ni direcciones privadas. Los mismos límites del extractor HLS/MP4 se aplican (tamaño de página, tiempo por petición, diez candidatos, dos extracciones concurrentes) y hay caché por URL (30 s con medios, 5 s sin ellos).
- Fallos del extractor: 400 para solicitudes inválidas, 502 si la extracción falla, 503 (`Retry-After: 10`) si hay saturación.
- **Verificación real**: el entorno de desarrollo solo permite salida a GitHub y registros de paquetes, no a estos dominios, así que no se afirma que funcione contra los sitios reales. Para comprobarlo, usa un URL de prueba con acceso real:

```sh
SITES_TEST_URL=https://www.documaniatv.com/pelicula/xyz npm run test:sites-live
```

`scripts/sites-live.js` valida cada URL antes de hacer peticiones, resuelve la página y **falla si ningún sitio de la lista devuelve al menos un medio con firma válida**. Por defecto prueba los tres sitios (`documaniatv.com`, `flixlatam.com`, `poseidonhd2.co`); puedes indicar URLs concretas con `SITES_TEST_URLS` (separadas por comas). Escribe un reporte sanitizado en `reports/sites-live.json` con el resultado por sitio (disponible, hosts encontrados/bloqueados y conteos; **no URLs, queries, HTML ni tokens**), y imprime por consola cuáles devolvieron HLS/MP4. Si aparecen eventos `blocked-frame`/`blocked-host`, revisa ese dominio antes de autorizarlo en `SITES_ALLOWED_HOSTS`; nunca habilites dominios automáticamente. Los reportes locales quedan en `reports/`, fuera de Git. Las pruebas de `npm test` son deterministas y mockadas, y no sustituyen esta comprobación.

En GitHub Actions, el workflow **Sites live extraction** se ejecuta al hacer push: prueba los sitios con red real y sube `sites-live-report` con el reporte sanitizado incluso si falla. El reporte se commita en la misma rama (con normalización para evitar bucles). GitHub puede exigir que el workflow exista primero en la rama predeterminada; no se afirma que haya pasado: el entorno de desarrollo solo permite salida a GitHub y registros de paquetes, no a estos dominios. Si falla, inspecciona el flujo real y ajusta los hosts; no conviertas un fallo en un skip.

## Caché y diagnósticos

Cada instancia deduplica peticiones simultáneas al mismo URL, mantiene hasta 100 resultados y limita a dos trabajos distintos concurrentes por resolver. Caché de extracción: 30 segundos si hay medios y 5 segundos si no los hay; errores no se cachean. Estos límites no sustituyen controles de tráfico en el proxy. Las URLs temporales pueden expirar incluso dentro de ese período.

El workflow en vivo permite probar páginas y sube `sites-live-report` incluso cuando falla. El reporte contiene hosts encontrados/bloqueados y conteos, **no URLs, queries, HTML ni tokens**. Si aparece `blocked-frame` o `blocked-host`, revisa el dominio antes de autorizarlo; nunca habilites dominios automáticamente. Los reportes locales quedan en `reports/`, fuera de Git. Un reporte fallido sin eventos puede indicar fallo de validación o conectividad antes de iniciar el análisis HTML.

## Verificación y límites

`npm run check`, `npm test` y `npm audit --omit=dev` comprueban sintaxis, contrato HTTP, resolución de configuración y dependencias respectivamente. Las pruebas usan dominios de ejemplo y no descargan videos: **no validan reproducción real ni extractores externos**. CI está configurada para Node 22 y 24; la ejecución local se verificó en Node 22. La imagen Docker necesita una comprobación adicional en un entorno con Docker.

El extractor de sitios es estático: no se ejecuta JavaScript, no se usan cookies, no se resuelven CAPTCHAs ni se evade DRM. Reproductores que dependan de APIs dinámicas o de un Referer no están soportados. Una lista vacía puede significar formato no soportado o que los medios estén en hosts no autorizados, no necesariamente ausencia de contenido en la página.
