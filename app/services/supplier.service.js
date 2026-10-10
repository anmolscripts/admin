'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]{4,30}$/;

function validateEmail(email) {
    if (email === undefined || email === null) return null;
    const str = String(email).trim();
    if (!str) return null;
    if (str.length > 191) throw new ValidationError('Supplier email must not exceed 191 characters.');
    if (!EMAIL_REGEX.test(str)) throw new ValidationError('Invalid supplier email format.');
    return str;
}

function validatePhone(phone) {
    if (phone === undefined || phone === null) return null;
    const str = String(phone).trim();
    if (!str) return null;
    if (str.length > 50) throw new ValidationError('Supplier phone must not exceed 50 characters.');
    if (!PHONE_REGEX.test(str)) throw new ValidationError('Invalid supplier phone format.');
    return str;
}

async function createSupplier(data = {}, userId = null) {
    const name = (data.name || '').trim();
    if (!name) throw new ValidationError('Supplier name is required.');
    if (name.length > 191) throw new ValidationError('Supplier name must not exceed 191 characters.');

    let gstin = data.gstin ? data.gstin.trim().toUpperCase() : null;
    if (gstin && !GSTIN_REGEX.test(gstin)) {
        throw new ValidationError('Invalid GSTIN format. Expected 15-character Indian GSTIN.');
    }

    let stateCode = data.stateCode ? data.stateCode.trim() : null;
    if (!stateCode && gstin) {
        stateCode = gstin.substring(0, 2);
    }

    const email = validateEmail(data.email);
    const phone = validatePhone(data.phone);
    const address = data.address ? data.address.trim() : null;

    const supplier = await prisma.supplier.create({
        data: {
            name,
            email,
            phone,
            gstin,
            stateCode,
            address,
            active: data.active !== undefined ? Boolean(data.active) : true,
            createdById: userId
        }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'CREATE',
            module: 'PURCHASES',
            targetType: 'SUPPLIER',
            targetId: supplier.id,
            description: `Created supplier ${supplier.name}`
        });
    }

    return supplier;
}

async function getSupplierById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid supplier ID.');
    const supplier = await prisma.supplier.findUnique({
        where: { id: numId }
    });
    if (!supplier) throw new NotFoundError(`Supplier with ID ${numId} not found.`);
    return supplier;
}

async function updateSupplier(id, data = {}, userId = null) {
    const existing = await getSupplierById(id);

    const updateData = {};
    if (data.name !== undefined) {
        const name = (data.name || '').trim();
        if (!name) throw new ValidationError('Supplier name cannot be empty.');
        updateData.name = name;
    }
    if (data.email !== undefined) updateData.email = validateEmail(data.email);
    if (data.phone !== undefined) updateData.phone = validatePhone(data.phone);
    if (data.gstin !== undefined) {
        const gstin = data.gstin ? data.gstin.trim().toUpperCase() : null;
        if (gstin && !GSTIN_REGEX.test(gstin)) throw new ValidationError('Invalid GSTIN format.');
        updateData.gstin = gstin;
        if (gstin && !data.stateCode) updateData.stateCode = gstin.substring(0, 2);
    }
    if (data.stateCode !== undefined) updateData.stateCode = data.stateCode ? data.stateCode.trim() : null;
    if (data.address !== undefined) updateData.address = data.address ? data.address.trim() : null;
    if (data.active !== undefined) updateData.active = Boolean(data.active);

    const updated = await prisma.supplier.update({
        where: { id: existing.id },
        data: updateData
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'UPDATE',
            module: 'PURCHASES',
            targetType: 'SUPPLIER',
            targetId: updated.id,
            description: `Updated supplier ${updated.name}`
        });
    }

    return updated;
}

async function searchSuppliers(query = '', limit = 50) {
    const q = (query || '').trim();
    return prisma.supplier.findMany({
        where: q ? {
            OR: [
                { name: { contains: q } },
                { email: { contains: q } },
                { phone: { contains: q } },
                { gstin: { contains: q } }
            ]
        } : {},
        orderBy: { name: 'asc' },
        take: limit
    });
}

module.exports = {
    createSupplier,
    getSupplierById,
    updateSupplier,
    searchSuppliers,
    ValidationError,
    NotFoundError,
    ConflictError
};
