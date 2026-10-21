const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const numberingService = require('./numbering.service');
const businessService = require('./business.service');

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
    }
}

class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
    }
}

/**
 * Normalise item name for consistent matching (trimmed, collapsed whitespace)
 */
function normaliseItemName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.trim().replace(/\s+/g, ' ');
}

/**
 * Search items in Item Master (for autocomplete and directory search)
 * @param {Object} options
 * @param {string} options.query - Search query string
 * @param {boolean} options.activeOnly - Filter by active status (default: true)
 * @param {number} options.limit - Max records to return (default: 10)
 */
async function searchItems({ query = '', activeOnly = true, limit = 10, businessId } = {}) {
    const q = (query || '').trim();
    const where = {};

    if (businessId) {
        where.businessId = parseInt(businessId, 10);
    }

    if (activeOnly) {
        where.active = true;
    }

    if (q) {
        where.OR = [
            { itemCode: { contains: q } },
            { name: { contains: q } },
            { description: { contains: q } },
            { hsnSac: { contains: q } }
        ];
    }

    const items = await prisma.item.findMany({
        where,
        take: Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50),
        orderBy: [
            { name: 'asc' }
        ]
    });

    return items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        unit: item.unit,
        rate: Number(item.rate),
        hsnSac: item.hsnSac,
        gstRate: Number(item.gstRate),
        active: item.active,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    }));
}

/**
 * List items with pagination, filtering, and search for the directory view
 */
async function listItems({ search = '', active, page = 1, limit = 20, businessId } = {}) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const where = {};
    if (businessId) {
        where.businessId = parseInt(businessId, 10);
    }
    if (active !== undefined && active !== '') {
        where.active = active === 'true' || active === true;
    }

    const q = (search || '').trim();
    if (q) {
        where.OR = [
            { itemCode: { contains: q } },
            { name: { contains: q } },
            { description: { contains: q } },
            { hsnSac: { contains: q } }
        ];
    }

    const [total, items] = await Promise.all([
        prisma.item.count({ where }),
        prisma.item.findMany({
            where,
            skip,
            take: pageSize,
            orderBy: { name: 'asc' },
            include: {
                createdBy: { select: { id: true, name: true, email: true } }
            }
        })
    ]);

    return {
        data: items.map((item) => ({
            id: item.id,
            itemCode: item.itemCode || null,
            name: item.name,
            description: item.description,
            unit: item.unit,
            rate: Number(item.rate),
            hsnSac: item.hsnSac,
            gstRate: Number(item.gstRate),
            active: item.active,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            createdBy: item.createdBy
        })),
        meta: {
            page: pageNum,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize) || 1
        }
    };
}

/**
 * Get single item by ID
 */
async function getItemById(id) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid item ID.');
    }

    const item = await prisma.item.findUnique({
        where: { id: numericId },
        include: {
            createdBy: { select: { id: true, name: true, email: true } }
        }
    });

    if (!item) {
        throw new NotFoundError(`Item with ID ${numericId} was not found.`);
    }

    return {
        id: item.id,
        itemCode: item.itemCode || null,
        name: item.name,
        description: item.description,
        unit: item.unit,
        rate: Number(item.rate),
        hsnSac: item.hsnSac,
        gstRate: Number(item.gstRate),
        active: item.active,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        createdBy: item.createdBy
    };
}

/**
 * Create a new item in Item Master
 */
async function createItem(data, userId) {
    const name = normaliseItemName(data.name);
    if (!name) {
        throw new ValidationError('Item name is required.');
    }
    if (name.length > 255) {
        throw new ValidationError('Item name cannot exceed 255 characters.');
    }

    const rate = data.rate !== undefined && data.rate !== null && data.rate !== ''
        ? parseFloat(data.rate)
        : 0;
    if (isNaN(rate) || rate < 0) {
        throw new ValidationError('Item rate must be a non-negative number.');
    }

    const gstRate = data.gstRate !== undefined && data.gstRate !== null && data.gstRate !== ''
        ? parseFloat(data.gstRate)
        : 0;
    if (isNaN(gstRate) || gstRate < 0) {
        throw new ValidationError('Item GST rate must be a non-negative number.');
    }

    const unit = (data.unit || 'PCS').toString().trim() || 'PCS';
    const description = data.description ? data.description.toString().trim() : null;
    const hsnSac = data.hsnSac ? data.hsnSac.toString().trim() : null;
    const active = data.active !== undefined ? (data.active === 'true' || data.active === true) : true;

    let rawBizId = data.businessId;
    if (!rawBizId && userId) {
        try {
            const accessible = await businessService.getUserAccessibleBusinesses(userId);
            if (accessible.length === 1) rawBizId = accessible[0].id;
        } catch (e) {}
    }
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required to create an item.');
    }
    const businessId = parseInt(rawBizId, 10);

    // Check if an item with identical name already exists for this business
    const existing = await prisma.item.findFirst({
        where: {
            businessId,
            name: { equals: name }
        }
    });

    if (existing) {
        throw new ConflictError(`Item with name "${name}" already exists.`);
    }

    let itemCode = (data.itemCode || data.sku || '').trim().toUpperCase();

    try {
        const item = await prisma.$transaction(async (tx) => {
            if (!itemCode) {
                itemCode = await numberingService.allocateNumber({
                    businessId,
                    entityType: 'ITEM',
                    tx
                });
            }

            const existingCode = await tx.item.findFirst({
                where: { businessId, itemCode }
            });
            if (existingCode) {
                throw new ConflictError(`Item code "${itemCode}" already exists.`);
            }

            return await tx.item.create({
                data: {
                    businessId,
                    itemCode,
                    name,
                    description,
                    unit,
                    rate,
                    hsnSac,
                    gstRate,
                    active,
                    createdById: userId || null
                }
            });
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE_ITEM',
                module: 'ITEMS',
                targetType: 'ITEM',
                targetId: item.id,
                targetReference: `${item.name} (${item.itemCode})`
            }).catch(() => {});
        }

        return {
            id: item.id,
            itemCode: item.itemCode || null,
            name: item.name,
            description: item.description,
            unit: item.unit,
            rate: Number(item.rate),
            hsnSac: item.hsnSac,
            gstRate: Number(item.gstRate),
            active: item.active,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            createdBy: item.createdBy
        };
    } catch (err) {
        if (err.code === 'P2002' || (err.message && err.message.includes('Unique constraint'))) {
            throw new ConflictError(`Item with name "${name}" or code "${itemCode}" already exists.`);
        }
        throw err;
    }
}

/**
 * Update an existing item in Item Master
 */
async function updateItem(id, data, userId) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid item ID.');
    }

    const existing = await prisma.item.findUnique({
        where: { id: numericId }
    });

    if (!existing) {
        throw new NotFoundError(`Item with ID ${numericId} was not found.`);
    }

    const updateData = {};

    if (data.name !== undefined) {
        const name = normaliseItemName(data.name);
        if (!name) {
            throw new ValidationError('Item name cannot be empty.');
        }
        if (name.length > 255) {
            throw new ValidationError('Item name cannot exceed 255 characters.');
        }

        // Check for duplicate name if changed
        if (name.toLowerCase() !== existing.name.toLowerCase()) {
            const dup = await prisma.item.findFirst({
                where: {
                    name: { equals: name },
                    businessId: existing.businessId,
                    id: { not: numericId }
                }
            });
            if (dup) {
                throw new ConflictError(`Another item with name "${name}" already exists.`);
            }
        }
        updateData.name = name;
    }

    if (data.rate !== undefined) {
        const rate = parseFloat(data.rate);
        if (isNaN(rate) || rate < 0) {
            throw new ValidationError('Item rate must be a non-negative number.');
        }
        updateData.rate = rate;
    }

    if (data.gstRate !== undefined) {
        const gstRate = parseFloat(data.gstRate);
        if (isNaN(gstRate) || gstRate < 0) {
            throw new ValidationError('Item GST rate must be a non-negative number.');
        }
        updateData.gstRate = gstRate;
    }

    if (data.unit !== undefined) {
        updateData.unit = (data.unit || 'PCS').toString().trim() || 'PCS';
    }

    if (data.description !== undefined) {
        updateData.description = data.description ? data.description.toString().trim() : null;
    }

    if (data.hsnSac !== undefined) {
        updateData.hsnSac = data.hsnSac ? data.hsnSac.toString().trim() : null;
    }

    if (data.active !== undefined) {
        updateData.active = data.active === 'true' || data.active === true;
    }

    try {
        const updated = await require('./recordHistory.service').commit({ type: 'item', existing, data: updateData, actorId: userId, expectedVersion: data._recordVersion });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'EDIT_ITEM',
                module: 'ITEMS',
                targetType: 'ITEM',
                targetId: updated.id,
                targetReference: updated.name
            }).catch(() => {});
        }

        return {
            id: updated.id,
            name: updated.name,
            description: updated.description,
            unit: updated.unit,
            rate: Number(updated.rate),
            hsnSac: updated.hsnSac,
            gstRate: Number(updated.gstRate),
            active: updated.active,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt
        };
    } catch (err) {
        if (err.code === 'P2002' || (err.message && err.message.includes('Unique constraint'))) {
            throw new ConflictError(`Another item with name "${updateData.name || ''}" already exists.`);
        }
        throw err;
    }
}

/**
 * Ensure line items typed on a quotation/invoice exist in Item Master.
 * Persists any previously unseen items atomically without throwing duplicate errors.
 * Preserves historical document data by keeping items separate from past snapshots.
 *
 * @param {Array} items - Array of document items { name, unit, rate, hsnSac }
 * @param {number} userId - ID of the creating user
 * @param {Object} tx - Active Prisma transaction client
 */
async function ensureItemsExistFromDocument(items, userId, tx = prisma, businessId = null) {
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
        const rawName = item.name;
        const name = normaliseItemName(rawName);
        if (!name) continue;

        try {
            const bId = businessId !== null && businessId !== undefined
                ? parseInt(businessId, 10)
                : (item.businessId ? parseInt(item.businessId, 10) : 1);

            const existing = await tx.item.findFirst({
                where: {
                    businessId: bId,
                    name
                }
            });

            if (!existing) {
                const rate = item.rate !== undefined && !isNaN(parseFloat(item.rate))
                    ? Math.max(parseFloat(item.rate), 0)
                    : 0;
                const unit = (item.unit || 'PCS').toString().trim() || 'PCS';
                const hsnSac = item.hsnSac ? item.hsnSac.toString().trim() : null;

                await tx.item.create({
                    data: {
                        businessId: bId,
                        name,
                        unit,
                        rate,
                        hsnSac,
                        active: true,
                        createdById: userId || null
                    }
                });
            }
        } catch (err) {
            // Concurrent request might have created the item; MySQL unique constraint (P2002) is caught and handled safely
            if (err.code !== 'P2002') {
                console.warn('[ITEM MASTER] Notice during auto-persist item:', err.message);
            }
        }
    }
}

/**
 * Parse CSV content and validate for dry-run preview (Phase 5 Inventory import).
 * Zero database mutations occur during preview.
 */
async function parseAndValidateItemCsv(csvContent, businessId = null) {
    if (!csvContent || typeof csvContent !== 'string') {
        throw new ValidationError('CSV content is required.');
    }

    const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
        throw new ValidationError('CSV must contain a header row and at least one data row.');
    }

    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const nameIdx = header.indexOf('name');
    const unitIdx = header.indexOf('unit');
    const rateIdx = header.indexOf('rate');
    const hsnIdx = header.indexOf('hsnsac') !== -1 ? header.indexOf('hsnsac') : header.indexOf('hsn');
    const descIdx = header.indexOf('description');
    const gstIdx = header.indexOf('gstrate') !== -1 ? header.indexOf('gstrate') : header.indexOf('gst');

    if (nameIdx === -1) {
        throw new ValidationError('CSV header must contain "name" column.');
    }

    const preview = [];
    const errors = [];
    const seenNamesInCsv = new Set();

    // Fetch existing items for delta check
    const existingItems = await prisma.item.findMany({ where: businessId ? {businessId:Number(businessId)} : {}, select: { name: true, id: true } });
    const existingMap = new Map(existingItems.map(i => [i.name.toLowerCase(), i.id]));

    let newCount = 0;
    let updateCount = 0;

    for (let i = 1; i < lines.length; i++) {
        const rowNum = i + 1;
        const cols = lines[i].split(',').map(c => c.trim());
        const rawName = cols[nameIdx] || '';
        const name = normaliseItemName(rawName);

        if (!name) {
            errors.push({ row: rowNum, error: 'Item name is required.' });
            continue;
        }

        if (name.length > 255) {
            errors.push({ row: rowNum, error: 'Item name must not exceed 255 characters.' });
            continue;
        }

        const lowerName = name.toLowerCase();
        if (seenNamesInCsv.has(lowerName)) {
            errors.push({ row: rowNum, error: `Duplicate item name "${name}" within CSV.` });
            continue;
        }
        seenNamesInCsv.add(lowerName);

        const unit = unitIdx !== -1 && cols[unitIdx] ? cols[unitIdx] : 'PCS';
        let rate = 0;
        if (rateIdx !== -1 && cols[rateIdx]) {
            rate = parseFloat(cols[rateIdx]);
            if (isNaN(rate) || rate < 0) {
                errors.push({ row: rowNum, error: 'Rate must be a non-negative number.' });
                continue;
            }
        }

        const hsnSac = hsnIdx !== -1 && cols[hsnIdx] ? cols[hsnIdx] : null;
        const description = descIdx !== -1 && cols[descIdx] ? cols[descIdx] : null;
        let gstRate = 0;
        if (gstIdx !== -1 && cols[gstIdx]) {
            gstRate = parseFloat(cols[gstIdx]);
            if (isNaN(gstRate) || gstRate < 0 || gstRate > 100) {
                errors.push({ row: rowNum, error: 'GST rate must be between 0 and 100.' });
                continue;
            }
        }

        const isUpdate = existingMap.has(lowerName);
        if (isUpdate) updateCount++;
        else newCount++;

        preview.push({
            row: rowNum,
            name,
            unit,
            rate,
            hsnSac,
            description,
            gstRate,
            action: isUpdate ? 'UPDATE' : 'CREATE',
            existingId: isUpdate ? existingMap.get(lowerName) : null
        });
    }

    return {
        summary: {
            totalRows: lines.length - 1,
            validCount: preview.length,
            invalidCount: errors.length,
            newCount,
            updateCount
        },
        preview,
        errors
    };
}

/**
 * Commits previously validated CSV import rows transactionally.
 */
async function importItemsFromCsv(validRows = [], userId = null, businessId = null) {
    if (!Array.isArray(validRows) || validRows.length === 0) {
        throw new ValidationError('No valid rows provided for import.');
    }
    if(validRows.length > 1000) throw new ValidationError('Import at most 1,000 items at a time.');
    for(const row of validRows) {
        if(!row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 191 || !['CREATE','UPDATE'].includes(row.action)) throw new ValidationError('Invalid import item.');
        for(const field of ['rate','gstRate']) if(!Number.isFinite(Number(row[field] ?? 0)) || Number(row[field] ?? 0) < 0 || (field==='gstRate' && Number(row[field] ?? 0)>100)) throw new ValidationError(`Invalid import ${field}.`);
        if(row.action==='UPDATE' && !Number.isSafeInteger(Number(row.existingId))) throw new ValidationError('Invalid existing item ID.');
    }

    return prisma.$transaction(async (tx) => {
        let created = 0;
        let updated = 0;

        for (const row of validRows) {
            if (row.action === 'UPDATE' && row.existingId) {
                const existing=await tx.item.findUnique({where:{id:Number(row.existingId)}});
                if(!existing || (businessId && existing.businessId!==Number(businessId))) throw new NotFoundError('Item not found in the current business.');
                await require('./recordHistory.service').commit({type:'item',existing,actorId:userId,transaction:tx,
                    data: {
                        unit: row.unit || 'PCS',
                        rate: row.rate || 0,
                        hsnSac: row.hsnSac || null,
                        description: row.description || null,
                        gstRate: row.gstRate || 0
                    }
                });
                updated++;
            } else {
                await tx.item.create({
                    data: {
                        businessId: businessId ? Number(businessId) : null,
                        name: row.name,
                        unit: row.unit || 'PCS',
                        rate: row.rate || 0,
                        hsnSac: row.hsnSac || null,
                        description: row.description || null,
                        gstRate: row.gstRate || 0,
                        active: true,
                        createdById: userId
                    }
                });
                created++;
            }
        }

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE',
                module: 'ITEMS',
                targetType: 'ITEM',
                description: `Imported ${created} new items, updated ${updated} existing items via CSV`
            });
        }

        return { created, updated, total: created + updated };
    });
}

module.exports = {
    ValidationError,
    NotFoundError,
    ConflictError,
    normaliseItemName,
    searchItems,
    listItems,
    getItemById,
    createItem,
    updateItem,
    ensureItemsExistFromDocument,
    parseAndValidateItemCsv,
    importItemsFromCsv
};

