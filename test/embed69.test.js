const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRequest,
  buildEmbedUrl,
  checkAvailability,
  discover
} = require('../engines/embed69');

test('builds a movie availability request and embed page URL', () => {
  assert.deepEqual(normalizeRequest({ type: 'movie', imdbId: 'tt0137523' }), {
    kind: 'movie', imdbId: 'tt0137523', queryName: 'imdb', queryValue: 'tt0137523'
  });
  assert.equal(buildEmbedUrl({ type: 'movie', imdbId: 'tt0137523' }),
    'https://embed69.org/f/tt0137523');
});

test('formats episode numbers with leading zeroes', () => {
  const request = normalizeRequest({
    type: 'episode', imdbId: 'tt0944947', season: 1, episode: 5
  });
  assert.equal(request.queryValue, 'tt0944947-1x05');
  assert.equal(buildEmbedUrl({
    type: 'episode', imdbId: 'tt0944947', season: 1, episode: 5
  }), 'https://embed69.org/f/tt0944947-1x05');
});

test('rejects malformed IMDb IDs and invalid episode numbers', () => {
  assert.throws(() => normalizeRequest({ type: 'movie', imdbId: '123' }), /IMDb ID/);
  assert.throws(() => normalizeRequest({
    type: 'episode', imdbId: 'tt0944947', season: 0, episode: 1
  }), /positive integers/);
  assert.throws(() => normalizeRequest({ type: 'unknown', imdbId: 'tt0944947' }), /Type must be/);
});

test('checks availability and returns a discovery result, not a playable stream', async () => {
  let requested;
  const fetchImpl = async (url, options) => {
    requested = { url: new URL(url), options };
    return { ok: true, json: async () => ({ exists: true }) };
  };
  const result = await checkAvailability({
    type: 'episode', imdbId: 'tt0944947', season: 2, episode: 3
  }, { fetchImpl });

  assert.equal(requested.url.searchParams.get('imdb_tv'), 'tt0944947-2x03');
  assert.equal(requested.options.method, 'GET');
  assert.deepEqual(result, {
    available: true,
    embedUrl: 'https://embed69.org/f/tt0944947-2x03',
    kind: 'episode'
  });

  const discovered = await discover({ type: 'movie', imdbId: 'tt0137523' }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ exists: true }) })
  });
  assert.equal(discovered.playable, false);
  assert.equal(discovered.pageUrl, 'https://embed69.org/f/tt0137523');
});

test('does not treat API errors as available content', async () => {
  await assert.rejects(
    checkAvailability({ type: 'movie', imdbId: 'tt0137523' }, {
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /HTTP 503/
  );
  await assert.rejects(
    checkAvailability({ type: 'movie', imdbId: 'tt0137523' }, {
      fetchImpl: async () => ({ ok: true, json: async () => ({}) })
    }),
    /unexpected response/
  );
});
