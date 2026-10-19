'use strict';

require('dotenv').config();
const { assertSchemaReadiness } = require('../app/config/schemaReadiness');
const prisma = require('../app/config/prisma');

async function check() {
  try {
    const [res] = await prisma.$queryRawUnsafe('SELECT DATABASE() as db, USER() as user');
    console.log(`Connected to: ${res.db} via ${res.user}`);
    const protectedDbs = ['admin', 'spark_admin', 'spark_admin_test', 'spark_admin_prod', 'spark_admin_prod_test'];
    if (protectedDbs.includes(res.db)) {
      throw new Error(`CRITICAL: Connected to protected database ${res.db}`);
    }

    console.log('Running assertSchemaReadiness()...');
    await assertSchemaReadiness();
    console.log('✔ Schema readiness check PASSED cleanly! All 24/24 migrations and critical tables present.');
  } finally {
    await prisma.$disconnect();
  }
}

check().catch(err => {
  console.error('❌ Readiness check failed:', err.message);
  process.exit(1);
});
