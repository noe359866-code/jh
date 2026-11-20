# Latino Stream Addon

Addon HTTP para Stremio. Incluye catálogos **de ejemplo**, metadatos básicos y resolución de streams directos configurados por el administrador. **No incluye un catálogo actualizado. La extracción experimental Embed69 requiere activación y verificación contra el proveedor real.**

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

## Errores encontrados y correcciones

1. **URLs inventadas, no extracción real.** Las cinco funciones solo interpolaban el IMDb en una URL. La primera siempre devolvía texto y bloqueaba las restantes. Se eliminaron estas falsas integraciones; ahora solo se entregan fuentes explícitamente configuradas.
2. **Manifiesto incompatible.** Se usaban `resource`, `type`, `id_prefixes` y `behaviour_hints` en lugar de los campos esperados. Ahora declara `resources`, `types` e `idPrefixes`; se quitaron hints inexistentes. El endpoint y el archivo ya no duplican el manifiesto.
3. **Catálogos incompatibles.** Faltaba el tipo en las rutas y se devolvían arrays sin `{ metas }`. Faltaba `type` en cada elemento. Se corrigieron las rutas y respuestas, y se añadió el recurso `meta`.
4. **Datos incorrectos.** Había una serie en películas y varios IMDb no correspondían al título. Se corrigieron esos datos y se retiraron posters que apuntaban solo a un directorio de TMDB, no a imágenes.
5. **Episodios indistinguibles.** No se validaban temporada ni episodio. Ahora se usan IDs completos y se separan las fuentes por episodio.
6. **Ausencia de fuentes tratada como error.** Ahora una búsqueda válida sin resultados devuelve `streams: []` con HTTP 200.
7. **Pruebas que daban falsos positivos.** Buscaban una cadena en URLs inventadas; un fallo solo imprimía texto sin hacer fallar CI. El workflow apuntaba a una rama antigua y tenía `timeout` en un paso en vez de `timeout-minutes`. Se reemplazó por pruebas con aserciones reales que fallan con código distinto de cero, activas en pushes y PRs.
8. **Arranque al importar.** Importar `index.js` abría un puerto; ahora `createApp()` permite pruebas aisladas y solo el punto de entrada inicia el servidor.
9. **Dependencias y runtime inconsistentes.** Axios y Cheerio se importaban sin usarse. Se eliminaron; el runtime mínimo y Docker ahora usan Node 22, y CI cubre 22 y 24.
10. **Documentación engañosa o ausente.** La página anunciaba extracción que no existía y el README solo tenía un título. Ahora se explican configuración, límites y despliegue.
11. **Dependencias generadas dentro de Git.** Se habían versionado 2034 archivos de `node_modules`. Se retiraron del índice y se añadió `.gitignore`; se reproducen con `npm ci` a partir del lockfile, sin guardar paquetes generados en el repositorio.

## Verificación y límites

`npm run check`, `npm test` y `npm audit --omit=dev` comprueban sintaxis, contrato HTTP, resolución de configuración y dependencias respectivamente. Las pruebas usan dominios de ejemplo y no descargan videos: **no validan reproducción real ni extractores externos**. CI está configurada para Node 22 y 24; la ejecución local se verificó en Node 22. La imagen Docker necesita una comprobación adicional en un entorno con Docker.

JH incluye el descubrimiento experimental Embed69 y un adaptador estático experimental FlixLatam (ver configuración al final). Incluye un extractor estático experimental HLS/MP4: no se ha confirmado todavía su compatibilidad con el reproductor real de Embed69.


## Integración experimental: Embed69

El plugin WordPress **ToroPlay Embed69 Auto 1.1.0** no contiene un extractor de video. Su código consulta `https://apiz.6969009.xyz/api/check` y construye páginas `https://embed69.org/f/...`; además automatiza cómo WordPress guarda esos enlaces en los metadatos de ToroPlay. Por eso no se copió el plugin PHP ni se presentó una página HTML como si fuera un stream reproducible.

JH incorpora ahora un adaptador Node.js aislado en `engines/embed69/` que:
- valida IMDb IDs;
- consulta disponibilidad de películas, series y episodios;
- conserva el formato de episodio `IMDb-temporadaxepisodio` con dos dígitos;
- construye la URL de la página Embed69 solo cuando la API confirma disponibilidad;
- falla de forma explícita ante respuestas HTTP o JSON inesperadas.

Endpoint de diagnóstico:
- `GET /providers/embed69/check/movie/tt0137523.json`
- `GET /providers/embed69/check/series/tt0944947.json`
- `GET /providers/embed69/check/episode/tt0944947.json?season=1&episode=5`

**El endpoint de diagnóstico sigue siendo solo descubrimiento** (`playable: false`). El resolver experimental descrito abajo es independiente y solo devuelve candidatos cuya respuesta tenga firma HLS o MP4. No se ha verificado contra Embed69 en vivo.


## Extractor estático HLS/MP4 (experimental)

```sh
EMBED69_ENABLED=true EMBED69_ALLOWED_HOSTS=embed69.org npm start
```

`/stream` prioriza las fuentes configuradas. Si no hay fuentes y se activa el proveedor, consulta disponibilidad y analiza HTML, cadenas JS con URLs literales y hasta cinco páginas/iframes. Agrega explícitamente los hosts de iframes y medios a `EMBED69_ALLOWED_HOSTS` (separados por comas) después de comprobar que son confiables. Solo HTTPS, sin credenciales, sin redirecciones automáticas. Limita tamaño de página, tiempo por petición, diez candidatos y dos extracciones simultáneas por instancia. Un fallo del proveedor produce 502; saturación produce 503.

Cada candidato se solicita con Range y se inspecciona su firma: `#EXTM3U` o caja MP4 `ftyp`. **Esto no prueba reproducción completa**, segmentos HLS, codecs, audio latino, permisos, CORS ni duración. No se inventan URLs. No ejecuta JavaScript, desempaqueta código, resuelve CAPTCHA, usa cookies, evade DRM ni añade Referer: reproductores que dependan de eso o de APIs dinámicas no están soportados. Una lista vacía puede significar formato no soportado, no necesariamente ausencia del título.

El transporte Undici valida el IPv4 que entrega al socket, sin una segunda resolución DNS entre la validación y la conexión. Se rechazan IPs privadas, reservadas e IPv6 y se desactivan redirecciones también en la API de disponibilidad. Para servidores públicos utiliza filtrado de salida a nivel de red, únicamente hosts confiables y límites de solicitudes en el proxy inverso. La concurrencia limitada no sustituye rate limiting por cliente.

### Prueba real en GitHub Actions

El workflow **Embed69 live extraction** se ejecuta manualmente con `workflow_dispatch`, un IMDb que tengas autorización para probar y la lista de hosts confiables. Usa red real, no mocks, y **falla si no encuentra al menos un medio con firma válida**. No imprime URLs firmadas. Las entradas se pasan como variables de entorno, no se interpolan en comandos shell.

Equivalente local (requiere acceso a esos dominios):

```sh
EMBED69_TEST_IMDB=ttXXXXXXX EMBED69_ALLOWED_HOSTS=embed69.org npm run test:live
```

Este workflow debe publicarse en GitHub para poder ejecutarse; GitHub puede exigir que `workflow_dispatch` exista primero en la rama predeterminada. No se afirma que haya pasado: el entorno de desarrollo solo permite salida a GitHub y registros de paquetes, no a Embed69. Si falla, inspecciona el flujo real y ajusta el adaptador o los hosts; no conviertas un fallo en un skip. Las pruebas de `npm test` son deterministas y no sustituyen esta comprobación.


### Caché y diagnósticos

Cada instancia deduplica peticiones simultáneas al mismo título, mantiene hasta 100 resultados y limita a dos trabajos distintos concurrentes por resolver (descubrimiento y extracción tienen presupuestos separados). Caché de extracción: 30 segundos si hay medios y 5 segundos si no los hay; errores no se cachean. Descubrimiento se cachea 30 segundos. Estos límites no sustituyen controles de tráfico en el proxy. Las URLs temporales pueden expirar incluso dentro de ese período.

El workflow en vivo permite probar películas o episodios y sube `embed69-live-report` incluso cuando falla. El reporte contiene disponibilidad, hosts encontrados/bloqueados y conteos, **no URLs, queries, HTML ni tokens**. Si aparece `blocked-frame` o `blocked-host`, revisa el dominio antes de autorizarlo; nunca habilites dominios automáticamente. Los reportes locales quedan en `reports/`, fuera de Git. Un reporte fallido sin eventos puede indicar fallo de API, validación o conectividad antes de iniciar el análisis HTML.

## FlixLatam: extractor HLS/MP4 experimental

Implementación en `engines/flixlatam/` con motor compartido `engines/media/`.
Extrae URLs literales de HTML, configuración JS y scripts externos autorizados,
recorre iframes y admite `<source type="application/x-mpegURL">` o `video/mp4`
con URLs sin extensión. **No ejecuta JavaScript**. Comprueba la firma de cada
respuesta; no devuelve páginas HTML como videos. Un iframe secundario roto no
impide comprobar las demás fuentes. Se conservan los límites y el transporte
público seguro del extractor anterior.

### Probar una página exacta

```sh
FLIXLATAM_TEST_PAGE='https://flixlatam.com/RUTA-REAL' \
FLIXLATAM_ALLOWED_HOSTS='flixlatam.com,www.flixlatam.com,HOST-REAL-DEL-REPRODUCTOR,HOST-REAL-DEL-VIDEO' \
npm run test:flixlatam
```

Sustituye los marcadores por URLs/hosts inspeccionados y autorizados. El comando
falla si no encuentra medios verificables. Produce `reports/flixlatam-live.json`
sin URLs ni tokens. También existe el workflow manual **FlixLatam live extraction**.
La prueba real se ejecutó desde GitHub Actions (ver resultado abajo); el sandbox
local no tiene salida directa a esos dominios. Las pruebas unitarias usan fixtures
sintéticos, no capturas del reproductor real de FlixLatam.

### Usar en Stremio / Render

El sitio usa slugs propios: no se ha verificado una API de búsqueda por IMDb.
Por eso el addon **no inventa URLs ni correspondencias**. Configura un JSON externo
con una URL de página/reproductor por ID exacto:

```json
{
  "movie:tt0137523": "https://flixlatam.com/RUTA-REAL-DE-LA-PELICULA"
}
```

Este ejemplo es solo estructura, no una fuente funcional. Para episodios la clave
es `series:IMDb:temporada:episodio`. La URL debe identificar el reproductor de ese
episodio: **no se admite `#s1-e2`**, pues un fetch no ejecuta la navegación por hash
y podría devolver otro episodio. No se ofrece descubrimiento automático de episodios.

Variables de Render:

```text
FLIXLATAM_ENABLED=true
FLIXLATAM_PAGES_FILE=/ruta/al/archivo-de-paginas.json
FLIXLATAM_ALLOWED_HOSTS=flixlatam.com,www.flixlatam.com,DOMINIOS-REALES-VERIFICADOS
```

El archivo se valida al arrancar. Sin archivo el mapa está vacío y no hay fuentes.
Si están activados ambos proveedores, FlixLatam tiene prioridad y no hay fallback
silencioso a Embed69. Las fuentes directas de `streams.json` siguen teniendo
prioridad sobre ambos. Caché y control de concurrencia se aplican por instancia.
No hay endpoint público que permita solicitar URLs arbitrarias al servidor.

**Límite:** esto implementa extracción estática, no confirma compatibilidad con
el reproductor actual de FlixLatam ni reproducción completa en Stremio. No soporta
DRM, CAPTCHA, sesiones privadas, tokens calculados ni APIs dinámicas no inspeccionadas.
Usa únicamente fuentes que tengas autorización para reproducir/distribuir.


### Resultado de la comprobación real (2026-11-20)

Se probó `https://flixlatam.com/pelicula/el-secreto-r02nyv` desde GitHub Actions.
La página respondió HTTP 200 y contenía un iframe a `embed69.org`. Al autorizar
ese host en una segunda configuración, el iframe y su script respondieron también
HTTP 200, pero el análisis estático encontró **cero candidatos HLS/MP4**. El check
falló con `NO_VERIFIED_MEDIA`; no se marcó como éxito ni se omitió la prueba.
Esto solo verifica esa ficha y ese método, no todo el catálogo ni la ausencia de
video en el sitio. Se necesita inspeccionar el flujo dinámico del reproductor para
avanzar; cambiar de Embed69 a esta ficha de FlixLatam no eliminó esa dependencia.

Ejecución: https://github.com/noe359866-code/jh/actions/runs/44821306666

Las anotaciones y el artefacto `flixlatam-live-report` contienen el diagnóstico
sanitizado. Las pruebas deterministas y Docker pasan por separado.
