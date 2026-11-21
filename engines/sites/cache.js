// Bounded, short-lived cache: signed media URLs must not be stored indefinitely.
// keyFn lets callers (e.g. URL-keyed site resolvers) provide their own cache key;
// it defaults to the IMDb request shape.
function createResolverCache(resolve, { ttlMs = 30000, negativeTtlMs = 5000,
  maxEntries = 100, maxConcurrent = 2, now = Date.now, keyFn } = {}) {
  const defaultKey = request => JSON.stringify([request.type, request.imdbId, request.season, request.episode]);
  const keyOf = typeof keyFn === 'function' ? keyFn : defaultKey;
  const cached = new Map();
  const pending = new Map();
  return async function run(request) {
    const key = keyOf(request);
    const hit = cached.get(key);
    if (hit && hit.expires > now()) return structuredClone(hit.value);
    cached.delete(key);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    if (pending.size >= maxConcurrent) {
      const error = new Error('Extractor busy');
      error.code = 'EXTRACTOR_BUSY';
      throw error;
    }
    const promise = Promise.resolve().then(() => resolve(request));
    pending.set(key, promise);
    try {
      const value = await promise;
      if (cached.size >= maxEntries) cached.delete(cached.keys().next().value);
      cached.set(key, { value: structuredClone(value), expires: now() + (value.length ? ttlMs : negativeTtlMs) });
      return structuredClone(value);
    } finally { pending.delete(key); }
  };
}
module.exports = { createResolverCache };
