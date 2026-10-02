const prisma = require('../config/prisma');

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
async function searchItems({ query = '', activeOnly = true, limit = 10 } = {}) {
    const q = (query || '').trim();
    const where = {};

    if (activeOnly) {
        where.active = true;
    }

    if (q) {
        where.name = {
            contains: q
        };
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
async function listItems({ search = '', active, page = 1, limit = 20 } = {}) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const where = {};
    if (active !== undefined && active !== '') {
        where.active = active === 'true' || active === true;
    }

    const q = (search || '').trim();
    if (q) {
        where.OR = [
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

    const unit = (data.unit || 'PCS').toString().trim().toUpperCase() || 'PCS';
    const description = data.description ? data.description.toString().trim() : null;
    const hsnSac = data.hsnSac ? data.hsnSac.toString().trim() : null;
    const active = data.active !== undefined ? (data.active === 'true' || data.active === true) : true;

    // Check if an item with identical name already exists
    const existing = await prisma.item.findFirst({
        where: {
            name: { equals: name }
        }
    });

    if (existing) {
        throw new ConflictError(`Item with name "${name}" already exists.`);
    }

    try {
        const item = await prisma.item.create({
            data: {
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

        return {
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
        };
    } catch (err) {
        if (err.code === 'P2002' || (err.message && err.message.includes('Unique constraint'))) {
            throw new ConflictError(`Item with name "${name}" already exists.`);
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
        updateData.unit = (data.unit || 'PCS').toString().trim().toUpperCase() || 'PCS';
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
        const updated = await prisma.item.update({
            where: { id: numericId },
            data: updateData
        });

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
async function ensureItemsExistFromDocument(items, userId, tx = prisma) {
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
        const rawName = item.name;
        const name = normaliseItemName(rawName);
        if (!name) continue;

        try {
            // Check if item already exists with matching name
            const existing = await tx.item.findUnique({
                where: { name }
            });

            if (!existing) {
                const rate = item.rate !== undefined && !isNaN(parseFloat(item.rate))
                    ? Math.max(parseFloat(item.rate), 0)
                    : 0;
                const unit = (item.unit || 'PCS').toString().trim().toUpperCase() || 'PCS';
                const hsnSac = item.hsnSac ? item.hsnSac.toString().trim() : null;

                await tx.item.create({
                    data: {
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
    ensureItemsExistFromDocument
};
