'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const numberingService = require('./numbering.service');
const businessService = require('./business.service');
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
        throw new ValidationError('A valid businessId is required to create a supplier.');
    }
    const businessId = parseInt(rawBizId, 10);

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

    let supplierCode = (data.supplierCode || '').trim().toUpperCase();

    const supplier = await prisma.$transaction(async (tx) => {
        if (!supplierCode) {
            supplierCode = await numberingService.allocateNumber({
                businessId,
                entityType: 'SUPPLIER',
                tx
            });
        }

        const existing = await tx.supplier.findFirst({
            where: { businessId, supplierCode }
        });
        if (existing) {
            throw new ConflictError(`Supplier code "${supplierCode}" already exists for this business.`);
        }

        return await tx.supplier.create({
            data: {
                businessId,
                supplierCode,
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

async function getSupplierById(id, businessId = null) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid supplier ID.');
    const where = { id: numId };
    if (businessId) where.businessId = parseInt(businessId, 10);
    const supplier = await prisma.supplier.findFirst({
        where
    });
    if (!supplier) throw new NotFoundError(`Supplier with ID ${numId} not found.`);
    return supplier;
}

async function updateSupplier(id, data = {}, userId = null, businessId = null) {
    const existing = await getSupplierById(id, businessId);

    const updateData = {};
    if (data.name !== undefined) {
        const name = (data.name || '').trim();
        if (!name) throw new ValidationError('Supplier name cannot be empty.');
        updateData.name = name;
    }
    if (data.supplierCode !== undefined) {
        const supplierCode = String(data.supplierCode || '').trim().toUpperCase();
        if (!supplierCode) throw new ValidationError('Supplier code cannot be empty.');
        const duplicate = await prisma.supplier.findFirst({
            where: { businessId: existing.businessId, supplierCode, NOT: { id: existing.id } }
        });
        if (duplicate) throw new ConflictError(`Supplier code "${supplierCode}" already exists for this business.`);
        updateData.supplierCode = supplierCode;
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

    const updated = await require('./recordHistory.service').commit({ type: 'supplier', existing, data: updateData, actorId: userId, expectedVersion: data._recordVersion });

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

async function setSupplierActive(id, active, userId = null, businessId = null) {
    const supplier = await getSupplierById(id, businessId);
    if (supplier.active === Boolean(active)) return supplier;
    const updated = await require('./recordHistory.service').commit({type:'supplier',existing:supplier,data:{active:Boolean(active)},actorId:userId});
    if (userId) {
        await activityService.log({
            actorUserId: userId,
            businessId: supplier.businessId,
            action: updated.active ? 'REACTIVATE' : 'DEACTIVATE',
            module: 'PURCHASES',
            targetType: 'SUPPLIER',
            targetId: updated.id,
            description: `${updated.active ? 'Reactivated' : 'Deactivated'} supplier ${updated.name}`
        });
    }
    return updated;
}

async function searchSuppliers(query = '', limit = 50, businessId = null, { activeOnly = false } = {}) {
    const q = (query || '').trim();
    const where = {};
    if (businessId) {
        where.businessId = parseInt(businessId, 10);
    }
    if (activeOnly) where.active = true;
    if (q) {
        where.OR = [
            { supplierCode: { contains: q } },
            { name: { contains: q } },
            { email: { contains: q } },
            { phone: { contains: q } },
            { gstin: { contains: q } }
        ];
    }
    return prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        take: limit
    });
}

module.exports = {
    createSupplier,
    getSupplierById,
    updateSupplier,
    setSupplierActive,
    searchSuppliers,
    ValidationError,
    NotFoundError,
    ConflictError
};
