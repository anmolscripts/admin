'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const purchaseOrderService = require('../app/services/purchaseOrder.service');
const navigationService = require('../app/services/navigation.service');

describe('Purchase order GST calculations', () => {
    it('calculates line taxable value, discount, GST and total from source values', () => {
        const items = purchaseOrderService.sanitizeOrderItems([{
            name: 'Component',
            quantity: 2,
            rate: 100,
            discountAmount: 10,
            gstRate: 18,
            cgstAmount: 999,
            sgstAmount: 999,
            igstAmount: 999,
            totalAmount: 99999
        }]);

        assert.deepEqual({
            amount: items[0].amount,
            discountAmount: items[0].discountAmount,
            taxableAmount: items[0].taxableAmount,
            gstRate: items[0].gstRate,
            cgstAmount: items[0].cgstAmount,
            sgstAmount: items[0].sgstAmount,
            igstAmount: items[0].igstAmount,
            totalAmount: items[0].totalAmount
        }, {
            amount: 200,
            discountAmount: 10,
            taxableAmount: 190,
            gstRate: 18,
            cgstAmount: 17.1,
            sgstAmount: 17.1,
            igstAmount: 0,
            totalAmount: 224.2
        });
    });

    it('applies IGST only for inter-state suppliers and keeps rounded tax balanced', () => {
        const context = purchaseOrderService.resolvePurchaseTaxContext('27', '29');
        const [line] = purchaseOrderService.sanitizeOrderItems([{
            name: 'Rounded component',
            quantity: 3,
            rate: 33.33,
            gstRate: 18
        }], context.isInterState);
        const totals = purchaseOrderService.calculatePurchaseOrderTotals([line]);

        assert.equal(context.isInterState, true);
        assert.equal(line.taxableAmount, 99.99);
        assert.equal(line.igstAmount, 18);
        assert.equal(line.cgstAmount, 0);
        assert.equal(line.sgstAmount, 0);
        assert.equal(totals.totalTaxAmount, 18);
        assert.equal(totals.totalAmount, 117.99);
    });

    it('splits intra-state tax into balanced CGST and SGST and sums line snapshots', () => {
        const context = purchaseOrderService.resolvePurchaseTaxContext('27', '27');
        const items = purchaseOrderService.sanitizeOrderItems([
            { name: 'First', quantity: 1, rate: 0.15, gstRate: 18 },
            { name: 'Second', quantity: 1, rate: 0.15, gstRate: 18 }
        ], context.isInterState);
        const totals = purchaseOrderService.calculatePurchaseOrderTotals(items);

        assert.equal(context.isInterState, false);
        assert.equal(items[0].cgstAmount + items[0].sgstAmount, items[0].totalAmount - items[0].taxableAmount);
        assert.equal(totals.cgstAmount, 0.04);
        assert.equal(totals.sgstAmount, 0.02);
        assert.equal(totals.igstAmount, 0);
        assert.equal(totals.totalTaxAmount, 0.06);
        assert.equal(totals.totalAmount, 0.36);
    });

    it('validates server-side GST rates, quantity and discounts', () => {
        for (const gstRate of [0, 5, 12, 18, 28]) {
            const [line] = purchaseOrderService.sanitizeOrderItems([{
                name: `GST ${gstRate}`,
                quantity: 1,
                rate: 100,
                gstRate
            }]);
            assert.equal(line.gstRate, gstRate);
        }
        assert.throws(
            () => purchaseOrderService.sanitizeOrderItems([{ name: 'Invalid rate', quantity: 1, rate: 10, gstRate: 15 }]),
            /Invalid GST rate/
        );
        assert.throws(
            () => purchaseOrderService.sanitizeOrderItems([{ name: 'Excess discount', quantity: 1, rate: 10, discountAmount: 10.01 }]),
            /Discount cannot exceed amount/
        );
        assert.throws(
            () => purchaseOrderService.sanitizeOrderItems([{ name: 'Bad quantity', quantity: Infinity, rate: 10 }]),
            /Quantity must be greater than 0/
        );
    });
});

describe('Purchase navigation route matching', () => {
    const purchasesItem = navigationService.NAV_ITEMS.find(item => item.id === 'menu-purchases');

    it('matches purchase routes despite queries and trailing slashes', () => {
        for (const path of [
            '/purchases/orders',
            '/purchases/orders/?status=ACTIVE',
            '/purchases/orders/42/receive/',
            '/purchases/receipts?filter=open'
        ]) {
            assert.equal(purchasesItem.isActive(path), true, path);
        }
    });

    it('does not activate for unrelated or similarly prefixed routes', () => {
        for (const path of ['/suppliers/', '/projects/7', '/purchaseship/orders', '/documents']) {
            assert.equal(purchasesItem.isActive(path), false, path);
        }
        assert.equal(navigationService.normalizePath('/purchases/orders/?x=1'), '/purchases/orders');
    });
});
