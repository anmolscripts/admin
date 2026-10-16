const paymentService = require('../services/payment.service');
const postingService = require('../services/accounting/posting.service');

function getRequestMeta(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket ? req.socket.remoteAddress : null);
    const userAgent = req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 255) : null;
    return { ipAddress: ip || '127.0.0.1', userAgent, businessId: req.businessId };
}

function handleControllerError(err, res) {
    if (err instanceof paymentService.ValidationError || err instanceof postingService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof paymentService.NotFoundError || err instanceof postingService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof postingService.ConflictError) {
        return res.status(409).json({ success: false, error: err.message });
    }
    console.error('[PAYMENT CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /api/invoices/:id/payments
 */
async function getInvoicePayments(req, res) {
    try {
        const payments = await paymentService.getInvoicePayments(req.params.id);
        return res.status(200).json({ success: true, data: payments });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * POST /api/invoices/:id/payments
 */
async function recordPayment(req, res) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }
        const result = await paymentService.recordPayment(req.params.id, req.body, userId, getRequestMeta(req));
        return res.status(201).json({ success: true, data: result });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * POST /api/payments/:id/void
 */
async function voidPayment(req, res) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }
        const { reason } = req.body || {};
        const result = await paymentService.voidPayment(req.params.id, userId, reason, getRequestMeta(req));
        return res.status(200).json({ success: true, data: result });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * POST /api/payments/:id/post
 * Explicit manual / backfill posting endpoint for a payment
 */
async function postPaymentAccounting(req, res) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }
        const { depositAccountId } = req.body || {};
        const result = await postingService.postPayment(req.params.id, { userId, depositAccountId });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * GET /api/payments/:id/accounting
 * Retrieve ledger journal entry and status for a payment
 */
async function getPaymentAccounting(req, res) {
    try {
        const status = await postingService.getPaymentAccountingStatus(req.params.id);
        const journal = await postingService.getPaymentPosting(req.params.id);
        return res.status(200).json({
            success: true,
            status,
            journal
        });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

module.exports = {
    getInvoicePayments,
    recordPayment,
    voidPayment,
    postPaymentAccounting,
    getPaymentAccounting
};
