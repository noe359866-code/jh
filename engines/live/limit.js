// Concurrencia limitada: ejecuta tareas con un máximo de promesas en vuelo.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    const { task, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return function limit(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  };
}

/** `Promise.all` con tope de concurrencia, conservando el orden de entrada. */
async function mapLimit(items, concurrency, task) {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, index) => limit(() => task(item, index))));
}

module.exports = { createLimiter, mapLimit };
