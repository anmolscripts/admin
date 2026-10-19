'use strict';

const mariadb = require('mariadb');
const dotenv = require('dotenv');
dotenv.config();

const PROTECTED_DBS = [
  'admin',
  'spark_admin',
  'spark_admin_test',
  'spark_admin_prod',
  'spark_admin_prod_test'
];

async function createDevDb() {
  const targetDb = 'spark_admin_local_dev_disposable';
  if (PROTECTED_DBS.includes(targetDb.toLowerCase())) {
    throw new Error(`CRITICAL: "${targetDb}" is a protected database!`);
  }

  const host = process.env.DATABASE_HOST || '127.0.0.1';
  const conn = await mariadb.createConnection({
    host: host === 'localhost' ? '127.0.0.1' : host,
    port: parseInt(process.env.DATABASE_PORT || '3306', 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD
  });

  try {
    const [userRes] = await conn.query('SELECT USER(), CURRENT_USER()');
    console.log('Connected MySQL User:', userRes);

    console.log(`Creating database ${targetDb} if not exists...`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${targetDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    const dbs = await conn.query(`SHOW DATABASES LIKE '${targetDb}'`);
    if (dbs.length === 0) {
      throw new Error(`Failed to create database ${targetDb}`);
    }
    console.log(`Database "${targetDb}" verified created successfully.`);
  } finally {
    await conn.end();
  }
}

createDevDb().catch(err => {
  console.error('Database setup failed:', err.message);
  process.exit(1);
});
