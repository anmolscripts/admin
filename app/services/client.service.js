const prisma = require('../config/prisma');

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

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]{4,30}$/;

function validateClientEmail(email) {
    if (email === undefined || email === null) return null;
    const str = String(email).trim();
    if (!str) return null;
    if (str.length > 191) {
        throw new ValidationError('Client email must not exceed 191 characters.');
    }
    if (!EMAIL_REGEX.test(str)) {
        throw new ValidationError('Invalid client email format.');
    }
    return str;
}

function validateClientPhone(phone) {
    if (phone === undefined || phone === null) return null;
    const str = String(phone).trim();
    if (!str) return null;
    if (str.length > 50) {
        throw new ValidationError('Client phone number must not exceed 50 characters.');
    }
    if (!PHONE_REGEX.test(str)) {
        throw new ValidationError('Invalid client phone number format.');
    }
    return str;
}

function formatClientResponse(client) {
    if (!client) return null;
    return {
        ...client,
        isActive: client.active
    };
}

/**
 * Create a new client
 */
async function createClient(data = {}, userId = null) {
    const name = (data.name || '').trim();
    if (!name) {
        throw new ValidationError('Client name is required.');
    }
    if (name.length > 191) {
        throw new ValidationError('Client name must not exceed 191 characters.');
    }

    let gstin = data.gstin ? data.gstin.trim().toUpperCase() : null;
    if (gstin && !GSTIN_REGEX.test(gstin)) {
        throw new ValidationError('Invalid GSTIN format. Expected 15-character Indian GSTIN (e.g. 27AAACT2727Q1ZW).');
    }

    let stateCode = data.stateCode ? data.stateCode.trim() : null;
    if (!stateCode && gstin) {
        stateCode = gstin.substring(0, 2);
    }

    const email = validateClientEmail(data.email);
    const phone = validateClientPhone(data.phone);
    const billingAddress = data.billingAddress ? data.billingAddress.trim() : null;
    const shippingAddress = data.shippingAddress ? data.shippingAddress.trim() : null;

    const client = await prisma.client.create({
        data: {
            name,
            email,
            phone,
            gstin,
            stateCode,
            billingAddress,
            shippingAddress,
            active: data.active !== undefined ? Boolean(data.active) : true,
            createdById: userId
        }
    });

    return formatClientResponse(client);
}

/**
 * Get client by ID
 */
async function getClientById(idInput) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid client ID.');
    }

    const client = await prisma.client.findUnique({
        where: { id },
        include: {
            createdBy: { select: { id: true, name: true, email: true } },
            _count: { select: { invoices: true } }
        }
    });

    if (!client) {
        throw new NotFoundError(`Client with ID ${id} not found.`);
    }

    return formatClientResponse(client);
}

/**
 * Update client details
 */
async function updateClient(idInput, data = {}) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid client ID.');
    }

    const existing = await prisma.client.findUnique({ where: { id } });
    if (!existing) {
        throw new NotFoundError(`Client with ID ${id} not found.`);
    }

    const updateData = {};

    if (data.name !== undefined) {
        const name = (data.name || '').trim();
        if (!name) {
            throw new ValidationError('Client name cannot be empty.');
        }
        updateData.name = name;
    }

    if (data.gstin !== undefined) {
        const gstin = data.gstin ? data.gstin.trim().toUpperCase() : null;
        if (gstin && !GSTIN_REGEX.test(gstin)) {
            throw new ValidationError('Invalid GSTIN format. Expected 15-character Indian GSTIN (e.g. 27AAACT2727Q1ZW).');
        }
        updateData.gstin = gstin;
        if (gstin && !data.stateCode && !existing.stateCode) {
            updateData.stateCode = gstin.substring(0, 2);
        }
    }

    if (data.stateCode !== undefined) updateData.stateCode = data.stateCode ? data.stateCode.trim() : null;
    if (data.email !== undefined) updateData.email = validateClientEmail(data.email);
    if (data.phone !== undefined) updateData.phone = validateClientPhone(data.phone);
    if (data.billingAddress !== undefined) updateData.billingAddress = data.billingAddress ? data.billingAddress.trim() : null;
    if (data.shippingAddress !== undefined) updateData.shippingAddress = data.shippingAddress ? data.shippingAddress.trim() : null;
    if (data.active !== undefined) updateData.active = Boolean(data.active);

    const updated = await prisma.client.update({
        where: { id },
        data: updateData
    });

    return formatClientResponse(updated);
}

/**
 * Toggle active status of a client
 */
async function toggleClientStatus(idInput) {
    const id = parseInt(idInput, 10);
    if (isNaN(id) || id <= 0) {
        throw new ValidationError('Invalid client ID.');
    }

    const existing = await prisma.client.findUnique({ where: { id } });
    if (!existing) {
        throw new NotFoundError(`Client with ID ${id} not found.`);
    }

    const updated = await prisma.client.update({
        where: { id },
        data: { active: !existing.active }
    });

    return formatClientResponse(updated);
}

/**
 * List clients with pagination and filters
 */
async function listClients(options = {}) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const where = {};

    if (options.active !== undefined && options.active !== '') {
        where.active = options.active === 'true' || options.active === true;
    }

    if (options.search) {
        const query = options.search.trim();
        where.OR = [
            { name: { contains: query } },
            { email: { contains: query } },
            { phone: { contains: query } },
            { gstin: { contains: query } }
        ];
    }

    const [total, clients] = await Promise.all([
        prisma.client.count({ where }),
        prisma.client.findMany({
            where,
            orderBy: { name: 'asc' },
            skip,
            take: limit,
            include: {
                _count: { select: { invoices: true } }
            }
        })
    ]);

    return {
        data: clients.map(formatClientResponse),
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1
        }
    };
}

/**
 * Fast search for autocomplete/selects
 */
async function searchClients(query = '') {
    const where = { active: true };
    const trimmed = typeof query === 'string' ? query.trim() : '';

    if (trimmed) {
        where.OR = [
            { name: { contains: trimmed } },
            { email: { contains: trimmed } },
            { phone: { contains: trimmed } },
            { gstin: { contains: trimmed } }
        ];
    }

    const clients = await prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        take: 50
    });

    return clients.map(formatClientResponse);
}

module.exports = {
    ValidationError,
    NotFoundError,
    createClient,
    getClientById,
    updateClient,
    toggleClientStatus,
    listClients,
    searchClients
};
