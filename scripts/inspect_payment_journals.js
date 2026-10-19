'use strict';

require('dotenv').config({ path: '.env.test', override: true });
const prisma = require('../app/config/prisma');

async function main() {
    const invoice = await prisma.invoice.findUnique({
        where: { id: 5309 },
        include: {
            payments: {
                orderBy: { id: 'asc' }
            }
        }
    });

    if (!invoice) {
        console.log('Invoice 5309 not found');
        return;
    }

    console.log('--- INVOICE ---');
    console.log({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        grandTotal: Number(invoice.grandTotal),
        paidAmount: Number(invoice.paidAmount),
        outstandingAmount: Number(invoice.outstandingAmount),
        status: invoice.status,
        businessId: invoice.businessId,
        clientId: invoice.clientId
    });

    console.log('\n--- PAYMENTS & JOURNALS ---');
    for (const p of invoice.payments) {
        const journals = await prisma.journalEntry.findMany({
            where: {
                businessId: invoice.businessId,
                sourceType: 'PAYMENT',
                sourceId: p.id
            },
            include: {
                lines: {
                    include: { account: true },
                    orderBy: { lineNumber: 'asc' }
                }
            }
        });

        console.log(`\nPayment ID ${p.id}:`);
        console.log({
            amount: Number(p.amount),
            method: p.method,
            reference: p.reference,
            paymentDate: p.paymentDate,
            status: p.status,
            journalCount: journals.length
        });

        for (const j of journals) {
            console.log(`  Journal Entry: ${j.entryNumber} (ID: ${j.id})`);
            console.log(`  Narration: "${j.narration}"`);
            let sumDr = 0;
            let sumCr = 0;
            for (const l of j.lines) {
                const dr = Number(l.debit);
                const cr = Number(l.credit);
                sumDr += dr;
                sumCr += cr;
                console.log(`    Line ${l.lineNumber}: [${l.account.code}] ${l.account.name} | Dr: ₹${dr.toFixed(2)} | Cr: ₹${cr.toFixed(2)} | Client: ${l.clientId}`);
            }
            console.log(`  Sum Dr: ₹${sumDr.toFixed(2)} | Sum Cr: ₹${sumCr.toFixed(2)} | Balanced: ${Math.abs(sumDr - sumCr) < 0.01}`);
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
