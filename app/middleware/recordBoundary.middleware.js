'use strict';
const desk = require('../services/recordDesk.service');
const requireAuth = require('./auth.middleware');
const businessContext = require('./businessContext.middleware');
const businessService = require('../services/business.service');
const prisma = require('../config/prisma');
const { ValidationError } = require('../services/errorTypes');
const types = { clients:'client',items:'item',units:'unit',invoices:'invoice',documents:'invoice',payments:'payment','credit-debit-notes':'creditDebitNote',journals:'journalEntry' };
module.exports = (req,res,next) => {
    const match = req.path.match(/^\/(?:api\/|reports\/)?(clients|items|units|invoices|documents|payments|credit-debit-notes|journals)(?:\/([^/]+))?(?:\/|$)/i);
    if (!match) return next();
    const resource = match[1].toLowerCase();
    if (resource === 'documents' && match[2]?.toLowerCase() === 'letters') return next();
    return requireAuth(req,res,async () => {
        // Remember-cookie authentication can happen after the global business resolver.
        const authorize = async () => {
            try {
                if (!req.businessId) throw new ValidationError('Select a business before opening a record.');
                await businessService.assertUserBusinessAccess(req.session.user.id, req.businessId);
                let id;
                try { id = match[2] ? decodeURIComponent(match[2]) : null; }
                catch (_) { throw new ValidationError('Invalid record ID.'); }
                if (id && !['new','export','kpis','search','import','active'].includes(id.toLowerCase())) {
                    if (!/^\d+$/.test(id)) throw new ValidationError('Invalid record ID.');
                    const type = types[resource];
                    const record = await desk.authorized(type,id,req.businessId);
                    if (type === 'payment') await desk.authorized('invoice',record.invoiceId,req.businessId);
                    if (type === 'invoice' || type === 'payment') {
                        const journal = await prisma.journalEntry.findUnique({ where: { idempotencyKey: `${type.toUpperCase()}:${record.id}` }, select: { id: true } });
                        if (journal) await desk.authorized('journalEntry',journal.id,req.businessId);
                    }
                }
                if (resource === 'documents' && req.query.copyFrom) await desk.authorized('invoice',req.query.copyFrom,req.businessId);
                if (resource === 'credit-debit-notes' && req.query.invoiceId) await desk.authorized('invoice',req.query.invoiceId,req.businessId);
                if (resource === 'credit-debit-notes' && req.body?.invoiceId) await desk.authorized('invoice',req.body.invoiceId,req.businessId);
                next();
            } catch(error) {
                if (types[resource] === 'invoice' && error.statusCode === 404) error.message = 'Document was not found in the current business.';
                next(error);
            }
        };
        if (!req.businessId) return businessContext(req,res,authorize);
        return authorize();
    });
};
