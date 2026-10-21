const itemService = require('../services/item.service');

function handleControllerError(err, res, next) {
    if (err.code === 'P2002') return res.status(409).json({ success: false, error: 'An item with this name or item code already exists in the business.' });
    if ([400,403,404,409].includes(err.statusCode)) return res.status(err.statusCode).json({success:false,error:err.message});
    if (err instanceof itemService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof itemService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof itemService.ConflictError) {
        return res.status(409).json({ success: false, error: err.message });
    }
    console.error('[ITEM CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /api/items/search
 * Debounced autocomplete endpoint for document editor
 */
async function searchItems(req, res, next) {
    try {
        const { q, limit, active } = req.query;
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) {
            return res.status(400).json({ success: false, error: 'Business context required.' });
        }
        const activeOnly = active !== 'false' && active !== false;
        const items = await itemService.searchItems({
            query: q || '',
            activeOnly,
            limit: limit ? parseInt(limit, 10) : 10,
            businessId
        });

        return res.status(200).json({
            success: true,
            data: items
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/items
 * List items with pagination and search
 */
async function listItems(req, res, next) {
    try {
        const { search, active, page, limit } = req.query;
        const result = await itemService.listItems({ businessId:req.businessId,
            search,
            active,
            page,
            limit
        });

        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/items/:id
 * Retrieve a single item
 */
async function getItem(req, res, next) {
    try {
        const item = await itemService.getItemById(req.params.id);
        return res.status(200).json({
            success: true,
            data: item
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/items
 * Create a new item
 */
async function createItem(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const item = await itemService.createItem({ ...req.body, businessId: req.businessId }, userId);
        return res.status(201).json({
            success: true,
            data: item
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * PUT /api/items/:id
 * Update an item
 */
async function updateItem(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const item = await itemService.updateItem(req.params.id, req.body, userId);
        return res.status(200).json({
            success: true,
            data: item
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/items/import/preview
 * Dry-run parse and validate CSV without database mutations
 */
async function previewImport(req, res, next) {
    try {
        let { csvContent } = req.body;
        if (req.file) {
            try {
                const rows = await require('../services/itemTransfer.service').readImport(req.file.buffer, req.file.originalname);
                csvContent = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
            } catch (error) { throw new itemService.ValidationError(error.message); }
        }
        const result = await itemService.parseAndValidateItemCsv(csvContent,req.businessId);
        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

async function exportItems(req, res, next) {
    try {
        const transfer = require('../services/itemTransfer.service');
        const format = req.query.format || 'xlsx';
        if (!['xlsx','csv','pdf','print'].includes(format)) throw new itemService.ValidationError('Choose Excel, CSV, PDF or print.');
        if (!req.businessId) throw new itemService.ValidationError('Business context required.');
        const where = { businessId: Number(req.businessId) };
        if (req.query.search) where.OR = ['name','description','hsnSac','itemCode'].map(key => ({ [key]: { contains: String(req.query.search) } }));
        if (['true','false'].includes(req.query.active)) where.active = req.query.active === 'true';
        const items = await require('../config/prisma').item.findMany({ where, orderBy: { name: 'asc' } });
        const branding = await require('../services/businessProfile.service').getBranding(req.businessId);
        if (format === 'print') return res.type('html').send(transfer.printHtml(items, branding));
        res.attachment(`item-list.${format}`);
        if (format === 'pdf') return res.type('pdf').send(await transfer.pdf(items, branding));
        const workbook = await transfer.workbookFor(items, branding);
        if (format === 'csv') return res.type('text/csv').send(Buffer.concat([Buffer.from('\uFEFF'), await workbook.csv.writeBuffer()]));
        return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await workbook.xlsx.writeBuffer());
    } catch (error) { return handleControllerError(error, res, next); }
}

async function importSample(req, res, next) {
    try {
        const format = req.query.format || 'csv';
        if (!['csv','xlsx'].includes(format)) throw new itemService.ValidationError('Choose CSV or Excel.');
        const book = await require('../services/itemTransfer.service').workbookFor([], {}, true);
        res.attachment(`item-import-sample.${format}`);
        if (format === 'csv') return res.type('text/csv').send(await book.csv.writeBuffer());
        return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await book.xlsx.writeBuffer());
    } catch (error) { return handleControllerError(error, res, next); }
}

/**
 * POST /api/items/import/commit
 * Transactionally commits validated import rows
 */
async function commitImport(req, res, next) {
    try {
        const { rows } = req.body;
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (Array.isArray(rows) && rows.some(row=>row.action==='UPDATE') && !req.userPermissions?.hasPermission('ITEMS','EDIT')) return res.status(403).json({success:false,error:'Your role cannot update existing items.'});
        const result = await itemService.importItemsFromCsv(rows, userId, req.businessId);
        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

module.exports = {
    exportItems,
    importSample,
    searchItems,
    listItems,
    getItem,
    createItem,
    updateItem,
    previewImport,
    commitImport
};
