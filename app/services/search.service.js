'use strict';

const prisma = require('../config/prisma');
const navigationService = require('./navigation.service');

const MAX_PER_CATEGORY = 5;

/**
 * Permission-aware universal search service
 *
 * @param {string} query
 * @param {Object} user
 * @param {Function} [hasPermissionFn]
 * @returns {Promise<{ categories: Array<{ name: string, items: Array }>, total: number }>}
 */
async function search(query, user, hasPermissionFn) {
    const rawQuery = (query || '').trim();
    if (!rawQuery || rawQuery.length < 2) {
        return { categories: [], total: 0 };
    }

    const q = rawQuery.slice(0, 50); // limit search string length
    const categories = [];
    let totalCount = 0;

    // 1. Commands & Navigation
    const commands = navigationService.searchCommands(q, user, hasPermissionFn);
    if (commands.length > 0) {
        categories.push({
            name: 'Commands & Navigation',
            items: commands.slice(0, MAX_PER_CATEGORY)
        });
        totalCount += commands.length;
    }

    // 2. Documents (Invoices & Quotations)
    if (navigationService.checkPermission(user, 'DOCUMENTS', 'VIEW', hasPermissionFn)) {
        try {
            const documents = await prisma.invoice.findMany({
                where: {
                    status: { not: 'DELETED' },
                    OR: [
                        { invoiceNumber: { contains: q } },
                        { clientName: { contains: q } },
                        { clientGSTIN: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { invoiceDate: 'desc' },
                select: {
                    id: true,
                    invoiceNumber: true,
                    clientName: true,
                    documentType: true,
                    status: true,
                    grandTotal: true,
                    invoiceDate: true
                }
            });

            if (documents.length > 0) {
                const docItems = documents.map(doc => {
                    const typeLabel = doc.documentType === 'QUOTATION' ? 'Quotation' : 'Invoice';
                    const formattedTotal = Number(doc.grandTotal).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
                    return {
                        id: `doc-${doc.id}`,
                        title: `${doc.invoiceNumber} — ${doc.clientName}`,
                        subtitle: `${typeLabel} • ${doc.status} • ${formattedTotal}`,
                        category: 'Documents',
                        icon: doc.documentType === 'QUOTATION' ? 'bi-file-earmark-text' : 'bi-receipt',
                        url: `/documents/${doc.id}`
                    };
                });
                categories.push({ name: 'Documents', items: docItems });
                totalCount += docItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying documents:', err.message);
        }
    }

    // 3. Clients
    if (navigationService.checkPermission(user, 'CLIENTS', 'VIEW', hasPermissionFn)) {
        try {
            const clients = await prisma.client.findMany({
                where: {
                    active: true,
                    OR: [
                        { clientCode: { contains: q } },
                        { name: { contains: q } },
                        { email: { contains: q } },
                        { phone: { contains: q } },
                        { gstin: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { name: 'asc' },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    gstin: true
                }
            });

            if (clients.length > 0) {
                const clientItems = clients.map(c => ({
                    id: `client-${c.id}`,
                    title: c.name,
                    subtitle: [c.email, c.phone, c.gstin ? `GST: ${c.gstin}` : null].filter(Boolean).join(' • ') || 'Client record',
                    category: 'Clients',
                    icon: 'bi-person-badge',
                    url: `/clients?search=${encodeURIComponent(c.name)}`
                }));
                categories.push({ name: 'Clients', items: clientItems });
                totalCount += clientItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying clients:', err.message);
        }
    }

    // 4. Credit & Debit Notes
    if (navigationService.checkPermission(user, 'CREDIT_DEBIT_NOTES', 'VIEW', hasPermissionFn)) {
        try {
            const notes = await prisma.creditDebitNote.findMany({
                where: {
                    OR: [
                        { noteNumber: { contains: q } },
                        { clientName: { contains: q } },
                        { originalInvoiceNumber: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { noteDate: 'desc' },
                select: {
                    id: true,
                    noteNumber: true,
                    noteType: true,
                    clientName: true,
                    grandTotal: true,
                    status: true
                }
            });

            if (notes.length > 0) {
                const noteItems = notes.map(n => ({
                    id: `note-${n.id}`,
                    title: `${n.noteNumber} — ${n.clientName}`,
                    subtitle: `${n.noteType} NOTE • ${n.status} • ₹${Number(n.grandTotal).toLocaleString('en-IN')}`,
                    category: 'Credit & Debit Notes',
                    icon: 'bi-receipt-cutoff',
                    url: `/credit-debit-notes/${n.id}`
                }));
                categories.push({ name: 'Credit & Debit Notes', items: noteItems });
                totalCount += noteItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying notes:', err.message);
        }
    }

    // 5. Items
    if (navigationService.checkPermission(user, 'ITEMS', 'VIEW', hasPermissionFn)) {
        try {
            const items = await prisma.item.findMany({
                where: {
                    active: true,
                    OR: [
                        { itemCode: { contains: q } },
                        { name: { contains: q } },
                        { hsnSac: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { name: 'asc' },
                select: {
                    id: true,
                    name: true,
                    rate: true,
                    unit: true,
                    hsnSac: true
                }
            });

            if (items.length > 0) {
                const itemResults = items.map(it => ({
                    id: `item-${it.id}`,
                    title: it.name,
                    subtitle: `Rate: ₹${Number(it.rate).toLocaleString('en-IN')} / ${it.unit}${it.hsnSac ? ` • HSN: ${it.hsnSac}` : ''}`,
                    category: 'Items',
                    icon: 'bi-box-seam',
                    url: `/items?search=${encodeURIComponent(it.name)}`
                }));
                categories.push({ name: 'Items', items: itemResults });
                totalCount += itemResults.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying items:', err.message);
        }
    }

    // 6. Units
    if (navigationService.checkPermission(user, 'UNITS', 'VIEW', hasPermissionFn)) {
        try {
            const units = await prisma.unit.findMany({
                where: {
                    active: true,
                    OR: [
                        { unitCode: { contains: q } },
                        { name: { contains: q } },
                        { symbol: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { name: 'asc' },
                select: {
                    id: true,
                    name: true,
                    symbol: true
                }
            });

            if (units.length > 0) {
                const unitResults = units.map(u => ({
                    id: `unit-${u.id}`,
                    title: `${u.name} (${u.symbol})`,
                    subtitle: 'Unit of measurement',
                    category: 'Units',
                    icon: 'bi-rulers',
                    url: `/units`
                }));
                categories.push({ name: 'Units', items: unitResults });
                totalCount += unitResults.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying units:', err.message);
        }
    }

    // 7. Chart of Accounts
    if (navigationService.checkPermission(user, 'REPORTS', 'VIEW', hasPermissionFn)) {
        try {
            const accounts = await prisma.chartOfAccount.findMany({
                where: {
                    active: true,
                    OR: [
                        { code: { contains: q } },
                        { name: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { code: 'asc' },
                select: {
                    id: true,
                    code: true,
                    name: true,
                    type: true
                }
            });

            if (accounts.length > 0) {
                const accountItems = accounts.map(a => ({
                    id: `acc-${a.id}`,
                    title: `[${a.code}] ${a.name}`,
                    subtitle: `${a.type} Account`,
                    category: 'Chart of Accounts',
                    icon: 'bi-journal-bookmark',
                    url: `/reports/general-ledger?accountId=${a.id}`
                }));
                categories.push({ name: 'Chart of Accounts', items: accountItems });
                totalCount += accountItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying chart of accounts:', err.message);
        }
    }

    // 8. Financial Years
    if (navigationService.checkPermission(user, 'FINANCIAL_YEARS', 'VIEW', hasPermissionFn)) {
        try {
            const fys = await prisma.financialYear.findMany({
                where: {
                    code: { contains: q }
                },
                take: MAX_PER_CATEGORY,
                orderBy: { startDate: 'desc' },
                select: {
                    id: true,
                    code: true,
                    status: true,
                    isCurrent: true
                }
            });

            if (fys.length > 0) {
                const fyItems = fys.map(f => ({
                    id: `fy-${f.id}`,
                    title: `Financial Year ${f.code}`,
                    subtitle: `Status: ${f.status}${f.isCurrent ? ' (Current)' : ''}`,
                    category: 'Financial Years',
                    icon: 'bi-calendar2-range',
                    url: `/financial-years`
                }));
                categories.push({ name: 'Financial Years', items: fyItems });
                totalCount += fyItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying financial years:', err.message);
        }
    }

    // 9. Team Members (Only if user has TEAM:VIEW permission)
    if (navigationService.checkPermission(user, 'TEAM', 'VIEW', hasPermissionFn)) {
        try {
            const teamMembers = await prisma.user.findMany({
                where: {
                    active: true,
                    OR: [
                        { name: { contains: q } },
                        { email: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true
                }
            });

            if (teamMembers.length > 0) {
                const memberItems = teamMembers.map(m => ({
                    id: `user-${m.id}`,
                    title: m.name,
                    subtitle: `${m.role} • ${m.email}`,
                    category: 'Team Members',
                    icon: 'bi-person',
                    url: `/team`
                }));
                categories.push({ name: 'Team Members', items: memberItems });
                totalCount += memberItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying team members:', err.message);
        }
    }

    // 10. Suppliers
    if (navigationService.checkPermission(user, 'PURCHASE', 'VIEW', hasPermissionFn)) {
        try {
            const suppliers = await prisma.supplier.findMany({
                where: {
                    active: true,
                    OR: [
                        { supplierCode: { contains: q } },
                        { name: { contains: q } },
                        { email: { contains: q } },
                        { phone: { contains: q } },
                        { gstin: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { name: 'asc' },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    gstin: true
                }
            });

            if (suppliers.length > 0) {
                const supplierItems = suppliers.map(s => ({
                    id: `sup-${s.id}`,
                    title: s.name,
                    subtitle: [s.email, s.phone, s.gstin ? `GST: ${s.gstin}` : null].filter(Boolean).join(' • ') || 'Supplier record',
                    category: 'Suppliers',
                    icon: 'bi-truck',
                    url: `/purchases/suppliers/${s.id}`
                }));
                categories.push({ name: 'Suppliers', items: supplierItems });
                totalCount += supplierItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying suppliers:', err.message);
        }
    }

    // 11. Purchase Orders
    if (navigationService.checkPermission(user, 'PURCHASE', 'VIEW', hasPermissionFn)) {
        try {
            const purchaseOrders = await prisma.purchaseOrder.findMany({
                where: {
                    OR: [
                        { orderNumber: { contains: q } },
                        { supplierName: { contains: q } },
                        { supplierGSTIN: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { orderDate: 'desc' },
                select: {
                    id: true,
                    orderNumber: true,
                    supplierName: true,
                    status: true,
                    orderDate: true
                }
            });

            if (purchaseOrders.length > 0) {
                const poItems = purchaseOrders.map(po => ({
                    id: `po-${po.id}`,
                    title: `${po.orderNumber} — ${po.supplierName}`,
                    subtitle: `Purchase Order • ${po.status}`,
                    category: 'Purchase Orders',
                    icon: 'bi-cart-check',
                    url: `/purchases/orders/${po.id}`
                }));
                categories.push({ name: 'Purchase Orders', items: poItems });
                totalCount += poItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying purchase orders:', err.message);
        }
    }

    // 12. Supplier Bills
    if (navigationService.checkPermission(user, 'PURCHASE', 'VIEW', hasPermissionFn)) {
        try {
            const bills = await prisma.supplierBill.findMany({
                where: {
                    OR: [
                        { billNumber: { contains: q } },
                        { internalNumber: { contains: q } },
                        { supplierName: { contains: q } },
                        { supplierGSTIN: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { billDate: 'desc' },
                select: {
                    id: true,
                    billNumber: true,
                    supplierName: true,
                    status: true,
                    totalAmount: true
                }
            });

            if (bills.length > 0) {
                const billItems = bills.map(b => ({
                    id: `bill-${b.id}`,
                    title: `${b.billNumber} — ${b.supplierName}`,
                    subtitle: `Supplier Bill • ${b.status} • ₹${Number(b.totalAmount).toLocaleString('en-IN')}`,
                    category: 'Supplier Bills',
                    icon: 'bi-receipt-cutoff',
                    url: `/purchases/bills`
                }));
                categories.push({ name: 'Supplier Bills', items: billItems });
                totalCount += billItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying supplier bills:', err.message);
        }
    }

    // 13. Expenses
    if (navigationService.checkPermission(user, 'EXPENSES', 'VIEW', hasPermissionFn)) {
        try {
            const expenses = await prisma.expense.findMany({
                where: {
                    OR: [
                        { expenseNumber: { contains: q } },
                        { category: { contains: q } },
                        { description: { contains: q } }
                    ]
                },
                take: MAX_PER_CATEGORY,
                orderBy: { expenseDate: 'desc' },
                select: {
                    id: true,
                    category: true,
                    description: true,
                    amount: true,
                    expenseDate: true
                }
            });

            if (expenses.length > 0) {
                const expenseItems = expenses.map(e => ({
                    id: `exp-${e.id}`,
                    title: `${e.category || 'Expense'}: ₹${Number(e.amount).toLocaleString('en-IN')}`,
                    subtitle: e.description || 'Operating Expense',
                    category: 'Expenses',
                    icon: 'bi-cash-coin',
                    url: `/financials/expenses`
                }));
                categories.push({ name: 'Expenses', items: expenseItems });
                totalCount += expenseItems.length;
            }
        } catch (err) {
            console.error('[SEARCH SERVICE] Error querying expenses:', err.message);
        }
    }

    return {
        categories,
        total: totalCount
    };
}

module.exports = {
    search
};
