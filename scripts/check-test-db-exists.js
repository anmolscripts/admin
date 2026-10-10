// check-test-db-exists.js – verify test DB existence without creating it
// Run with: node scripts/check-test-db-exists.js

const mariadb = require('mariadb');
const dotenv = require('dotenv');
const path = require('path');

// Load .env.test (if present) – ensures same credentials are used
const envPath = path.resolve(process.cwd(), '.env.test');
dotenv.config({ path: envPath, override: true });

const { DATABASE_HOST = 'localhost', DATABASE_PORT = '3306', DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME } = process.env;

if (!DATABASE_USER || !DATABASE_PASSWORD) {
  console.error('❌ Missing DATABASE_USER or DATABASE_PASSWORD in environment.');
  process.exit(1);
}

async function dbExists() {
  let pool;
  try {
    // Connect to a known existing database (information_schema) to avoid DB-not-found error
    pool = mariadb.createPool({
      host: DATABASE_HOST,
      port: Number(DATABASE_PORT),
      user: DATABASE_USER,
      password: DATABASE_PASSWORD,
      database: 'information_schema',
      connectionLimit: 5,
      connectTimeout: 5000,
    });
    const conn = await pool.getConnection();
    const rows = await conn.query(
      "SELECT SCHEMA_NAME FROM SCHEMATA WHERE SCHEMA_NAME = ?",
      [DATABASE_NAME]
    );
    const exists = rows.length > 0;
    console.log('✅ Query executed.');
    console.log('🔎 Test database', DATABASE_NAME, exists ? 'exists.' : 'does NOT exist.');
    await conn.end();
    process.exit(exists ? 0 : 1);
  } catch (err) {
    console.error('❌ Connection or query failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

dbExists();
