'use strict';

// Runs only against the isolated candidate. This harness is never shipped.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');

async function main() {
    let outboundAttempts = 0;
    const denyNetwork = () => {
        outboundAttempts += 1;
        throw new Error('Outbound network is blocked during release runtime verification.');
    };
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = denyNetwork;
    require('node:tls').connect = denyNetwork;
    const root = process.cwd();

    // First import real generated Prisma Client, adapter and all app dependencies.
    const app = require(path.join(root, 'app/app.js'));
    assert.equal(app.get('view engine'), 'ejs');
    assert.equal(app.get('views'), path.join(root, 'app/views'));
    await require(path.join(root, 'app/config/prisma.js')).$disconnect();
    require(path.join(root, 'app/config/session.js')).sessionStore.close();

    // Load a fresh app/server with only the Prisma boundary mocked. The real
    // production env validator, schema readiness and session store still execute.
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(path.join(root, 'app') + path.sep)) delete require.cache[key];
    }
    const migrationNames = fs.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => entry.name);
    let readinessQueries = 0;
    const prisma = {
        async $queryRaw(strings) {
            const sql = strings.join(' ');
            readinessQueries += 1;
            const readiness = require(path.join(root, 'app/config/schemaReadiness.js'));
            if (sql.includes('SELECT DATABASE()')) return [{ db: process.env.DATABASE_NAME }];
            if (sql.includes('FROM _prisma_migrations')) return migrationNames.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null }));
            if (sql.includes('information_schema.tables')) return readiness.CRITICAL_TABLES.map(table_name => ({ table_name }));
            if (sql.includes('information_schema.columns')) return readiness.CRITICAL_COLUMNS.map(c => ({ table_name: c.table, column_name: c.column }));
            throw new Error('Unexpected database operation in startup smoke test.');
        },
        async $disconnect() {}
    };
    const prismaPath = require.resolve(path.join(root, 'app/config/prisma.js'));
    require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };

    const originalListen = net.Server.prototype.listen;
    let server;
    const listening = new Promise(resolve => {
        net.Server.prototype.listen = function (...args) {
            server = this;
            this.once('listening', resolve);
            // Bind an ephemeral loopback port even though server.js defaults to 3000.
            args[0] = 0;
            return originalListen.apply(this, args);
        };
    });
    require(path.join(root, 'app/server.js'));
    await Promise.race([listening, new Promise((_, reject) => setTimeout(() => reject(new Error('Server startup timed out.')), 10000).unref())]);
    assert.equal(readinessQueries, 4);

    // Permit only this harness's HTTP checks to this exact ephemeral listener.
    const port = server.address().port;
    net.Socket.prototype.connect = function (...args) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (options?.host === '127.0.0.1' && Number(options.port) === port) return originalConnect.apply(this, args);
        return denyNetwork();
    };
    try {
        const assetDirectory = path.join(root, 'assets/css');
        const asset = fs.readdirSync(assetDirectory).find(name => name.endsWith('.css'));
        const response = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: `/css/${asset}` }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
            }).on('error', reject);
        });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, fs.readFileSync(path.join(assetDirectory, asset)));
        assert.equal(outboundAttempts, 0);
        console.log('Production server startup, real dependency imports, schema readiness with mocked Prisma, and static HTTP asset check passed; no outbound connection attempted.');
    } finally {
        require(path.join(root, 'app/config/session.js')).sessionStore.close();
        await new Promise(resolve => server.close(resolve));
        net.Server.prototype.listen = originalListen;
    }
}

main().catch(error => { console.error(error.message); process.exit(1); });
