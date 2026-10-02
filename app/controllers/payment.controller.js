const paymentService = require('../services/payment.service');

function getRequestMeta(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket ? req.socket.remoteAddress : null);
    const userAgent = req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 255) : null;
    return { ipAddress: ip || '127.0.0.1', userAgent };
}

function handleControllerError(err, res) {
    if (err instanceof paymentService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof paymentService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
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

module.exports = {
    getInvoicePayments,
    recordPayment,
    voidPayment
};
