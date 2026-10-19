'use strict';
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs');
const env = dotenv.parse(fs.readFileSync('.env'));

async function main() {
  const conn = await mysql.createConnection({
    host: env.DATABASE_HOST || 'localhost',
    port: Number(env.DATABASE_PORT || 3306),
    user: env.DATABASE_USER || 'root',
    password: env.DATABASE_PASSWORD
  });

  const [users] = await conn.query('SELECT id, role, email, active FROM `admin`.`users`');
  console.log('Total user accounts in admin:', users.length);
  users.forEach(u => {
    // Redact local part of email except first/last char
    const parts = u.email.split('@');
    const local = parts[0];
    const redacted = local.length <= 2 ? local : `${local[0]}***${local[local.length-1]}`;
    console.log(`User ID: ${u.id} | Role: ${u.role} | Active: ${u.is_active} | Email: ${redacted}@${parts[1]}`);
  });

  await conn.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
