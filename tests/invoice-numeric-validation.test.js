'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoiceTotals } = require('../app/services/invoice.service');
test('invoice calculations reject non-finite quantities and rates', () => {
    for (const quantity of [Infinity, -Infinity, NaN, 'Infinity']) {
        assert.throws(() => calculateInvoiceTotals({ items: [{ name: 'Item', quantity, rate: 100 }] }), /Quantity/);
    }
    for (const rate of [Infinity, -Infinity, NaN, 'Infinity']) {
        assert.throws(() => calculateInvoiceTotals({ items: [{ name: 'Item', quantity: 1, rate }] }), /Rate/);
    }
});
