const prisma = require('../config/prisma');
const activityService = require('./activity.service');

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
        this.statusCode = 409;
    }
}

/**
 * Normalise unit symbol (trimmed, preserve case)
 */
function normaliseUnitSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') return '';
    return symbol.trim();
}

/**
 * Format unit record for responses
 */
function formatUnitResponse(unit) {
    if (!unit) return null;
    return {
        id: unit.id,
        name: unit.name,
        symbol: unit.symbol,
        description: unit.description || null,
        active: Boolean(unit.active),
        createdAt: unit.createdAt,
        updatedAt: unit.updatedAt,
        createdById: unit.createdById || null
    };
}

/**
 * Predefined default units specification
 */
const DEFAULT_UNITS = [
    { name: 'Piece', symbol: 'PCS', description: 'Standard piece count' },
    { name: 'Meter', symbol: 'm', description: 'Length in meters' },
    { name: 'Unit', symbol: 'unit', description: 'Standard unit count' },
    { name: 'Project', symbol: 'Project', description: 'Fixed price project engagement' },
    { name: 'Hours', symbol: 'Hours', description: 'Time in hours' },
    { name: 'Months', symbol: 'Months', description: 'Duration in months' },
    { name: 'Units', symbol: 'Units', description: 'Quantity count' },
    { name: 'License', symbol: 'License', description: 'Software license seat or subscription' },
    { name: 'Year', symbol: 'Year', description: 'Annual subscription or duration' },
    { name: 'Package', symbol: 'Package', description: 'Bundled package' },
    { name: 'Set', symbol: 'Set', description: 'Matched set of components' },
    { name: 'Kilogram', symbol: 'KG', description: 'Weight in kilograms' },
    { name: 'Service', symbol: 'Service', description: 'Professional service delivery' }
];

/**
 * Create a new unit in Unit Master
 */
async function createUnit(data = {}, userId = null) {
    const rawName = data.name;
    const rawSymbol = data.symbol;

    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
        throw new ValidationError('Unit name is required.');
    }
    const name = rawName.trim();
    if (name.length > 100) {
        throw new ValidationError('Unit name must not exceed 100 characters.');
    }

    if (!rawSymbol || typeof rawSymbol !== 'string' || !rawSymbol.trim()) {
        throw new ValidationError('Unit symbol is required.');
    }
    const symbol = normaliseUnitSymbol(rawSymbol);
    if (symbol.length > 30) {
        throw new ValidationError('Unit symbol must not exceed 30 characters.');
    }

    const description = data.description ? String(data.description).trim() : null;
    const active = data.active !== undefined ? (data.active === 'true' || data.active === true) : true;

    // Check duplicate symbol
    const existing = await prisma.unit.findFirst({
        where: {
            symbol: { equals: symbol }
        }
    });

    if (existing) {
        throw new ConflictError(`Unit with symbol "${symbol}" already exists.`);
    }

    try {
        const unit = await prisma.unit.create({
            data: {
                name,
                symbol,
                description,
                active,
                createdById: userId || null
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE_UNIT',
                module: 'UNITS',
                targetType: 'UNIT',
                targetId: unit.id,
                targetReference: unit.symbol
            }).catch(() => {});
        }

        return formatUnitResponse(unit);
    } catch (err) {
        if (err.code === 'P2002' || (err.message && err.message.includes('Unique constraint'))) {
            throw new ConflictError(`Unit with symbol "${symbol}" already exists.`);
        }
        throw err;
    }
}

/**
 * Get unit by ID
 */
async function getUnitById(idInput) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid unit ID.');
    }

    const unit = await prisma.unit.findUnique({
        where: { id },
        include: {
            createdBy: { select: { id: true, name: true, email: true } }
        }
    });

    if (!unit) {
        throw new NotFoundError(`Unit with ID ${id} was not found.`);
    }

    return formatUnitResponse(unit);
}

/**
 * List units with pagination, search, and active filtering
 */
async function listUnits({ search = '', active, page = 1, limit = 50 } = {}) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const where = {};
    if (active !== undefined && active !== '') {
        where.active = active === 'true' || active === true;
    }

    const q = (search || '').trim();
    if (q) {
        where.OR = [
            { name: { contains: q } },
            { symbol: { contains: q } },
            { description: { contains: q } }
        ];
    }

    const [total, units] = await Promise.all([
        prisma.unit.count({ where }),
        prisma.unit.findMany({
            where,
            skip,
            take: pageSize,
            orderBy: [
                { symbol: 'asc' }
            ]
        })
    ]);

    return {
        total,
        units: units.map(formatUnitResponse),
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize) || 1
    };
}

/**
 * Get all active units for dropdown selectors
 */
async function getActiveUnits() {
    const units = await prisma.unit.findMany({
        where: { active: true },
        orderBy: [
            { symbol: 'asc' }
        ]
    });

    return units.map(formatUnitResponse);
}

/**
 * Update an existing unit in Unit Master
 */
async function updateUnit(idInput, data = {}, userId = null) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid unit ID.');
    }

    const existing = await prisma.unit.findUnique({
        where: { id }
    });

    if (!existing) {
        throw new NotFoundError(`Unit with ID ${id} was not found.`);
    }

    const updateData = {};

    if (data.name !== undefined) {
        const name = String(data.name).trim();
        if (!name) {
            throw new ValidationError('Unit name cannot be empty.');
        }
        if (name.length > 100) {
            throw new ValidationError('Unit name must not exceed 100 characters.');
        }
        updateData.name = name;
    }

    if (data.symbol !== undefined) {
        const symbol = normaliseUnitSymbol(data.symbol);
        if (!symbol) {
            throw new ValidationError('Unit symbol cannot be empty.');
        }
        if (symbol.length > 30) {
            throw new ValidationError('Unit symbol must not exceed 30 characters.');
        }

        if (symbol.toLowerCase() !== existing.symbol.toLowerCase()) {
            const duplicate = await prisma.unit.findFirst({
                where: {
                    symbol: { equals: symbol },
                    id: { not: id }
                }
            });
            if (duplicate) {
                throw new ConflictError(`Unit with symbol "${symbol}" already exists.`);
            }
        }
        updateData.symbol = symbol;
    }

    if (data.description !== undefined) {
        updateData.description = data.description ? String(data.description).trim() : null;
    }

    if (data.active !== undefined) {
        updateData.active = data.active === 'true' || data.active === true;
    }

    try {
        const updated = await prisma.unit.update({
            where: { id },
            data: updateData
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'EDIT_UNIT',
                module: 'UNITS',
                targetType: 'UNIT',
                targetId: updated.id,
                targetReference: updated.symbol
            }).catch(() => {});
        }

        return formatUnitResponse(updated);
    } catch (err) {
        if (err.code === 'P2002' || (err.message && err.message.includes('Unique constraint'))) {
            throw new ConflictError(`Unit with symbol "${updateData.symbol || existing.symbol}" already exists.`);
        }
        throw err;
    }
}

/**
 * Toggle active status of a unit
 */
async function toggleUnitStatus(idInput, userId = null) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid unit ID.');
    }

    const existing = await prisma.unit.findUnique({
        where: { id }
    });

    if (!existing) {
        throw new NotFoundError(`Unit with ID ${id} was not found.`);
    }

    const updated = await prisma.unit.update({
        where: { id },
        data: { active: !existing.active }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: updated.active ? 'ACTIVATE_UNIT' : 'DEACTIVATE_UNIT',
            module: 'UNITS',
            targetType: 'UNIT',
            targetId: updated.id,
            targetReference: updated.symbol,
            metadata: { active: updated.active }
        }).catch(() => {});
    }

    return formatUnitResponse(updated);
}

/**
 * Delete a unit from Unit Master
 */
async function deleteUnit(idInput, userId = null) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid unit ID.');
    }

    const existing = await prisma.unit.findUnique({
        where: { id }
    });

    if (!existing) {
        throw new NotFoundError(`Unit with ID ${id} was not found.`);
    }

    await prisma.unit.delete({
        where: { id }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'DELETE_UNIT',
            module: 'UNITS',
            targetType: 'UNIT',
            targetId: existing.id,
            targetReference: existing.symbol
        }).catch(() => {});
    }

    return { success: true, message: `Unit "${existing.symbol}" deleted.` };
}

/**
 * Idempotently seed default units
 */
async function seedDefaultUnits(userId = null) {
    let createdCount = 0;
    for (const u of DEFAULT_UNITS) {
        const exists = await prisma.unit.findFirst({
            where: {
                symbol: { equals: u.symbol }
            }
        });
        if (!exists) {
            await prisma.unit.create({
                data: {
                    name: u.name,
                    symbol: u.symbol,
                    description: u.description,
                    active: true,
                    createdById: userId || null
                }
            });
            createdCount++;
        }
    }
    return createdCount;
}

module.exports = {
    ValidationError,
    NotFoundError,
    ConflictError,
    DEFAULT_UNITS,
    normaliseUnitSymbol,
    createUnit,
    getUnitById,
    listUnits,
    getActiveUnits,
    updateUnit,
    toggleUnitStatus,
    deleteUnit,
    seedDefaultUnits
};
