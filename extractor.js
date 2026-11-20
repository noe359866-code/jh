'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');
const cheerio = require('cheerio');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_PAGES = 5;
const MAX_DEPTH = 2;
const MAX_RESULTS = 50;

function parseHttpUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function isPublicAddress(address) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    if (ip.kind() === 'ipv6') {
      // Exclude NAT64 and transition ranges that may tunnel to private IPv4.
      if (!ip.match(ipaddr.parse('2000::'), 3) || ip.match(ipaddr.parse('2002::'), 16)
        || ip.match(ipaddr.parse('2001::'), 32)) return false;
    }
    return ip.range() === 'unicast';
  } catch { return false; }
}

// Pin the DNS result used by the socket, rather than resolving again after validation.
async function publicAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new Error('Non-public address');
    const ip = ipaddr.parse(host);
    return { address: host, family: ip.kind() === 'ipv4' ? 4 : 6 };
  }
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) throw new Error('Non-public hostname');
  let timer;
  const results = await Promise.race([
    dns.lookup(host, { all: true, verbatim: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), TIMEOUT_MS); })
  ]).finally(() => clearTimeout(timer));
  // Reject mixed public/private answers too, rather than risking internal access.
  if (!results.length || results.some(result => !isPublicAddress(result.address))) throw new Error('Non-public DNS answer');
  return results[0];
}

async function fetchPage(input, headers = {}, signal, redirects = 0) {
  const url = parseHttpUrl(input);
  if (!url) throw new Error('Invalid page URL');
  if (signal?.aborted) throw new Error('Extraction timeout');
  const address = await publicAddress(url.hostname);
  if (signal?.aborted) throw new Error('Extraction timeout');
  const response = await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      signal,
      headers: { Accept: 'text/html,application/xhtml+xml', ...headers },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family)
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Page returned HTTP ${res.statusCode}`));
      }
      if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(res.headers['content-type'] || '')) {
        res.resume();
        return reject(new Error('Page is not HTML'));
      }
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) res.destroy(new Error('Page too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Page response aborted')));
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: url.href }));
    });
    const timer = setTimeout(() => request.destroy(new Error('Page timeout')), TIMEOUT_MS);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
  if (response.redirect) {
    if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects');
    const target = parseHttpUrl(response.redirect, url);
    if (!target) throw new Error('Invalid redirect');
    return fetchPage(target.href, headers, signal, redirects + 1);
  }
  return response;
}

function mediaUrl(value, base, declaredType) {
  const url = parseHttpUrl(value && value.trim(), base);
  if (!url) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (ipaddr.isValid(host) && !isPublicAddress(host))) return null;
  if (!/\.(m3u8|mp4)$/i.test(url.pathname) && !/^(video\/mp4|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)$/i.test(declaredType || '')) return null;
  return url.href;
}

function parsePage(html, base) {
  const $ = cheerio.load(html);
  const media = new Set();
  const frames = new Set();
  const add = (value, type) => {
    const url = mediaUrl(value, base, type);
    if (url && media.size < MAX_RESULTS) media.add(url);
  };
  $('video[src], source[src]').each((_, el) => add($(el).attr('src'), $(el).attr('type')));
  $('iframe[src]').each((_, el) => {
    const url = parseHttpUrl($(el).attr('src'), base);
    if (url && frames.size < MAX_PAGES) frames.add(url.href);
  });
  // Covers common inline player configuration (file/src/url), including escaped JSON URLs.
  $('script:not([src])').each((_, el) => {
    const text = $(el).html().replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\x26/gi, '&').replace(/&amp;/gi, '&');
    const re = /["']([^"'\s<>]*\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?)["']/gi;
    for (const match of text.matchAll(re)) add(match[1]);
  });
  return { media: [...media], frames: [...frames] };
}

async function extractPage(source, fetcher = fetchPage) {
  const pending = [{ url: source.url, depth: 0 }];
  const visited = new Set();
  const result = new Set();
  const signal = AbortSignal.timeout(12000);
  while (!signal.aborted && pending.length && visited.size < MAX_PAGES && result.size < MAX_RESULTS) {
    const current = pending.shift();
    if (visited.has(current.url)) continue;
    visited.add(current.url);
    try {
      const page = await fetcher(current.url, source.headers || {}, signal);
      const { media, frames } = parsePage(page.html, page.url);
      for (const url of media) { if (result.size < MAX_RESULTS) result.add(url); }
      if (current.depth < MAX_DEPTH) {
        for (const url of frames) if (!visited.has(url)) pending.push({ url, depth: current.depth + 1 });
      }
    } catch {
      // A broken or inaccessible page must not prevent other sources from resolving.
    }
  }
  return [...result];
}

module.exports = { parseHttpUrl, isPublicAddress, fetchPage, parsePage, extractPage };
