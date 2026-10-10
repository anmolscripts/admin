// check-db-connection.js – safe MySQL connectivity test
// Run with: node scripts/check-db-connection.js

const mariadb = require('mariadb');
const dotenv = require('dotenv');
const path = require('path');

// Load .env.test (if present) – same as test runner
const envPath = path.resolve(process.cwd(), '.env.test');
dotenv.config({ path: envPath, override: true });

const { DATABASE_HOST = 'localhost', DATABASE_PORT = '3306', DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME } = process.env;

if (!DATABASE_USER || !DATABASE_PASSWORD) {
  console.error('❌ Missing DATABASE_USER or DATABASE_PASSWORD in environment.');
  process.exit(1);
}

async function testConnection() {
  let pool;
  try {
    pool = mariadb.createPool({
      host: DATABASE_HOST,
      port: Number(DATABASE_PORT),
      user: DATABASE_USER,
      password: DATABASE_PASSWORD,
      database: DATABASE_NAME,
      connectionLimit: 5,
      // Short timeout for quick feedback
      connectTimeout: 5000,
    });
    const conn = await pool.getConnection();
    const rows = await conn.query('SELECT DATABASE() AS db');
    const dbName = rows[0]?.db || rows[0]?.DATABASE;
    console.log('✅ Connected successfully. Current database:', dbName);
    await conn.end();
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

testConnection();
