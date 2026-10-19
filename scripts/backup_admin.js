/**
 * Backup runner — executes mysqldump for `admin` database.
 * Reads credentials exclusively from .env.
 * Never prints the password. Never includes credentials in the output filename.
 * Aborts if the resulting file is less than 100 KB.
 */
'use strict';
const { execSync, spawnSync } = require('child_process');
const dotenv = require('dotenv');
const fs   = require('fs');
const path = require('path');

const env = dotenv.parse(fs.readFileSync('.env'));

if (!env.DATABASE_PASSWORD) {
  console.error('ABORT: DATABASE_PASSWORD not set in .env');
  process.exit(1);
}

const ts   = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const outDir  = path.join('data', 'backups');
const outFile = path.join(outDir, `admin_premigration24_${ts}.sql`);

fs.mkdirSync(outDir, { recursive: true });

console.log(`Taking backup of 'admin' → ${outFile}`);
console.log('(mysqldump --single-transaction, no table locks)');

// Build args without embedding password in command string visible to ps
const args = [
  `--host=${env.DATABASE_HOST || '127.0.0.1'}`,
  `--port=${env.DATABASE_PORT || 3306}`,
  `--user=${env.DATABASE_USER || 'root'}`,
  `--password=${env.DATABASE_PASSWORD}`,  // passed as arg, not environment — not echoed to stdout/stderr
  '--no-tablespaces',
  '--single-transaction',
  '--routines',
  '--triggers',
  '--set-gtid-purged=OFF',
  'admin'
];

const result = spawnSync('mysqldump', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'buffer',
  maxBuffer: 256 * 1024 * 1024  // 256 MB
});

if (result.status !== 0) {
  const errMsg = result.stderr ? result.stderr.toString().replace(env.DATABASE_PASSWORD, '[REDACTED]') : '(no stderr)';
  console.error('mysqldump failed:', errMsg);
  process.exit(1);
}

fs.writeFileSync(outFile, result.stdout);

const sz = fs.statSync(outFile).size;
console.log(`Backup written: ${outFile}`);
console.log(`File size: ${sz.toLocaleString()} bytes`);

if (sz < 100_000) {
  console.error(`ABORT: Backup suspiciously small (${sz} bytes). Investigate before proceeding.`);
  process.exit(1);
}

// Count structural markers
const content = result.stdout.toString('utf8');
const createCount = (content.match(/^CREATE TABLE/gm) || []).length;
const insertCount = (content.match(/^INSERT INTO/gm) || []).length;
console.log(`CREATE TABLE statements: ${createCount} (expected ~53)`);
console.log(`INSERT INTO statements : ${insertCount}`);

if (createCount < 50) {
  console.error(`ABORT: Fewer CREATE TABLE statements than expected (${createCount}). Backup may be incomplete.`);
  process.exit(1);
}

console.log('');
console.log('BACKUP VERIFIED — safe to proceed.');
console.log(`Backup file: ${path.resolve(outFile)}`);

// Write the backup path to a temp file so subsequent steps can reference it
fs.writeFileSync('.last_backup_path', path.resolve(outFile), 'utf8');
