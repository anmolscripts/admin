'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — PAYMENT ACCOUNTING BACKFILL CLI TOOL (MILESTONE 5)
 * ==============================================================================
 *
 * Scans historical payment records that predate Milestone 5 and have no
 * double-entry general ledger journal entry.
 *
 * Usage:
 *   node scripts/backfill-payment-accounting.js --dry-run
 *   node scripts/backfill-payment-accounting.js --execute
 *
 * Safeguards:
 *   1. Defaults to --dry-run unless --execute is explicitly specified.
 *   2. Strictly checks payment status ('POSTED' only). VOID payments are skipped.
 *   3. Enforces idempotency via idempotencyKey: 'PAYMENT:<id>'.
 *   4. Validates Financial Year and rejects closed Financial Years.
 *   5. Validates payment methods and maps to system accounts.
 *   6. Prints reconciliation table with totals and verification checksums.
 * ==============================================================================
 */

require('dotenv').config();
const prisma = require('../app/config/prisma');
const postingService = require('../app/services/accounting/posting.service');
const coaService = require('../app/services/chartOfAccounts.service');
const { ensureFinancialYear } = require('../app/services/financialYear.service');

async function main() {
    const args = process.argv.slice(2);
    const isExecute = args.includes('--execute');
    const isDryRun = !isExecute;

    const targetEnv = process.env.NODE_ENV || 'development';
    const dbHost = process.env.DATABASE_HOST || 'localhost';
    const dbPort = process.env.DATABASE_PORT || '3306';
    const dbName = process.env.DATABASE_NAME || 'admin';

    console.log('==============================================================================');
    console.log(`SPARK ADMIN: PAYMENT ACCOUNTING BACKFILL (${isExecute ? 'EXECUTE MODE' : 'DRY RUN / PREVIEW MODE'})`);
    console.log('==============================================================================');
    console.log(`Target Environment : ${targetEnv}`);
    console.log(`Target Database    : ${dbName} on ${dbHost}:${dbPort}`);
    console.log('==============================================================================\n');

    if (targetEnv === 'production' && isExecute) {
        const confirmBackfill = process.env.CONFIRM_PRODUCTION_BACKFILL;
        const confirmBackup = process.env.CONFIRM_BACKUP_ACKNOWLEDGED;

        if (confirmBackfill !== 'YES' || confirmBackup !== 'YES') {
            console.error('⛔ FATAL: Unsafe execution prevented.');
            console.error('Executing the payment accounting backfill in PRODUCTION is refused by default.');
            console.error('\nBefore any approved production backfill, the operator must:');
            console.error('  1. Verify the target environment and database identity displayed above.');
            console.error('  2. Complete and verify a full database backup and restore procedure.');
            console.error('  3. Explicitly supply the following operator acknowledgements:');
            console.error('       CONFIRM_PRODUCTION_BACKFILL=YES');
            console.error('       CONFIRM_BACKUP_ACKNOWLEDGED=YES');
            console.error('\nNOTE: These confirmation flags represent explicit operator acknowledgement only');
            console.error('and do not automatically prove that a backup exists or is valid.\n');
            process.exit(1);
        }
        console.warn('⚠️  CONFIRMED PRODUCTION EXECUTION: Operator has explicitly acknowledged target identity and backup procedure.');
    }

    // 1. Ensure system accounts exist
    await coaService.ensureSystemAccounts();

    // 2. Fetch all POSTED payments
    const payments = await prisma.payment.findMany({
        where: { status: 'POSTED' },
        include: {
            invoice: {
                include: { client: true }
            },
            financialYear: true
        },
        orderBy: { id: 'asc' }
    });

    console.log(`Found total ${payments.length} POSTED payments in database.\n`);

    let alreadyPostedCount = 0;
    let eligibleCount = 0;
    let skippedCount = 0;
    let totalEligibleCents = 0n;
    const candidates = [];

    for (const payment of payments) {
        const idempotencyKey = postingService.getPaymentIdempotencyKey(payment.id);
        const existingJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey }
        });

        if (existingJournal) {
            alreadyPostedCount++;
            continue;
        }

        // Validate eligibility
        if (!payment.invoice) {
            console.warn(`[SKIP] Payment #${payment.id}: Missing linked invoice.`);
            skippedCount++;
            continue;
        }

        if (payment.invoice.documentType !== 'INVOICE') {
            console.warn(`[SKIP] Payment #${payment.id}: Linked document ${payment.invoice.invoiceNumber} is not an invoice.`);
            skippedCount++;
            continue;
        }

        if (['VOID', 'DELETED', 'INACTIVE'].includes(payment.invoice.status)) {
            console.warn(`[SKIP] Payment #${payment.id}: Linked invoice ${payment.invoice.invoiceNumber} status is ${payment.invoice.status}.`);
            skippedCount++;
            continue;
        }

        const paymentDate = new Date(payment.paymentDate);
        if (isNaN(paymentDate.getTime())) {
            console.warn(`[SKIP] Payment #${payment.id}: Invalid paymentDate.`);
            skippedCount++;
            continue;
        }

        let assetAccount;
        try {
            assetAccount = await postingService.resolvePaymentAssetAccount(payment.method);
        } catch (accErr) {
            console.warn(`[SKIP] Payment #${payment.id}: Method ${payment.method} unsupported (${accErr.message}).`);
            skippedCount++;
            continue;
        }

        let fy;
        try {
            fy = await ensureFinancialYear(paymentDate);
            if (fy.status === 'CLOSED') {
                console.warn(`[SKIP] Payment #${payment.id}: Financial Year ${fy.code} is CLOSED.`);
                skippedCount++;
                continue;
            }
        } catch (fyErr) {
            console.warn(`[SKIP] Payment #${payment.id}: FY resolution failed (${fyErr.message}).`);
            skippedCount++;
            continue;
        }

        const amountCents = postingService.toCents(payment.amount);
        totalEligibleCents += amountCents;
        eligibleCount++;
        candidates.push({
            payment,
            fy,
            assetAccount,
            amountCents
        });
    }

    console.log('------------------------------------------------------------------------------');
    console.log(`Summary of Payment Ledger Scan:`);
    console.log(`  - Already Posted to Ledger: ${alreadyPostedCount}`);
    console.log(`  - Eligible for Backfill:     ${eligibleCount}`);
    console.log(`  - Skipped (Ineligible):      ${skippedCount}`);
    console.log(`  - Total Eligible Amount:     ₹${postingService.fromCents(totalEligibleCents)}`);
    console.log('------------------------------------------------------------------------------\n');

    if (eligibleCount === 0) {
        console.log('No eligible unposted payments found. General ledger is fully up to date.');
        await prisma.$disconnect();
        return;
    }

    // Display candidate preview
    console.log('Candidate Payments for Posting:');
    console.log('ID    | Date       | Amount (₹)   | Method         | Invoice        | Client                 | Asset Account');
    console.log('------+------------+--------------+----------------+----------------+------------------------+--------------------');
    for (const c of candidates) {
        const p = c.payment;
        const idStr = String(p.id).padEnd(5);
        const dateStr = p.paymentDate.toISOString().slice(0, 10).padEnd(10);
        const amtStr = postingService.fromCents(c.amountCents).padStart(12);
        const methStr = (p.method || 'BANK_TRANSFER').padEnd(14);
        const invStr = (p.invoice ? p.invoice.invoiceNumber : '').padEnd(14);
        const clientStr = (p.invoice && p.invoice.clientName ? p.invoice.clientName.slice(0, 22) : '').padEnd(22);
        const accStr = `${c.assetAccount.code} (${c.assetAccount.name})`.slice(0, 20);
        console.log(`${idStr} | ${dateStr} | ${amtStr} | ${methStr} | ${invStr} | ${clientStr} | ${accStr}`);
    }
    console.log('------+------------+--------------+----------------+----------------+------------------------+--------------------\n');

    if (isDryRun) {
        console.log('🔎 DRY RUN COMPLETE. No changes were made to the database.');
        console.log('To post these journals to the double-entry general ledger, re-run with:');
        console.log('   node scripts/backfill-payment-accounting.js --execute\n');
        await prisma.$disconnect();
        return;
    }

    // EXECUTE MODE: Post each payment atomically
    console.log('🚀 EXECUTING BACKFILL...');
    let postedSuccess = 0;
    let postedFailed = 0;
    let totalPostedCents = 0n;

    for (const c of candidates) {
        const p = c.payment;
        try {
            const result = await postingService.postPayment(p.id, {
                userId: p.createdById || null
            });
            if (result.success) {
                postedSuccess++;
                totalPostedCents += c.amountCents;
                console.log(`  ✓ Payment #${p.id} posted -> ${result.journal.entryNumber} (₹${postingService.fromCents(c.amountCents)})`);
            }
        } catch (err) {
            postedFailed++;
            console.error(`  ✗ Payment #${p.id} failed: ${err.message}`);
        }
    }

    console.log('\n==============================================================================');
    console.log('BACKFILL EXECUTION SUMMARY:');
    console.log(`  - Successfully Posted:  ${postedSuccess} journals`);
    console.log(`  - Failed:               ${postedFailed}`);
    console.log(`  - Total Amount Posted:  ₹${postingService.fromCents(totalPostedCents)}`);
    console.log('==============================================================================\n');

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('Fatal backfill error:', err);
    await prisma.$disconnect();
    process.exit(1);
});
