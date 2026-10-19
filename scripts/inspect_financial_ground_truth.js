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
    password: env.DATABASE_PASSWORD,
    database: 'admin'
  });

  console.log('=== FINANCIAL DATA RECONCILIATION: GROUND TRUTH FROM ADMIN DB ===\n');

  // 1. Invoices by Business
  console.log('--- 1. INVOICES BY BUSINESS ---');
  const [invSummary] = await conn.query(`
    SELECT 
      COALESCE(businessId, 'NULL') AS bizId,
      documentType,
      COUNT(*) AS count,
      SUM(subtotal) AS totalSubtotal,
      SUM(gstAmount) AS totalGst,
      SUM(grandTotal) AS totalGrand,
      SUM(paidAmount) AS totalPaid,
      SUM(outstandingAmount) AS totalOutstanding
    FROM invoices
    GROUP BY businessId, documentType
    ORDER BY businessId, documentType
  `);
  console.table(invSummary);

  // 2. Payments
  console.log('\n--- 2. PAYMENTS ---');
  const [payments] = await conn.query(`
    SELECT id, receiptNumber, invoiceId, businessId, amount, method, paymentDate, status
    FROM payments
    ORDER BY id ASC
  `);
  console.table(payments);

  // 3. Journal Entries Equilibrium
  console.log('\n--- 3. JOURNAL ENTRIES EQUILIBRIUM ---');
  const [journals] = await conn.query(`
    SELECT 
      je.id,
      je.entryNumber,
      je.businessId,
      je.status,
      je.entryDate,
      ROUND(SUM(jel.debit), 2) AS totalDebit,
      ROUND(SUM(jel.credit), 2) AS totalCredit,
      ROUND(SUM(jel.debit) - SUM(jel.credit), 2) AS diff
    FROM journal_entries je
    LEFT JOIN journal_entry_lines jel ON je.id = jel.journalEntryId
    GROUP BY je.id, je.entryNumber, je.businessId, je.status, je.entryDate
    ORDER BY je.id ASC
  `);
  console.table(journals);

  let unbalanced = journals.filter(j => Math.abs(j.diff) > 0.001);
  console.log(`Unbalanced journal entries: ${unbalanced.length}`);

  // 4. Trial Balance Accounts & Balances
  console.log('\n--- 4. TRIAL BALANCE SUMMARY BY BUSINESS ---');
  const [tbSummary] = await conn.query(`
    SELECT 
      je.businessId,
      COUNT(DISTINCT jel.accountId) AS accountsUsed,
      ROUND(SUM(jel.debit), 2) AS sumDebits,
      ROUND(SUM(jel.credit), 2) AS sumCredits,
      ROUND(SUM(jel.debit) - SUM(jel.credit), 2) AS tbDifference
    FROM journal_entries je
    JOIN journal_entry_lines jel ON je.id = jel.journalEntryId
    WHERE je.status = 'POSTED'
    GROUP BY je.businessId
  `);
  console.table(tbSummary);

  // 5. Projects by Business
  console.log('\n--- 5. PROJECTS BY BUSINESS ---');
  const [projects] = await conn.query(`
    SELECT id, code, name, businessId, status, contractValue, budgetAmount
    FROM projects
    ORDER BY businessId, id
  `);
  console.table(projects);

  await conn.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
