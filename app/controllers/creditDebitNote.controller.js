'use strict';

const creditDebitNoteService = require('../services/creditDebitNote.service');
const postingService = require('../services/accounting/posting.service');

function getClientMeta(req) {
    return {
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1',
        userAgent: req.headers['user-agent'] || 'Unknown'
    };
}

async function listNotes(req, res) {
    try {
        const result = await creditDebitNoteService.listCreditDebitNotes({ ...req.query, businessId: req.businessId });
        return res.json({
            success: true,
            ...result
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

async function getNote(req, res) {
    try {
        const note = await creditDebitNoteService.getCreditDebitNoteById(req.params.id);
        return res.json({
            success: true,
            note
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

async function createNote(req, res) {
    try {
        const invoiceId = req.params.id || req.body.invoiceId;
        const data = {
            ...req.body,
            invoiceId,
            businessId: req.businessId
        };
        const userId = req.session?.user?.id || req.user?.id || 1;
        const meta = getClientMeta(req);

        const result = await creditDebitNoteService.createCreditDebitNote(data, userId, meta);
        return res.status(201).json({
            success: true,
            note: result.note,
            journal: result.journal
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

async function voidNote(req, res) {
    try {
        const userId = req.session?.user?.id || req.user?.id || 1;
        const reason = req.body?.reason || '';
        const meta = getClientMeta(req);

        const result = await creditDebitNoteService.voidCreditDebitNote(req.params.id, userId, reason, meta);
        return res.json({
            success: true,
            note: result.note,
            reversalJournal: result.reversalJournal
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

async function getInvoiceNotes(req, res) {
    try {
        const invoiceId = parseInt(req.params.id, 10);
        const result = await creditDebitNoteService.listCreditDebitNotes({ invoiceId, businessId: req.businessId });
        return res.json({
            success: true,
            notes: result.notes
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

async function getNoteAccounting(req, res) {
    try {
        const note = await creditDebitNoteService.getCreditDebitNoteById(req.params.id);
        const journal = await postingService.getCreditDebitNotePosting(note.noteType, note.id);
        const status = await postingService.getCreditDebitNoteAccountingStatus(note.noteType, note.id);

        return res.json({
            success: true,
            accounting: {
                ...status,
                journal
            }
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

async function postNoteAccounting(req, res) {
    try {
        const userId = req.session?.user?.id || req.user?.id || 1;
        const result = await postingService.postCreditDebitNote(req.params.id, { userId });

        return res.json({
            success: true,
            alreadyPosted: Boolean(result.alreadyPosted),
            journal: result.journal
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    }
}

module.exports = {
    listNotes,
    getNote,
    createNote,
    voidNote,
    getInvoiceNotes,
    getNoteAccounting,
    postNoteAccounting
};
