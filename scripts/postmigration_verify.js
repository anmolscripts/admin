/**
 * Read-only post-migration verification script.
 * Run AFTER migration 24 is applied to admin.
 * Verifies every structural change and confirms existing data survived.
 * ZERO writes.
 */
'use strict';
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs');

// ── After migration, .env will point to admin. This script reads directly
//    from the target DB — it never relies on session default database alone.
const env = dotenv.parse(fs.readFileSync('.env'));

async function main() {
  const conn = await mysql.createConnection({
    host:     env.DATABASE_HOST || 'localhost',
    port:     Number(env.DATABASE_PORT || 3306),
    user:     env.DATABASE_USER || 'root',
    password: env.DATABASE_PASSWORD
  });

  // Independent safety check
  const [[{ db: sessionDb, usr }]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr');
  console.log(`Session default DB : ${sessionDb || '(none)'}  | User: ${usr}`);

  const DB = 'admin';
  let allOk = true;
  const issues = [];

  function check(label, ok, detail) {
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark} ${label}${detail ? ': ' + detail : ''}`);
    if (!ok) { allOk = false; issues.push({ label, detail }); }
  }

  // 1. Migration 24 recorded as applied
  console.log('\n── Migration record ──');
  const [migs] = await conn.query(
    `SELECT migration_name, finished_at FROM \`${DB}\`._prisma_migrations ORDER BY finished_at ASC`
  );
  check('24 migrations total', migs.length === 24, `found ${migs.length}`);
  const last = migs[migs.length - 1];
  check('Last migration = migration 24',
    last.migration_name === '20261018200000_add_goods_receipts_and_enhanced_attachments',
    last.migration_name);
  check('Migration 24 finished_at is set', !!last.finished_at,
    last.finished_at ? last.finished_at.toISOString() : 'NULL — still pending!');
  const failed = migs.filter(m => !m.finished_at);
  check('No pending/failed migrations', failed.length === 0,
    failed.length ? failed.map(m => m.migration_name).join(', ') : '');

  // 2. New tables created
  console.log('\n── New tables from migration 24 ──');
  for (const tbl of ['goods_receipts', 'goods_receipt_items']) {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [DB, tbl]
    );
    check(`Table \`${tbl}\` exists`, rows.length > 0);
    if (rows.length) {
      check(`Table \`${tbl}\` uses utf8mb4_unicode_ci`, rows[0].TABLE_COLLATION === 'utf8mb4_unicode_ci',
        rows[0].TABLE_COLLATION);
    }
  }

  // 3. Altered columns present
  console.log('\n── Altered columns from migration 24 ──');
  const expectedCols = [
    { table: 'purchase_order_items', column: 'projectId',       nullable: 'YES' },
    { table: 'stock_movements',      column: 'storeLocation',   nullable: 'YES' },
    { table: 'project_attachments',  column: 'title',           nullable: 'YES' },
    { table: 'project_attachments',  column: 'category',        nullable: 'NO'  },
    { table: 'project_attachments',  column: 'description',     nullable: 'YES' },
    { table: 'project_attachments',  column: 'referenceNumber', nullable: 'YES' },
    { table: 'project_attachments',  column: 'issueDate',       nullable: 'YES' },
    { table: 'project_attachments',  column: 'expiryDate',      nullable: 'YES' },
  ];
  for (const { table, column, nullable } of expectedCols) {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB, table, column]
    );
    check(`Column \`${table}\`.\`${column}\` exists`, rows.length > 0);
    if (rows.length) {
      check(`  nullable=${nullable}`, rows[0].IS_NULLABLE === nullable, `actual: ${rows[0].IS_NULLABLE}`);
    }
  }

  // 4. category column DEFAULT value
  const [[catCol]] = await conn.query(
    `SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'project_attachments' AND COLUMN_NAME = 'category'`, [DB]
  );
  check("project_attachments.category DEFAULT = 'OTHER'", catCol && catCol.COLUMN_DEFAULT === 'OTHER',
    catCol ? `actual: ${catCol.COLUMN_DEFAULT}` : 'column missing');

  // 5. Existing business data survived unchanged
  console.log('\n── Existing data survival check ──');
  const expected = {
    businesses: 6, users: 9, clients: 13, invoices: 19, invoice_items: 26,
    payments: 3, expenses: 2, financial_years: 7, chart_of_accounts: 264,
    journal_entries: 22, journal_entry_lines: 66, user_activity_logs: 177,
    projects: 4, project_attachments: 1
  };
  for (const [tbl, expectedCount] of Object.entries(expected)) {
    const [[cnt]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DB}\`.\`${tbl}\``);
    check(`\`${tbl}\` row count >= ${expectedCount} (pre-migration snapshot)`,
      cnt.c >= expectedCount, `actual: ${cnt.c}`);
  }

  // 6. New tables are empty (no phantom data)
  console.log('\n── New tables should be empty ──');
  for (const tbl of ['goods_receipts', 'goods_receipt_items']) {
    const [[cnt]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DB}\`.\`${tbl}\``);
    check(`\`${tbl}\` is empty (expected)`, cnt.c === 0, `rows: ${cnt.c}`);
  }

  await conn.end();

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  if (allOk) {
    console.log(' POST-MIGRATION VERIFICATION: PASS');
    console.log(' Safe to update .env and restart the application.');
  } else {
    console.log(' POST-MIGRATION VERIFICATION: FAIL');
    issues.forEach(i => console.log(`   • ${i.label}${i.detail ? ': ' + i.detail : ''}`));
    console.log(' DO NOT update .env until all issues are resolved.');
  }
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('Post-migration check error:', e.message);
  process.exit(1);
});
