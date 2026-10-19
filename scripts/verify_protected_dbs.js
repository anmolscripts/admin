const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs');
const env = dotenv.parse(fs.readFileSync('.env'));

async function checkProtected() {
  if (!env.DATABASE_PASSWORD) throw new Error('DATABASE_PASSWORD must be set in .env — no fallback allowed');
  const conn = await mysql.createConnection({
    host: env.DATABASE_HOST || 'localhost',
    port: Number(env.DATABASE_PORT || 3306),
    user: env.DATABASE_USER || 'root',
    password: env.DATABASE_PASSWORD   // sourced from .env only, never hardcoded
  });

  const protectedDbs = ['admin', 'spark_admin', 'spark_admin_test', 'spark_admin_prod', 'spark_admin_prod_test'];
  for (const db of protectedDbs) {
    const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [db]);
    if (dbs.length === 0) {
      console.log(`Database "${db}": Does not exist`);
      continue;
    }
    const [tables] = await conn.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ?', [db]);
    let migrationCount = 'N/A';
    try {
      const [migs] = await conn.query(`SELECT COUNT(*) as cnt FROM \`${db}\`._prisma_migrations`);
      migrationCount = migs[0].cnt;
    } catch (_) {}
    console.log(`Database "${db}": Exists | Table Count: ${tables.length} | Applied Migrations: ${migrationCount}`);
  }

  // Also check spark_admin_local_dev_disposable
  const [devTables] = await conn.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ?', ['spark_admin_local_dev_disposable']);
  const [devMigs] = await conn.query('SELECT COUNT(*) as cnt FROM `spark_admin_local_dev_disposable`._prisma_migrations');
  console.log(`Disposable Dev DB "spark_admin_local_dev_disposable": Table Count: ${devTables.length} | Applied Migrations: ${devMigs[0].cnt}`);

  await conn.end();
}

checkProtected().catch(console.error);
