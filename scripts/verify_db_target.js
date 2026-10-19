process.env.NODE_ENV = 'test';
require('dotenv').config({ path: '.env.test', override: true });
const prisma = require('../app/config/prisma');

async function checkDb() {
  try {
    const res = await prisma.$queryRawUnsafe('SELECT DATABASE() as db, USER() as user');
    const dbName = res[0].db;
    const user = res[0].user;
    console.log('Connected DB:', dbName);
    console.log('Connected User:', user);
    const protectedDbs = ['admin', 'spark_admin', 'spark_admin_test', 'spark_admin_prod', 'spark_admin_prod_test'];
    if (protectedDbs.includes(dbName)) {
      console.error('CRITICAL ERROR: Connected to protected database:', dbName);
      process.exit(1);
    }
    if (dbName !== 'spark_project_costing_disposable_test') {
      console.warn('WARNING: Database is not spark_project_costing_disposable_test, it is:', dbName);
    } else {
      console.log('Safety check PASSED: Target is approved disposable database.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

checkDb();
