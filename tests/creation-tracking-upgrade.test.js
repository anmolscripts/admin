'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../app/config/prisma');

test('tracking upgrade retains old timestamps, creator IDs and sessions while adding numeric keys', async () => {
    const config = require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const database = `spark_disp_tracking_${process.pid}_${Date.now()}`;
    const connection = await require('mariadb').createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, multipleStatements: true });
    try {
        await connection.query(`CREATE DATABASE \`${database}\``);
        await connection.query(`USE \`${database}\``);
        const directory = path.join(__dirname, '../prisma/migrations');
        const migrations = fs.readdirSync(directory).filter(name => fs.existsSync(path.join(directory, name, 'migration.sql'))).sort();
        for (const migration of migrations.filter(name => name < '20261021000400_creation_tracking')) await connection.query(fs.readFileSync(path.join(directory, migration, 'migration.sql'), 'utf8'));
        await connection.query("INSERT INTO users (name,email,password,createdAt,updatedAt) VALUES ('Legacy author','legacy@example.test','unused','2020-01-02 03:04:05','2020-01-02 03:04:05')");
        const author = Number((await connection.query('SELECT id FROM users WHERE email = ?', ['legacy@example.test']))[0].id);
        await connection.query("INSERT INTO items (businessId,name,createdById,createdAt,updatedAt) VALUES (1,'Legacy audit item',?,'2020-01-02 03:04:05','2020-01-02 03:04:05')", [author]);
        await connection.query("INSERT INTO sessions (id,sid,data,expiresAt,updatedAt) VALUES ('legacy-session','legacy-session','{\"retained\":true}',DATE_ADD(NOW(),INTERVAL 1 HOUR),NOW())");
        await connection.query(fs.readFileSync(path.join(directory, '20261021000400_creation_tracking/migration.sql'), 'utf8'));
        const item = (await connection.query("SELECT * FROM items WHERE name = 'Legacy audit item'"))[0];
        assert.equal(item.CREATED_BY, author);
        assert.equal(item.CREATED_AT.getTime(), item.createdAt.getTime());
        assert.equal(item.IP_ADDRESS, null);
        const session = (await connection.query("SELECT * FROM sessions WHERE sid = 'legacy-session'"))[0];
        assert.ok(Number.isSafeInteger(session.id) && session.id > 0);
        assert.equal(session.legacyId, 'legacy-session');
        assert.deepEqual(JSON.parse(session.data), { retained: true });
        await connection.query("INSERT INTO sessions (sid,data,expiresAt,updatedAt) VALUES ('new-session','{}',DATE_ADD(NOW(),INTERVAL 1 HOUR),NOW())");
        const next = (await connection.query("SELECT id FROM sessions WHERE sid = 'new-session'"))[0];
        assert.ok(next.id > session.id);
    } finally {
        await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await connection.end();
        await require('../app/config/prisma').$disconnect();
    }
});
