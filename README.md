# Latino Stream Addon

Addon HTTP para Stremio con catálogos de ejemplo. Devuelve enlaces HLS y MP4 configurados por el administrador y puede buscar enlaces en páginas HTML autorizadas. **No incluye un catálogo actualizado ni fuentes preconfiguradas**; por defecto `streams.json` contiene `{}` y no habrá streams hasta que se añadan fuentes.

## Ejecutar

Requiere Node.js 22 o superior:

```sh
npm ci
npm run check
npm test
npm start
```

Escucha en `0.0.0.0:8080`; `PORT` cambia el puerto. Para instalar el addon en Stremio usa la URL pública HTTPS terminada en `/manifest.json`. El alojamiento o proxy inverso debe proporcionar HTTPS.

## Configurar fuentes

Configura únicamente fuentes que estés autorizado a usar y distribuir. Sustituye los dominios de ejemplo por URLs reales:

```json
{
  "movie:tt0137523": [
    { "name": "HLS", "url": "https://media.example.com/pelicula.m3u8?token=ejemplo" },
    { "name": "Página", "type": "page", "url": "https://media.example.com/ver/pelicula", "headers": { "Referer": "https://media.example.com/" } },
    { "name": "MP4 sin extensión", "type": "mp4", "url": "https://media.example.com/video?id=123" }
  ],
  "series:tt0944947:1:2": [
    { "name": "Episodio", "type": "hls", "url": "https://media.example.com/stream?id=456" }
  ]
}
```

- Las claves son `movie:IMDb` o `series:IMDb:temporada:episodio`, con temporada y episodio positivos. Anime usa el tipo estándar `series`. Hay un máximo de 25 fuentes por clave.
- Sin `type`, se acepta una URL HTTP(S) terminada en `.m3u8` o `.mp4`, con query opcional. `type: "hls"` o `"mp4"` permite enlaces directos sin extensión; no fuerza el formato ni verifica que el servidor entregue el contenido indicado.
- `type: "page"` descarga HTML y busca fuentes en `video`, `source`, configuración inline de reproductores e iframes. Resuelve rutas relativas, sigue hasta dos niveles de iframes y elimina URLs repetidas. El extractor no ejecuta JavaScript ni descarga scripts externos; no descifra reproductores, no resuelve DRM, inicios de sesión, CAPTCHAs ni llamadas a APIs específicas. Una página dinámica o un reproductor incompatible puede no producir resultados.
- Opcionalmente `headers` acepta únicamente `Referer`, `Origin` y `User-Agent`. Se aplican a las solicitudes HTML, incluidos iframes y redirecciones, y se entregan en `behaviorHints.proxyHeaders.request` a Stremio para la reproducción. No pongas secretos en estas cabeceras: las reciben clientes y servidores de las páginas visitadas. Su aplicación depende del cliente/servidor de reproducción de Stremio; no se garantiza en todos los dispositivos. Cookies y tokens privados no están admitidos como cabeceras.
- Las URLs y sus tokens de consulta son visibles para los clientes. No guardes credenciales en Git; si las URLs tienen tokens, usa `STREAMS_FILE=/ruta/streams.json`. El archivo se lee al arrancar: reinicia tras modificarlo. Un archivo ausente o inválido impide el arranque.

Por cada página se revisan como máximo cinco documentos HTML, con un máximo de 1 MiB por documento, tres redirecciones por solicitud y un límite de tiempo de extracción. Se rechazan conexiones a direcciones locales, privadas o reservadas, también al resolver DNS y seguir redirecciones. La disponibilidad, codecs, derechos, CORS, segmentos HLS y reproducción real no se verifican; una fuente caída se omite sin impedir las otras. Las URLs extraídas son enviadas al cliente, no descargadas por el addon. En un despliegue público se recomienda añadir limitación de peticiones en el proxy inverso.

## Endpoints

- `GET /manifest.json`: manifiesto de Stremio.
- `GET /catalog/movie/movies.json`, `/catalog/series/series.json` y `/catalog/series/anime.json`: catálogos de ejemplo.
- `GET /meta/movie/tt0137523.json`: metadatos básicos. Las series del catálogo enumeran los episodios con fuentes configuradas; esto no garantiza que sean reproducibles.
- `GET /stream/movie/tt0137523.json` o `/stream/series/tt0944947:1:2.json`: fuentes para el ID exacto.
- `GET /config`: información; no es un editor.

Una búsqueda válida sin fuentes o sin resultados devuelve HTTP 200 y `{ "streams": [] }`. Los IDs mal formados devuelven 400 y los tipos o rutas desconocidos, 404.

## Docker

```sh
docker build -t latino-addon .
docker run --rm -p 8080:8080 \
  -v "$PWD/mis-streams.json:/config/streams.json:ro" \
  -e STREAMS_FILE=/config/streams.json latino-addon
```

El archivo montado debe ser legible por el usuario `node`. Sin el montaje la imagen usa la configuración vacía.

## Verificación y límites

`npm run check` comprueba sintaxis y `npm test` cubre el contrato HTTP, extracción con HTML simulado, validación de configuración y bloqueo de direcciones privadas. Las pruebas no descargan videos ni demuestran reproducción real en Stremio. Para sitios concretos puede ser necesario desarrollar adaptadores y pruebas con sus páginas autorizadas; no se adivinan fuentes a partir del IMDb.
