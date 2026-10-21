'use strict';
const prisma = require('../config/prisma');

async function withStockTransaction(businessId, operation, externalTx = null) {
    const execute = async tx => {
        await tx.$queryRawUnsafe('SELECT id FROM businesses WHERE id = ? FOR UPDATE', businessId);
        return operation(tx);
    };
    if (externalTx) return execute(externalTx);
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return await prisma.$transaction(execute); }
        catch (error) {
            const transient = error.code === 'P2034' || error.code === 1213 || /deadlock|could not serialize access/i.test(error.message);
            if (!transient || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25));
        }
    }
}

module.exports = { withStockTransaction };
