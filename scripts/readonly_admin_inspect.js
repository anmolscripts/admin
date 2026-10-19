/**
 * Read-only: inspect admin database structure and business data presence.
 * Zero writes of any kind.
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

  // Full admin migration list
  const [migs] = await conn.query(
    'SELECT migration_name, finished_at FROM `admin`._prisma_migrations ORDER BY finished_at ASC'
  );
  console.log(`\nadmin migrations (${migs.length} total):`);
  migs.forEach((m, i) => {
    const ts = m.finished_at ? new Date(m.finished_at).toISOString() : 'PENDING';
    console.log(`  ${String(i+1).padStart(2)}. [${ts}] ${m.migration_name}`);
  });

  // Check which table holds org/tenant data
  const [orgTbls] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = 'admin'
     AND TABLE_NAME IN ('organizations','businesses','companies','tenants','accounts')
     ORDER BY TABLE_NAME`
  );
  console.log('\nOrg-like tables in admin:', orgTbls.map(t => t.TABLE_NAME).join(', ') || '(none found)');

  // Try 'businesses' specifically
  try {
    const [[cnt]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`businesses`');
    console.log(`admin.businesses row count: ${cnt.c}`);
    const [bizRows] = await conn.query('SELECT id, name FROM `admin`.`businesses` LIMIT 5');
    bizRows.forEach(b => console.log(`  Business name: "${b.name}"`));
  } catch (e) {
    console.log('admin.businesses:', e.code || e.message);
  }

  // Key transactional tables row counts
  const keyTables = [
    'users', 'businesses', 'clients', 'invoices', 'invoice_items',
    'payments', 'expenses', 'financial_years', 'chart_of_accounts',
    'journal_entries', 'user_activity_logs', 'purchase_orders', 'projects'
  ];
  console.log('\nKey table row counts in admin:');
  for (const tbl of keyTables) {
    try {
      const [[cnt]] = await conn.query(`SELECT COUNT(*) AS c FROM \`admin\`.\`${tbl}\``);
      console.log(`  ${tbl.padEnd(30)} ${cnt.c}`);
    } catch (e) {
      console.log(`  ${tbl.padEnd(30)} [${e.code}]`);
    }
  }

  await conn.end();
  console.log('\nRead-only inspect complete.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
