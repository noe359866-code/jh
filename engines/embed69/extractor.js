// Compatibility entry point; transport and extraction logic are shared.
const media = require('../media');
module.exports = { ...media, createExtractor: options => media.createExtractor({ name: 'Embed69', ...options }) };
