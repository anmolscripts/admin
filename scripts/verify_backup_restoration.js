'use strict';
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const env = dotenv.parse(fs.readFileSync('.env'));
const BACKUP_PATH = 'data/backups/admin_premigration24_2026-10-18_16-41-54.sql';
const DISPOSABLE_DB = 'spark_admin_backup_test_restore_disposable';

async function main() {
  console.log('=== VERIFY PRE-MIGRATION SQL BACKUP INTEGRITY & RESTORATION ===');
  
  if (!fs.existsSync(BACKUP_PATH)) {
    throw new Error(`Backup file not found at ${BACKUP_PATH}`);
  }
  const fileBuf = fs.readFileSync(BACKUP_PATH);
  const initialHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
  console.log(`Backup file: ${BACKUP_PATH}`);
  console.log(`File size: ${fileBuf.length} bytes`);
  console.log(`SHA-256 before restoration test: ${initialHash}`);

  // Connect to MySQL server root
  const conn = await mysql.createConnection({
    host: env.DATABASE_HOST || 'localhost',
    port: Number(env.DATABASE_PORT || 3306),
    user: env.DATABASE_USER || 'root',
    password: env.DATABASE_PASSWORD,
    multipleStatements: true
  });

  // Verify DISPOSABLE_DB is safe to use
  const [existing] = await conn.query('SHOW DATABASES LIKE ?', [DISPOSABLE_DB]);
  if (existing.length > 0) {
    console.log(`Dropping pre-existing test DB: ${DISPOSABLE_DB}`);
    await conn.query(`DROP DATABASE \`${DISPOSABLE_DB}\``);
  }

  console.log(`Creating fresh disposable test database: ${DISPOSABLE_DB}`);
  await conn.query(`CREATE DATABASE \`${DISPOSABLE_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  // Execute restore into DISPOSABLE_DB
  console.log(`Restoring ${BACKUP_PATH} into ${DISPOSABLE_DB}...`);
  // Use mysql command line if available or query in chunks
  // Let's use mysql command line
  const passArg = env.DATABASE_PASSWORD ? `-p"${env.DATABASE_PASSWORD}"` : '';
  const portArg = env.DATABASE_PORT ? `-P${env.DATABASE_PORT}` : '-P3306';
  const hostArg = env.DATABASE_HOST ? `-h${env.DATABASE_HOST}` : '-hlocalhost';
  const userArg = env.DATABASE_USER ? `-u${env.DATABASE_USER}` : '-uroot';
  
  const restoreCmd = `mysql ${hostArg} ${portArg} ${userArg} ${passArg} ${DISPOSABLE_DB} < "${BACKUP_PATH}"`;
  execSync(restoreCmd, { stdio: 'pipe', shell: 'cmd.exe' });
  console.log('SQL restore completed successfully.');

  // Verify restored database contents
  const [tables] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [DISPOSABLE_DB]
  );
  console.log(`Restored database table count: ${tables.length} (expected: 53 pre-migration tables)`);

  const [migs] = await conn.query(
    `SELECT migration_name FROM \`${DISPOSABLE_DB}\`._prisma_migrations ORDER BY finished_at ASC`
  );
  console.log(`Restored database migrations: ${migs.length} (expected: 23 pre-migration migrations)`);

  const expectedCounts = {
    businesses: 6,
    users: 9,
    clients: 13,
    invoices: 19,
    invoice_items: 26,
    payments: 3,
    expenses: 2,
    financial_years: 7,
    chart_of_accounts: 264,
    journal_entries: 22,
    journal_entry_lines: 66,
    user_activity_logs: 177,
    projects: 4,
    project_attachments: 1
  };

  let countsMatch = true;
  for (const [tbl, expCount] of Object.entries(expectedCounts)) {
    const [[cnt]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DISPOSABLE_DB}\`.\`${tbl}\``);
    const ok = cnt.c === expCount;
    if (!ok) countsMatch = false;
    console.log(`  ${ok ? '✓' : '✗'} ${tbl}: ${cnt.c} rows (expected: ${expCount})`);
  }

  // Clean up disposable restore database
  console.log(`Cleaning up test disposable database: ${DISPOSABLE_DB}...`);
  await conn.query(`DROP DATABASE \`${DISPOSABLE_DB}\``);
  console.log(`Dropped ${DISPOSABLE_DB}.`);

  await conn.end();

  // Verify original backup file was untouched
  const finalBuf = fs.readFileSync(BACKUP_PATH);
  const finalHash = crypto.createHash('sha256').update(finalBuf).digest('hex');
  const identical = initialHash === finalHash && finalBuf.length === fileBuf.length;
  console.log(`Backup file integrity check: ${identical ? 'PASS (Byte-identical)' : 'FAIL'}`);

  if (tables.length === 53 && migs.length === 23 && countsMatch && identical) {
    console.log('\n>>> BACKUP VERIFICATION AND RESTORATION TEST: ALL PASSED <<<\n');
  } else {
    throw new Error('Backup verification or restoration test failed!');
  }
}

main().catch(err => {
  console.error('Error during backup verification:', err.message);
  process.exit(1);
});
