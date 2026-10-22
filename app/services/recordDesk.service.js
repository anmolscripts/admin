'use strict';
const prisma = require('../config/prisma');
const registry = require('./recordRegistry');
const history = require('./recordHistory.service');
const { ValidationError, NotFoundError, ForbiddenError, ConflictError } = require('./errorTypes');
function definition(type) {
    if (!Object.hasOwn(registry, type)) throw new NotFoundError('This record type is not supported.');
    return registry[type];
}
const financialProjectFields=new Set(['contractValue','budgetAmount','budgetMaterials','budgetLabour','budgetSubcontractor','budgetExpenses','hourlyRate','costRate']);
function visibleFields(type,context) {
    return definition(type).fields.filter(field=>type!=='project' || !financialProjectFields.has(field) || context.permissions.hasPermission('PROJECTS','FINANCIALS_VIEW'));
}
async function authorized(type, id, businessId, db = prisma) {
    const def = definition(type);
    if (!businessId) throw new ValidationError('Select a business before opening a record.');
    if (!/^\d+$/.test(String(id)) || Number(id) < 1) throw new ValidationError('Invalid record ID.');
    const record = await db[def.model].findUnique({ where: { id: Number(id) } });
    if (!record) throw new NotFoundError('Record not found in the current business.');
    let owner = record.businessId;
    if (owner === undefined && record.projectId) owner = (await db.project.findUnique({ where: { id: record.projectId }, select: { businessId: true } }))?.businessId;
    if ((owner || 1) !== Number(businessId)) throw new NotFoundError('Record not found in the current business.');
    return record;
}
function locked(type, record) {
    if (['VOID','DELETED','CLOSED','CANCELLED','ARCHIVED'].includes(record.status)) return 'This record is locked by its lifecycle status.';
    if (type === 'invoice') return null;
    if (!definition(type).edit.length) return 'Use this module’s dedicated approval, correction or management workflow to make permitted changes.';
    return null;
}
async function inspect(type, id, context) {
    const def = definition(type), record = await authorized(type,id,context.businessId);
    const reason = locked(type,record);
    const allowed = context.permissions.hasPermission(def.module,def.editAction);
    const fields=visibleFields(type,context);
    const data = Object.fromEntries(Object.entries(history.snapshot(type,record)).filter(([key])=>fields.includes(key)));
    for (const key of ['CREATED_BY','CREATED_AT','IP_ADDRESS']) data[key] = record[key] ?? null;
    const result = { type, id:record.id, title: `${def.title}: ${record.name || record.invoiceNumber || record.code || record.symbol || record.id}`,
        data, fields:[...def.fields.filter(key => data[key] !== undefined), 'CREATED_BY','CREATED_AT','IP_ADDRESS'], editableFields:def.edit,
        version:history.version(type,record), canEdit:allowed && !reason, lockReason:reason || (!allowed ? 'Your role has view access only.' : null),
        url:def.page ? `${def.page}/${record.id}` : null,
        editorUrl:type === 'invoice' && allowed && !reason ? `/documents/${record.id}/edit?embedded=1` : null };
    if (['invoice','purchaseOrder','supplierBill','goodsReceipt','creditDebitNote'].includes(type)) {
        const full = await prisma[def.model].findUnique({ where:{id:record.id},include:{items:true} });
        result.items = full.items.map(item => Object.fromEntries(['name','quantity','unit','rate','amount','hsnSac','gstRate','taxableAmount','totalAmount'].filter(key => item[key] !== undefined).map(key => [key,item[key]])));
    }
    return result;
}
async function update(type,id,payload,context) {
    const def = definition(type), record = await authorized(type,id,context.businessId);
    if (!context.permissions.hasPermission(def.module,def.editAction)) throw new ForbiddenError('Your role cannot edit this record.');
    const reason = locked(type,record);
    if (reason || !def.edit.length) throw new ConflictError(reason || 'Use the document editor.');
    if (typeof payload.version !== 'string' || !/^[a-f0-9]{64}$/.test(payload.version)) throw new ConflictError('Reload this record before editing.');
    const data = {};
    for (const key of Object.keys(payload.changes || {})) {
        if (!def.edit.includes(key)) throw new ValidationError(`Field ${key} cannot be edited here.`);
        let value = payload.changes[key];
        if (key === 'active') { if(typeof value !== 'boolean') throw new ValidationError('Active must be true or false.'); }
        else if (['rate','gstRate'].includes(key)) {
            value = Number(value);
            if (!Number.isFinite(value) || value < 0 || (key === 'gstRate' && ![0,0.1,0.25,1,1.5,3,5,6,7.5,12,18,28].includes(value))) throw new ValidationError(`Invalid ${key}.`);
        } else {
            if (value !== null && typeof value !== 'string') throw new ValidationError(`Invalid ${key}.`);
            value = String(value ?? '').trim();
            const max = ['description','address','billingAddress','shippingAddress'].includes(key) ? 65535 : key==='name' ? (type==='item'?500:type==='unit'?100:191) : key==='phone'?50:key==='stateCode'?5:key==='gstin'?20:key==='symbol'||key==='unit'?30:key==='hsnSac'?20:255;
            if (value.length > max) throw new ValidationError(`${key} exceeds ${max} characters.`);
            if (['name','symbol','unit'].includes(key) && !value) throw new ValidationError(`${key} is required.`);
        }
        data[key] = value;
    }
    if (!Object.keys(data).length) throw new ValidationError('No changes were supplied.');
    data._recordVersion = payload.version;
    const actor = context.userId;
    const services = {
        client:()=>require('./client.service').updateClient(id,data,actor),
        item:()=>require('./item.service').updateItem(id,data,actor),
        unit:()=>require('./unit.service').updateUnit(id,data,actor),
        supplier:()=>require('./supplier.service').updateSupplier(id,data,actor,context.businessId),
        project:()=>require('./project.service').updateProject(id,data,actor,context.businessId)
    };
    await services[type]();
    return inspect(type,id,context);
}
async function listHistory(type,id,context,page=1) {
    const record = await authorized(type,id,context.businessId);
    const pageNumber=Math.max(1,Number.parseInt(page,10)||1),take=25;
    if(type === 'invoice') {
        const where={invoiceId:record.id};
        const [total,revisions]=await Promise.all([prisma.invoiceRevision.count({where}),prisma.invoiceRevision.findMany({where,orderBy:{revisionNo:'desc'},skip:(pageNumber-1)*take,take:take+1,select:{id:true,revisionNo:true,action:true,changedAt:true,snapshot:true,changedBy:{select:{name:true}}}})]);
        const entries=revisions.slice(0,take).map((row,index)=>{
            const before=revisions[index+1]?.snapshot, after=row.snapshot || {};
            const fields=[...definition(type).fields,'items'];
            const changes=before ? fields.filter(field=>JSON.stringify(before[field])!==JSON.stringify(after[field])).map(field=>({field,before:before[field]??null,after:after[field]??null})) : [];
            return {id:row.id,action:`${row.action} · revision ${row.revisionNo}`,at:row.changedAt,actor:row.changedBy?.name || 'System',changes,description:before?null:'Initial retained document revision.'};
        });
        return {total,page:pageNumber,totalPages:Math.max(1,Math.ceil(total/take)),entries};
    }
    const legacyTypes={purchaseOrder:'PURCHASE_ORDER',supplierBill:'SUPPLIER_BILL',goodsReceipt:'GOODS_RECEIPT',supplierPayment:'SUPPLIER_PAYMENT',otherIncome:'OTHER_INCOME',stockMovement:'STOCK_MOVEMENT',journalEntry:'JOURNAL_ENTRY',creditDebitNote:`${record.noteType}_NOTE`};
    const where={ targetId:String(record.id),targetType:{in:[type.toUpperCase(),legacyTypes[type] || type.toUpperCase()]},OR:[{businessId:record.businessId || null},{businessId:null}] };
    const [total,entries] = await Promise.all([
        prisma.userActivityLog.count({where}),
        prisma.userActivityLog.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(pageNumber-1)*take,take,select:{id:true,action:true,createdAt:true,metadata:true,actorUser:{select:{name:true}}}})
    ]);
    // Only release the field history allowlist, never arbitrary audit metadata.
    const allowed=new Set(visibleFields(type,context));
    return { total,page:pageNumber,totalPages:Math.max(1,Math.ceil(total/take)),entries:entries.map(row=>({id:row.id,action:row.action,at:row.createdAt,actor:row.actorUser?.name || 'System',changes:Array.isArray(row.metadata?.changes)?row.metadata.changes.filter(change=>allowed.has(change.field)):[],description:row.metadata?.historyVersion ? null : 'Activity recorded; a field snapshot was not captured by the earlier workflow.'})) };
}
module.exports={ definition,authorized,inspect,update,listHistory };
