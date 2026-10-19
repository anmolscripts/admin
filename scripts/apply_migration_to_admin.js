/**
 * Applies prisma migrate deploy targeting the `admin` database.
 * Sets DATABASE_URL in child process environment only — never touches .env.
 * Never prints credentials.
 * Aborts if the target database resolved from env is not `admin`.
 */
'use strict';
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const fs = require('fs');

const env = dotenv.parse(fs.readFileSync('.env'));

if (!env.DATABASE_PASSWORD) {
  console.error('ABORT: DATABASE_PASSWORD not set in .env');
  process.exit(1);
}

// Construct the admin DATABASE_URL for this single migration run
const host = env.DATABASE_HOST || '127.0.0.1';
const port = env.DATABASE_PORT || '3306';
const user = env.DATABASE_USER || 'root';
const pass = env.DATABASE_PASSWORD;
const adminUrl = `mysql://${user}:${pass}@${host}:${port}/admin`;

// Guard: confirm target is admin
const urlObj = new URL(adminUrl);
const targetDb = urlObj.pathname.replace(/^\//, '');
if (targetDb !== 'admin') {
  console.error(`ABORT: Computed target database is "${targetDb}", not "admin". Refusing to proceed.`);
  process.exit(1);
}
console.log(`Target database: ${targetDb} — confirmed.`);
console.log('Running: npx prisma migrate deploy');
console.log('');

const childEnv = Object.assign({}, process.env, {
  DATABASE_URL: adminUrl
});

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: 'inherit',
  shell: true
});

if (result.status !== 0) {
  console.error(`\nABORT: prisma migrate deploy exited with code ${result.status}`);
  process.exit(result.status || 1);
}

console.log('\nMigration command completed successfully.');
