const test = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { createPublicLookup, publicFetch } = require('../engines/embed69/network');
test('socket lookup returns only validated public IPv4 addresses', async () => {
  const lookup = promisify(createPublicLookup((host, options, cb) => {
    assert.equal(options.family, 4);
    cb(null, [{ address: '93.184.216.34', family: 4 }]);
  }));
  assert.deepEqual(await lookup('example.org', { all: true }), [{ address: '93.184.216.34', family: 4 }]);
});
test('socket lookup blocks private answers and mixed DNS responses', async () => {
  const lookup = promisify(createPublicLookup((host, options, cb) => cb(null, [
    { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }
  ])));
  await assert.rejects(lookup('example.org', {}), /Non-public/);
  assert.throws(() => publicFetch('https://127.0.0.1/'), /Non-public/);
  assert.throws(() => publicFetch('https://[::1]/'), /Non-public/);
});
