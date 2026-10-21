'use strict';

const fs = require('node:fs');
const { parseEnvFile } = require('./lib/env-file');
const { resolveTestDatabaseConfig } = require('./lib/test-database-config');
const { validatePlan, inspectBusiness } = require('../app/services/inventoryCutoverPreflight.service');

async function main(args) {
    if (args.length === 1 && args[0] === '--help') {
        console.log('Read-only: node scripts/inventory-cutover-preflight.js --env PATH --business ID|all [--plan PATH]');
        console.log('No activation, approval, migration or database writes. Use a SELECT-only database account.');
        return;
    }
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--env', '--business', '--plan'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid arguments. Use --help.');
        options[args[i]] = args[i + 1];
    }
    if (!options['--env'] || !options['--business'] || !fs.existsSync(options['--env'])) throw new Error('An existing explicit --env and --business ID|all are required.');
    const businessId = options['--business'] === 'all' ? null : Number(options['--business']);
    if (businessId !== null && (!/^\d+$/.test(options['--business']) || !Number.isSafeInteger(businessId) || businessId <= 0)) throw new Error('Invalid business ID.');
    const plan = validatePlan(options['--plan'] ? JSON.parse(fs.readFileSync(options['--plan'], 'utf8')) : { version: 1, businesses: [] });
    // This foundation intentionally refuses protected databases even for inspection.
    const config = resolveTestDatabaseConfig(parseEnvFile(options['--env']));
    const { PrismaClient } = require('@prisma/client');
    const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
    const db = new PrismaClient({ adapter: new PrismaMariaDb({ ...config, port: Number(config.port), connectionLimit: 2 }), transactionOptions: { timeout: 60000 } });
    try {
        const connected = await db.$queryRawUnsafe('SELECT DATABASE() AS name');
        if (connected[0]?.name !== config.database) throw new Error('Connected database does not match explicit configuration.');
        const businesses = businessId ? [{ id: businessId }] : await db.business.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
        const reports = [];
        for (const business of businesses) reports.push(await inspectBusiness(db, business.id, plan));
        const unassignedMovementCount = businessId ? null : await db.stockMovement.count({ where: { businessId: null } });
        console.log(JSON.stringify({ database: config.database, unassignedMovementCount, reports }, null, 2));
        if (!reports.length || reports.some(r => !r.activationAllowed)) process.exitCode = 2;
    } finally { await db.$disconnect(); }
}

if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('Preflight failed. Check arguments, plan, database permissions and schema; no cutover was applied.'); process.exitCode = 1; });
module.exports = { main };
