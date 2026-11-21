// Desempaquetador de Dean Edwards P.A.C.K.E.R. (`eval(function(p,a,c,k,e,d)`).
// Streamwish, Vidhide, Filemoon y Uqload esconden la URL del media dentro de
// ese bloque: sin descomprimirlo, el barrido literal del HTML no ve nada.
// Es una transformación de texto pura: no se ejecuta código del sitio.

// Reconstruye el diccionario: base `a` con el alfabeto 0-9a-z (más 36+ para
// palabras largas), igual que la función `e` del cargador original.
function codificar(indice, base) {
  const digitos = [];
  let numero = indice;
  do {
    const resto = numero % base;
    digitos.unshift(resto > 35 ? String.fromCharCode(resto + 29) : resto.toString(36));
    numero = Math.floor(numero / base);
  } while (numero > 0);
  return digitos.join('');
}

function escaparRegExp(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Sustituye por índice de mayor a menor, con el mismo `\b<idx>\b` del cargador.
// Un índice que en base `a` acaba en carácter de palabra y va seguido de otros
// caracteres de palabra (p. ej. '0' de ':0' cuando el texto trae '1://')
// quedaría sin sustituir con \b; por eso, si la pasada normal no toca el texto,
// se reintenta sin \b (prefijo de token), que es lo que hace el navegador al
// ejecutar el bloque.
function sustituir(salida, indice, palabra, base) {
  const token = codificar(indice, base);
  const normal = salida.replace(new RegExp(`\\b${escaparRegExp(token)}\\b`, 'g'), palabra);
  if (normal !== salida) return normal;
  // Sin cambios: se prueba como prefijo (evita romper índices consecutivos).
  return salida.replace(new RegExp(`(^|[^0-9a-z])${escaparRegExp(token)}(?![0-9a-z])`, 'g'), `$1${palabra}`);
}

// Devuelve el código desempaquetado o null si no había bloque PACK.E.R.
function unPacker(entrada) {
  const codigo = String(entrada);
  const patron = /eval\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*(?:,\s*[dr]\s*)?\)\s*\{[\s\S]*?\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.\s*split\(\s*'\|'\s*\)/;
  const encontrado = patron.exec(codigo);
  if (!encontrado) return null;

  const desescapar = (texto) => texto
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');

  const cuerpo = desescapar(encontrado[1]);
  const base = Number(encontrado[2]);
  const total = Number(encontrado[3]);
  const diccionario = desescapar(encontrado[4]).split('|');
  if (!base || !total) return null;

  let salida = cuerpo;
  // Se sustituye de mayor a menor índice: así una palabra no queda partida por
  // otra más corta que aparezca dentro de ella.
  for (let i = total - 1; i >= 0; i--) {
    const palabra = diccionario[i];
    if (!palabra) continue;
    salida = sustituir(salida, i, palabra, base);
  }
  return salida;
}

// Aplica el desempaquetado a todos los bloques del HTML (puede haber varios).
function unPackerTodo(html) {
  const textos = [String(html)];
  let actual = String(html);
  for (let intento = 0; intento < 5; intento++) {
    const siguiente = unPacker(actual);
    if (!siguiente || siguiente === actual) break;
    textos.push(siguiente);
    actual = siguiente;
  }
  return textos;
}

module.exports = { unPacker, unPackerTodo, codificar };
