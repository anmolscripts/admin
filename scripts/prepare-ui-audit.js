'use strict';
// A retained, independent database and checkout for destructive integration tests.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
async function main() {
    const base = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
    const url = new URL(base.DATABASE_URL);
    const database = 'ui_audit_' + Date.now();
    const workspace = path.join(root, 'evidence', database);
    fs.mkdirSync(workspace, { recursive: true });
    const connection = await require('mariadb').createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
    try { await connection.query('CREATE DATABASE ' + connection.escapeId(database) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); }
    finally { await connection.end(); }
    for (const relative of ['app', 'assets', 'scripts', 'tests', 'prisma', 'package.json', 'package-lock.json', 'prisma7.config.ts']) {
        fs.cpSync(path.join(root, relative), path.join(workspace, relative), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'junction');
    url.pathname = '/' + database;
    const values = { ...base, DATABASE_URL: url.toString(), DATABASE_NAME: database, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3011',
        SEED_ADMIN_EMAIL: 'admin@email.com', SEED_ADMIN_PASSWORD: 'Audit-Local-Only-2026!', SESSION_SECRET: require('crypto').randomBytes(48).toString('hex') };
    const text = Object.entries(values).map(([k,v]) => k + '=' + JSON.stringify(String(v))).join('\n');
    fs.writeFileSync(path.join(workspace, '.env'), text, { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, '.env.test'), text.replace('NODE_ENV="development"', 'NODE_ENV="test"'), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'data/ui-audit-workspace.txt'), workspace);
    const env = { ...process.env, ...values };
    const migrate = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), '--config', path.join(workspace, 'prisma7.config.ts'), 'migrate', 'deploy'], { cwd: workspace, env, encoding: 'utf8' });
    if (migrate.status !== 0) throw new Error(migrate.stderr);
    const seed = spawnSync(process.execPath, ['-e', 'require("dotenv").config({quiet:true});require("./scripts/test-fixtures").applyTestFixtures({adminEmail:"admin@email.com",adminPassword:process.env.SEED_ADMIN_PASSWORD}).then(()=>require("./app/config/prisma").$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1})'], { cwd: workspace, env, encoding: 'utf8' });
    if (seed.status !== 0) throw new Error(seed.stderr);
    console.log('Isolated audit ready: ' + workspace + '\nDatabase: ' + database + '; no production records copied or changed.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
