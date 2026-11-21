// Redirectores de los players.
//
// Varios reproductores (Voe entre ellos) sirven una página diminuta que solo
// hace `location.href = <mirror>/<mismo path y query>` desde JavaScript: el
// media está en el mirror, pero sin ejecutar JS esa página no aporta nada.
//
// Aquí se LEE la redirección (destino declarado en el HTML) y se sigue UNA vez,
// pero solo si el destino pertenece a los alias ya declarados por el resolvedor
// de ese player. Nunca se autoriza un host nuevo descubierto en el HTML: la
// lista de mirrors es código, no contenido de la página.

// Extrae el destino de un redirector JS. Devuelve la URL absoluta o null.
function destinoDeRedirector(html, base) {
  const texto = String(html);
  // Solo se aceptan páginas que SON un redirector: título o texto de espera y
  // un salto (o el patrón de reescritura del host con la misma ruta).
  const pareceRedirector = /<title[^>]*>[^<]*(?:Redirecting|Redirigiendo|Redirect)[^<]*<\/title>/i.test(texto)
    || /location(?:\.href)?\s*=|location\.replace\(|location\.assign\(/.test(texto)
    || /currentUrl\.host|new URL\(window\.location\.href\)/.test(texto);
  if (!pareceRedirector) return null;

  // 1) Un salto literal con URL absoluta.
  const literal = /(?:location(?:\.href)?\s*=|location\.replace\(\s*|location\.assign\(\s*)["'](https?:\/\/[^"']+)["']/i.exec(texto);
  if (literal) {
    try { return new URL(literal[1]).href; } catch { return null; }
  }
  // 2) Un host destino declarado y la URL reescrita con la misma ruta/query.
  const host = /(?:currentUrl\.host\s*=|hostname\s*=)\s*["']([a-z0-9.-]+\.[a-z]{2,})["']/i.exec(texto)
    || /["'](?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|net|sx|to|la|vc|io|org|st|fun|pro))\/[^"'\s]*["']/i.exec(texto);
  if (!host) return null;
  try {
    const destino = new URL(base);
    destino.host = host[1];
    return destino.href;
  } catch { return null; }
}

// Devuelve el HTML del mirror si el destino es un alias declarado del player.
async function seguirRedirector({ fetcher, html, link, alias = [], cabeceras = {}, emitir = () => {} }) {
  const destino = destinoDeRedirector(html, link);
  if (!destino) return null;
  let host = '';
  try { host = new URL(destino).hostname; } catch { return null; }
  const permitido = alias.some(dominio => host === dominio || host.endsWith(`.${dominio}`));
  if (!permitido) {
    emitir({ stage: 'redirector-ignorado', host: new URL(link).hostname, hacia: host });
    return null;
  }
  emitir({ stage: 'redirector', host: new URL(link).hostname, hacia: host });
  try {
    return await fetcher.getText(destino, cabeceras);
  } catch {
    return null;
  }
}

module.exports = { destinoDeRedirector, seguirRedirector };
