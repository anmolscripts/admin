'use strict';
const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const registry = require('./recordRegistry');
const { ConflictError, NotFoundError } = require('./errorTypes');
function snapshot(type, record) {
    const result = {};
    for (const field of registry[type].fields) if (record[field] !== undefined) result[field] = record[field];
    return JSON.parse(JSON.stringify(result));
}
function version(type, record) {
    return crypto.createHash('sha256').update(JSON.stringify({ id: record.id, updatedAt: record.updatedAt, version: record.version, data: snapshot(type, record) })).digest('hex');
}
async function commit({ type, existing, data, actorId, expectedVersion, include, transaction }) {
    const definition = Object.hasOwn(registry,type) ? registry[type] : null;
    if (!definition) throw new Error('Unsupported record type.');
    const run = async tx => {
        await tx.$queryRawUnsafe(`SELECT id FROM \`${definition.table}\` WHERE id = ? FOR UPDATE`, existing.id);
        const current = await tx[definition.model].findUnique({ where: { id: existing.id } });
        if (!current) throw new NotFoundError('Record no longer exists.');
        if (version(type, current) !== (expectedVersion || version(type, existing))) throw new ConflictError('This record changed while you were editing. Reload it before saving.');
        const before = snapshot(type, current);
        const updated = await tx[definition.model].update({ where: { id: existing.id }, data, ...(include ? { include } : {}) });
        const after = snapshot(type, updated);
        const changes = Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(field => ({ field, before: before[field] ?? null, after: after[field] }));
        if (changes.length) {
            // Mandatory and in the same transaction: no successful unaudited update.
            await tx.userActivityLog.create({ data: {
                actorUserId: actorId || null, businessId: current.businessId || null,
                action: 'RECORD_UPDATED', module: definition.module,
                targetType: type.toUpperCase(), targetId: String(current.id),
                targetReference: String(current.name || current.code || current.symbol || current.id).slice(0,100),
                metadata: { historyVersion: 1, before, after, changes }
            } });
        }
        return updated;
    };
    return transaction ? run(transaction) : prisma.$transaction(run);
}
module.exports = { snapshot, version, commit };
