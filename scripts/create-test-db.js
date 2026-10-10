// create-test-db.js – provision spark_admin_test database (no IF NOT EXISTS)
// Run with: node scripts/create-test-db.js

const mariadb = require('mariadb');
const dotenv = require('dotenv');
const path = require('path');

// Load test env variables
const envPath = path.resolve(process.cwd(), '.env.test');
dotenv.config({ path: envPath, override: true });

const { DATABASE_HOST = 'localhost', DATABASE_PORT = '3306', DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME } = process.env;

if (!DATABASE_USER || !DATABASE_PASSWORD) {
  console.error('❌ Missing DATABASE_USER or DATABASE_PASSWORD in environment.');
  process.exit(1);
}

async function createDatabase() {
  let pool;
  try {
    // Connect to a known existing DB (information_schema) to issue CREATE DATABASE
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
    console.log('✅ Connected to MySQL server.');
    const sql = `CREATE DATABASE \`${DATABASE_NAME}\``;
    await conn.query(sql);
    console.log('✅ Database created:', DATABASE_NAME);
    await conn.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to create database:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

createDatabase();
