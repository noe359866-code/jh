const dns = require('node:dns');
const { isIP, BlockList } = require('node:net');
const { Agent, fetch } = require('undici');
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, prefix, 'ipv4');
function publicAddress(address) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}
// undici (connect.lookup) y el validador esperan un callback estilo
// dns.lookup(host, options, cb); dns.promises.lookup devuelve una promesa y si
// se pasa tal cual la conexión queda colgada y la validación no se ejecuta.
// Este adaptador acepta ambos estilos.
function normalizarLookup(lookupImpl) {
  if (typeof lookupImpl !== 'function') return dns.lookup;
  if (lookupImpl.length >= 3) return lookupImpl;
  return (hostname, options, callback) => {
    Promise.resolve().then(() => lookupImpl(hostname, options)).then((addresses) => {
      const lista = Array.isArray(addresses) ? addresses
        : addresses && addresses.address ? [addresses] : null;
      if (!lista || !lista.length) return callback(new Error('Sin direcciones para el host'));
      if (options && options.all) return callback(null, lista);
      callback(null, lista[0].address, lista[0].family || 4);
    }, error => callback(error));
  };
}

// Devuelve las direcciones para la comprobación explícita previa, sea el
// lookup de callback o de promesa.
async function resolveAddresses(lookupImpl, hostname) {
  const lookup = normalizarLookup(lookupImpl);
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
      if (error) return reject(error);
      resolve(Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }]);
    });
  });
}

// The address checked here is the address passed to the socket: no second DNS
// lookup between validation and connection. TLS still validates the hostname.
function createPublicLookup(lookup = dns.lookup) {
  const base = normalizarLookup(lookup);
  return (hostname, options, callback) => {
    base(hostname, { family: 4, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        return callback(new Error('Non-public destination blocked'));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, 4);
    });
  };
}
function createAgent(lookup = dns.lookup, timeout = 10000) {
  return new Agent({ connect: { lookup: createPublicLookup(lookup), timeout },
    connections: 4, pipelining: 1, headersTimeout: timeout, bodyTimeout: timeout });
}
const dispatcher = createAgent();
// Literal IPs bypass DNS in net.connect; validate those separately.
function assertPublicUrl(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new Error('Non-public destination blocked');
}
function publicFetch(url, options) {
  assertPublicUrl(url);
  return fetch(url, { ...options, dispatcher, redirect: 'error' });
}
// Variante con lookup inyectable: permite probar la validación del dispatcher
// sin resolver DNS real. En producción se usa publicFetch (lookup del sistema).
function createPublicFetch({ lookupImpl = dns.lookup, timeoutMs = 10000 } = {}) {
  const agent = createAgent(lookupImpl, timeoutMs);
  return (url, options) => {
    assertPublicUrl(url);
    return fetch(url, { ...options, dispatcher: agent, redirect: 'error' });
  };
}
module.exports = { publicAddress, createPublicLookup, createAgent, publicFetch, createPublicFetch, normalizarLookup, resolveAddresses };
