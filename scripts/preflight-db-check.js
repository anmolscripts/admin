'use strict';

require('dotenv').config({ path: '.env.test', override: true });
process.env.NODE_ENV = 'test';

const { validateTestEnv } = require('./guard');
const prisma = require('../app/config/prisma');

async function main() {
    await validateTestEnv(prisma);
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS activeDb`;
    const activeDb = rows[0]?.activeDb;
    console.log(`[PRE-FLIGHT DATABASE VERIFICATION]: Connected to "${activeDb}"`);

    const protectedDbs = ['admin', 'spark_admin', 'spark_admin_prod', 'spark_admin_test', 'spark_admin_prod_test'];
    if (!activeDb || protectedDbs.includes(activeDb.toLowerCase())) {
        console.error(`[FATAL]: Active database "${activeDb}" is PROTECTED. Aborting immediately.`);
        process.exit(1);
    }

    if (activeDb !== 'spark_project_costing_disposable_test') {
        console.error(`[FATAL]: Active database is "${activeDb}", expected "spark_project_costing_disposable_test". Aborting.`);
        process.exit(1);
    }

    console.log('[PRE-FLIGHT OK]: Confirmed disposable non-protected test database.');
}

main()
    .catch(err => {
        console.error('[PRE-FLIGHT ERROR]', err.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
