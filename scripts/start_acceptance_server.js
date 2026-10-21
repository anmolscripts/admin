'use strict';
require('dotenv').config();
const http = require('http');
const app = require('../app/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
    console.log(`Acceptance server listening at http://${HOST}:${PORT}`);
});
