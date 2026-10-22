'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assets = path.resolve(__dirname, '../../assets');
// Embed the same local fonts in standalone print/PDF documents for offline rendering.
const embeddedCss = fs.readFileSync(path.join(assets, 'css/fonts.css'), 'utf8').replace(/url\('([^']+)'\)/g,
    (_, url) => `url('data:font/ttf;base64,${fs.readFileSync(path.join(assets, url)).toString('base64')}')`);
module.exports = { embeddedCss, regularFont: path.join(assets, 'fonts/montserrat/Montserrat-Regular.ttf') };
