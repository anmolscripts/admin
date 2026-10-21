'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

function stamp(model, data, creating, models, inheritedActor = null) {
    if (Array.isArray(data)) return data.forEach(row => stamp(model, row, creating, models, inheritedActor));
    if (!data || typeof data !== 'object') return;
    const request = context.getStore();
    const actor = request?.session?.user?.id || inheritedActor || data.createdById || data.createdBy?.connect?.id || data.changedById || data.uploadedById || data.receivedById || data.actorUserId || data.postedById || null;
    // Request metadata is authoritative; import/body fields cannot forge creation history.
    delete data.CREATED_BY;
    delete data.CREATED_AT;
    delete data.IP_ADDRESS;
    if (creating) {
        data.CREATED_BY = actor;
        data.IP_ADDRESS = request?.ip ? String(request.ip).slice(0, 45) : null;
    }
    for (const field of models[model]?.fields || []) {
        if (field.kind !== 'object' || !data[field.name]) continue;
        const nested = data[field.name];
        if (nested.create) stamp(field.type, nested.create, true, models, actor);
        if (nested.createMany?.data) stamp(field.type, nested.createMany.data, true, models, actor);
        for (const entry of [].concat(nested.connectOrCreate || [])) stamp(field.type, entry.create, true, models, actor);
        for (const entry of [].concat(nested.upsert || [])) {
            stamp(field.type, entry.create, true, models, actor);
            stamp(field.type, entry.update, false, models, actor);
        }
        for (const entry of [].concat(nested.update || [])) stamp(field.type, entry.data || entry, false, models, actor);
        for (const entry of [].concat(nested.updateMany || [])) stamp(field.type, entry.data, false, models, actor);
    }
}

function extension(Prisma) {
    const models = Object.fromEntries(Prisma.dmmf.datamodel.models.map(model => [model.name, model]));
    return { query: { $allModels: { async $allOperations({ model, operation, args, query }) {
        if (['create','createMany','createManyAndReturn'].includes(operation)) stamp(model, args.data, true, models);
        if (['update','updateMany','updateManyAndReturn'].includes(operation)) stamp(model, args.data, false, models);
        if (operation === 'upsert') {
            stamp(model, args.create, true, models);
            stamp(model, args.update, false, models);
        }
        return query(args);
    } } } };
}

module.exports = { context, stamp, extension };
