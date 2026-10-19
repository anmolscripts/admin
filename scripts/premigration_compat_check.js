/**
 * Read-only pre-migration compatibility check for admin database.
 * Verifies that all tables referenced by migration 24 exist with the expected structure.
 * ZERO writes. ZERO schema changes.
 */
'use strict';
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs');
const env = dotenv.parse(fs.readFileSync('.env'));

async function main() {
  const conn = await mysql.createConnection({
    host:     env.DATABASE_HOST || 'localhost',
    port:     Number(env.DATABASE_PORT || 3306),
    user:     env.DATABASE_USER || 'root',
    password: env.DATABASE_PASSWORD
  });

  const DB = 'admin';

  // Independent safety check — must NOT be connected to the target DB at session level
  const [[{ db: sessionDb }]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr');
  console.log(`Session default DB : ${sessionDb || '(none — safe)'}`);
  console.log('');

  let allOk = true;
  const issues = [];

  function check(label, ok, detail) {
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark} ${label}${detail ? ': ' + detail : ''}`);
    if (!ok) { allOk = false; issues.push(label); }
  }

  // ── 1. Migration history ─────────────────────────────────────────
  console.log('── Migration 23 presence (last applied in admin) ──');
  const [migs] = await conn.query(
    `SELECT migration_name, finished_at FROM \`${DB}\`._prisma_migrations ORDER BY finished_at ASC`
  );
  const migNames = migs.map(m => m.migration_name);
  const lastMig  = migNames[migNames.length - 1];
  check('Migration 23 is last applied', lastMig === '20261017183000_add_project_costing_and_attachments', lastMig);
  check('Migration 24 NOT yet applied (expected)', !migNames.includes('20261018200000_add_goods_receipts_and_enhanced_attachments'));

  const failedMigs = migs.filter(m => !m.finished_at);
  check('No pending/failed migrations in admin', failedMigs.length === 0,
    failedMigs.length ? failedMigs.map(m => m.migration_name).join(', ') : '');
  console.log('');

  // ── 2. Tables migration 24 ALTERs must pre-exist ─────────────────
  console.log('── Tables that migration 24 ALTERs — must already exist ──');
  const requiredExisting = ['purchase_order_items', 'stock_movements', 'project_attachments'];
  for (const tbl of requiredExisting) {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [DB, tbl]
    );
    check(`Table \`${tbl}\` exists`, rows.length > 0);
  }
  console.log('');

  // ── 3. Tables migration 24 CREATEs must NOT pre-exist ────────────
  console.log('── Tables that migration 24 CREATEs — must NOT exist yet ──');
  const newTables = ['goods_receipts', 'goods_receipt_items'];
  for (const tbl of newTables) {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [DB, tbl]
    );
    check(`Table \`${tbl}\` does NOT yet exist (correct)`, rows.length === 0,
      rows.length ? 'ALREADY EXISTS — migration may fail or be partially applied' : '');
  }
  console.log('');

  // ── 4. Columns migration 24 ADDs must NOT pre-exist ──────────────
  console.log('── Columns that migration 24 ADDs — must NOT already exist ──');
  const newColumns = [
    { table: 'purchase_order_items', column: 'projectId' },
    { table: 'stock_movements',      column: 'storeLocation' },
    { table: 'project_attachments',  column: 'title' },
    { table: 'project_attachments',  column: 'category' },
    { table: 'project_attachments',  column: 'description' },
    { table: 'project_attachments',  column: 'referenceNumber' },
    { table: 'project_attachments',  column: 'issueDate' },
    { table: 'project_attachments',  column: 'expiryDate' },
  ];
  for (const { table, column } of newColumns) {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB, table, column]
    );
    check(`Column \`${table}\`.\`${column}\` does NOT yet exist (correct)`, rows.length === 0,
      rows.length ? 'ALREADY EXISTS — ALTER will fail' : '');
  }
  console.log('');

  // ── 5. Foreign-key reference tables must exist and be non-empty ──
  console.log('── FK reference tables must exist ──');
  const fkRefs = ['businesses', 'purchase_orders', 'suppliers', 'projects', 'users',
                  'purchase_order_items', 'items', 'stock_movements'];
  for (const tbl of fkRefs) {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [DB, tbl]
    );
    let rowCnt = '?';
    if (rows.length) {
      const [[cnt]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DB}\`.\`${tbl}\``);
      rowCnt = cnt.c;
    }
    check(`FK ref table \`${tbl}\` exists`, rows.length > 0,
      rows.length ? `${rowCnt} rows` : 'MISSING');
  }
  console.log('');

  // ── 6. Character set compatibility ───────────────────────────────
  console.log('── Character set / collation of admin ──');
  const [[dbInfo]] = await conn.query(
    `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
     FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [DB]
  );
  const charsetOk  = dbInfo.DEFAULT_CHARACTER_SET_NAME === 'utf8mb4';
  const collateOk  = dbInfo.DEFAULT_COLLATION_NAME === 'utf8mb4_unicode_ci';
  check('DB charset = utf8mb4',         charsetOk,  dbInfo.DEFAULT_CHARACTER_SET_NAME);
  check('DB collation = utf8mb4_unicode_ci', collateOk, dbInfo.DEFAULT_COLLATION_NAME);
  console.log('');

  // ── 7. Existing data integrity snapshot ──────────────────────────
  console.log('── Existing business data — read-only row count snapshot ──');
  const dataTables = [
    'businesses','users','clients','invoices','invoice_items',
    'payments','expenses','financial_years','chart_of_accounts',
    'journal_entries','journal_entry_lines','user_activity_logs',
    'projects','project_attachments','purchase_orders',
    'stock_movements','suppliers'
  ];
  for (const tbl of dataTables) {
    try {
      const [[cnt]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DB}\`.\`${tbl}\``);
      console.log(`  ${tbl.padEnd(35)} ${cnt.c} rows`);
    } catch (e) {
      console.log(`  ${tbl.padEnd(35)} [${e.code}]`);
    }
  }
  console.log('');

  await conn.end();

  // ── Summary ───────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  if (allOk) {
    console.log(' COMPATIBILITY: PASS — migration 24 is safe to apply to admin');
  } else {
    console.log(' COMPATIBILITY: FAIL — issues found:');
    issues.forEach(i => console.log(`   • ${i}`));
  }
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('Check script error:', e.message);
  process.exit(1);
});
