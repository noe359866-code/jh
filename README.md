# Latino Stream Addon

Addon HTTP para Stremio. Incluye catálogos **de ejemplo**, metadatos básicos y resolución de streams directos configurados por el administrador. **No incluye un catálogo actualizado ni extractores funcionales para sitios externos.**

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

Para integrar FlixLatam, Area Documental, Documaniatv, SeriesPeru o DoramasYT hace falta implementar y probar adaptadores reales, identificación de títulos/episodios y resolución de medios autorizados. Esta revisión no pudo verificar esos sitios porque el entorno restringe las conexiones externas a registros de paquetes y GitHub.
