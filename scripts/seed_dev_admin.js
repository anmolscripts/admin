'use strict';

require('dotenv').config();
const { applyTestFixtures } = require('./test-fixtures');
const prisma = require('../app/config/prisma');

async function initDevData() {
  try {
    const [dbRes] = await prisma.$queryRawUnsafe('SELECT DATABASE() as db, USER() as user');
    console.log(`Connected target DB: "${dbRes.db}" via "${dbRes.user}"`);
    if (dbRes.db !== 'spark_admin_local_dev_disposable') {
      throw new Error(`Safety guard: Target is "${dbRes.db}", not "spark_admin_local_dev_disposable"!`);
    }
    await applyTestFixtures();
    console.log('Dev fixtures provisioned successfully on spark_admin_local_dev_disposable.');
  } finally {
    await prisma.$disconnect();
  }
}

initDevData().catch(err => {
  console.error('Failed to provision dev fixtures:', err);
  process.exit(1);
});
