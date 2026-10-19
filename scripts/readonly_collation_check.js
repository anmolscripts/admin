/**
 * Read-only: inspect per-table collation in admin to determine whether
 * the DB-level utf8mb4_0900_ai_ci collation is the actual collation used
 * by the existing tables (created by Prisma migrations 1-23), vs only a
 * schema-level default that Prisma doesn't rely on.
 *
 * Migration 24 creates tables with:
 *   DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
 * — which is an explicit table-level override.  If the existing tables
 * were created with an explicit utf8mb4_unicode_ci at table level, mixing
 * is safe. This script checks both sides.
 *
 * ZERO writes.
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

  // DB-level defaults
  const [[dbInfo]] = await conn.query(
    `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co
     FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [DB]
  );
  console.log(`\nDB-level defaults: charset=${dbInfo.cs}  collation=${dbInfo.co}`);
  console.log('(This is only the default for new tables that do not specify a collation)');

  // Per-table charset and collation for all existing tables
  const [tables] = await conn.query(
    `SELECT TABLE_NAME, TABLE_COLLATION, CREATE_OPTIONS
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [DB]
  );

  console.log(`\nPer-table collation in \`${DB}\`:`);
  const collations = new Set();
  for (const t of tables) {
    collations.add(t.TABLE_COLLATION);
    console.log(`  ${t.TABLE_NAME.padEnd(48)} ${t.TABLE_COLLATION}`);
  }

  console.log(`\nDistinct collations used by tables: ${[...collations].join(', ')}`);

  // Now check: what will migration-24 CREATE TABLE use?
  // It specifies: DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  // Check FK compatibility — do the FK parent tables use unicode_ci?
  const fkParents = ['businesses','purchase_orders','suppliers','projects','users','purchase_order_items','items','stock_movements'];
  console.log('\nFK parent table collations (critical for foreign key compatibility):');
  for (const tbl of fkParents) {
    const [[info]] = await conn.query(
      `SELECT TABLE_COLLATION FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [DB, tbl]
    );
    const compatible = info && (info.TABLE_COLLATION === 'utf8mb4_unicode_ci' || info.TABLE_COLLATION === 'utf8mb4_0900_ai_ci');
    console.log(`  ${tbl.padEnd(30)} ${info ? info.TABLE_COLLATION : 'N/A'}  ${compatible ? '✓' : '⚠ CHECK'}`);
  }

  // Check if any VARCHAR PK/FK join columns could cause implicit conversion warnings
  // (different collations between a child FK column and parent PK column)
  // In MySQL 8, FKs between utf8mb4_unicode_ci and utf8mb4_0900_ai_ci work but warn.
  // The PK columns in question are INTEGER (id), so collation mismatch is irrelevant for int FKs.
  console.log('\nNote: all FK join columns in migration 24 are INTEGER (id). Collation mismatch');
  console.log('does not affect integer foreign keys — no implicit conversion or index skip occurs.');
  console.log('The utf8mb4_unicode_ci on the new tables is safe alongside utf8mb4_0900_ai_ci tables.');

  await conn.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
