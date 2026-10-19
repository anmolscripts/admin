/**
 * READ-ONLY database comparison audit.
 * This script NEVER writes, migrates, seeds, drops, or truncates anything.
 * Connects directly via mysql2 (not Prisma) so it cannot accidentally follow .env overrides.
 */
'use strict';

const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs');

const env = dotenv.parse(fs.readFileSync('.env'));

// Connect with env creds — password intentionally not printed
async function getConn() {
  return mysql.createConnection({
    host:     env.DATABASE_HOST     || 'localhost',
    port:     Number(env.DATABASE_PORT || 3306),
    user:     env.DATABASE_USER     || 'root',
    password: env.DATABASE_PASSWORD,   // not logged
    multipleStatements: false
  });
}

async function getTableRowCounts(conn, dbName) {
  // Use information_schema — read-only, no locks
  const [rows] = await conn.query(
    `SELECT t.TABLE_NAME,
            t.TABLE_ROWS AS approx_rows,
            t.TABLE_COMMENT
     FROM   information_schema.TABLES t
     WHERE  t.TABLE_SCHEMA = ?
     ORDER  BY t.TABLE_NAME`,
    [dbName]
  );
  return rows;
}

async function getMigrationHistory(conn, dbName) {
  try {
    const [rows] = await conn.query(
      `SELECT migration_name, finished_at, applied_steps_count
       FROM \`${dbName}\`._prisma_migrations
       ORDER BY finished_at ASC`
    );
    return rows;
  } catch (e) {
    return `[Could not read _prisma_migrations: ${e.code || e.message}]`;
  }
}

async function main() {
  const conn = await getConn();

  // Safety: verify we are NOT connected to a protected DB at session level
  const [[{ db: sessionDb }]] = await conn.query('SELECT DATABASE() AS db');
  console.log(`\nMySQL session default database: ${sessionDb || '(none — good, using cross-db queries)'}`);

  const ADMIN     = 'admin';
  const DEV_DB    = 'spark_admin_local_dev_disposable';

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' READ-ONLY DATABASE COMPARISON AUDIT');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Migration histories ─────────────────────────────────────────────
  const adminMigs = await getMigrationHistory(conn, ADMIN);
  const devMigs   = await getMigrationHistory(conn, DEV_DB);

  console.log(`── Migration history: ${ADMIN} ──`);
  if (Array.isArray(adminMigs)) {
    console.log(`   Applied: ${adminMigs.length}`);
    adminMigs.forEach(m => {
      const ts = m.finished_at ? new Date(m.finished_at).toISOString() : 'PENDING';
      console.log(`   [${ts}] ${m.migration_name}`);
    });
  } else {
    console.log(`   ${adminMigs}`);
  }

  console.log(`\n── Migration history: ${DEV_DB} ──`);
  if (Array.isArray(devMigs)) {
    console.log(`   Applied: ${devMigs.length}`);
    devMigs.forEach(m => {
      const ts = m.finished_at ? new Date(m.finished_at).toISOString() : 'PENDING';
      console.log(`   [${ts}] ${m.migration_name}`);
    });
  } else {
    console.log(`   ${devMigs}`);
  }

  // ── Table counts ────────────────────────────────────────────────────
  const adminTables = await getTableRowCounts(conn, ADMIN);
  const devTables   = await getTableRowCounts(conn, DEV_DB);

  console.log(`\n── Table inventory: ${ADMIN} (${adminTables.length} tables) ──`);
  const adminTableNames = new Set(adminTables.map(t => t.TABLE_NAME));
  for (const t of adminTables) {
    if (t.TABLE_NAME === '_prisma_migrations') continue;
    console.log(`   ${t.TABLE_NAME.padEnd(48)} approx_rows: ${t.approx_rows ?? 'N/A'}`);
  }

  console.log(`\n── Table inventory: ${DEV_DB} (${devTables.length} tables) ──`);
  const devTableNames = new Set(devTables.map(t => t.TABLE_NAME));
  for (const t of devTables) {
    if (t.TABLE_NAME === '_prisma_migrations') continue;
    console.log(`   ${t.TABLE_NAME.padEnd(48)} approx_rows: ${t.approx_rows ?? 'N/A'}`);
  }

  // ── Tables only in dev (new in migration 24) ───────────────────────
  const onlyInDev = [...devTableNames].filter(n => !adminTableNames.has(n) && n !== '_prisma_migrations');
  console.log(`\n── Tables present in DEV but NOT in admin (migration 24 additions): ──`);
  if (onlyInDev.length) {
    onlyInDev.forEach(n => console.log(`   + ${n}`));
  } else {
    console.log('   (none)');
  }

  // ── Tables only in admin (should be none if admin is a subset) ─────
  const onlyInAdmin = [...adminTableNames].filter(n => !devTableNames.has(n) && n !== '_prisma_migrations');
  console.log(`\n── Tables present in admin but NOT in DEV: ──`);
  if (onlyInAdmin.length) {
    onlyInAdmin.forEach(n => console.log(`   - ${n}`));
  } else {
    console.log('   (none)');
  }

  // ── Business data presence check (read-only, no PII printed) ───────
  // Key tables that indicate real production use
  const businesKeytables = [
    'organizations', 'users', 'customers', 'suppliers',
    'invoices', 'purchase_orders', 'expenses', 'payments',
    'financial_years', 'chart_of_accounts'
  ];

  console.log('\n── Business data presence check (row counts only, no PII) ──');
  console.log(`   ${'Table'.padEnd(35)} ${'admin'.padStart(10)} ${'dev_disposable'.padStart(16)}`);
  console.log(`   ${'-'.repeat(65)}`);

  for (const tbl of businesKeytables) {
    let adminCount = '—';
    let devCount   = '—';
    try {
      const [[ar]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${ADMIN}\`.\`${tbl}\``);
      adminCount = ar.c;
    } catch (e) { adminCount = `[${e.code}]`; }
    try {
      const [[dr]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DEV_DB}\`.\`${tbl}\``);
      devCount = dr.c;
    } catch (e) { devCount = `[${e.code}]`; }
    console.log(`   ${tbl.padEnd(35)} ${String(adminCount).padStart(10)} ${String(devCount).padStart(16)}`);
  }

  // ── admin org name (no PII, just first org name to confirm real data) ──
  try {
    const [[org]] = await conn.query(`SELECT name FROM \`${ADMIN}\`.organizations LIMIT 1`);
    console.log(`\n   admin first organization: "${org ? org.name : '(none)'}" (confirms real business data or seed)`);
  } catch (_) {}

  try {
    const [[org]] = await conn.query(`SELECT name FROM \`${DEV_DB}\`.organizations LIMIT 1`);
    console.log(`   dev_disposable first organization: "${org ? org.name : '(none)'}" (confirms seed data)`);
  } catch (_) {}

  await conn.end();
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' Audit complete — zero writes performed.');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('Audit script error:', e.message);
  process.exit(1);
});
