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

  const [bizs] = await conn.query('SELECT id, name, currency FROM `admin`.`businesses` ORDER BY id ASC');
  console.log(`\n=== BUSINESSES IN ADMIN DB (${bizs.length}) ===`);
  for (const b of bizs) {
    const [[clCount]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`clients` WHERE businessId = ?', [b.id]);
    const [[invCount]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`invoices` WHERE businessId = ?', [b.id]);
    const [[projCount]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`projects` WHERE businessId = ?', [b.id]);
    const [[poCount]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`purchase_orders` WHERE businessId = ?', [b.id]);
    const [[grnCount]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`goods_receipts` WHERE businessId = ?', [b.id]);
    const [[jeCount]] = await conn.query('SELECT COUNT(*) AS c FROM `admin`.`journal_entries` WHERE businessId = ?', [b.id]);
    console.log(`ID ${b.id}: "${b.name}" (${b.currency}) | Clients: ${clCount.c} | Invoices: ${invCount.c} | Projects: ${projCount.c} | POs: ${poCount.c} | GRNs: ${grnCount.c} | Journal Entries: ${jeCount.c}`);
  }

  await conn.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
