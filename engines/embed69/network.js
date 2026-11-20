const dns = require('node:dns');
const { isIP, BlockList } = require('node:net');
const { Agent, fetch } = require('undici');
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, prefix, 'ipv4');
function publicAddress(address) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}
// The address checked here is the address passed to the socket: no second DNS
// lookup between validation and connection. TLS still validates the hostname.
function createPublicLookup(lookup = dns.lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { family: 4, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        return callback(new Error('Non-public destination blocked'));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, 4);
    });
  };
}
const dispatcher = new Agent({ connect: { lookup: createPublicLookup(), timeout: 10000 },
  connections: 4, pipelining: 1, headersTimeout: 10000, bodyTimeout: 10000 });
function publicFetch(url, options) {
  // Literal IPs bypass DNS in net.connect; validate those separately.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new Error('Non-public destination blocked');
  return fetch(url, { ...options, dispatcher, redirect: 'error' });
}
module.exports = { publicAddress, createPublicLookup, publicFetch };
