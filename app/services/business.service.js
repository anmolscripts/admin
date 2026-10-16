'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — CANONICAL MULTI-BUSINESS MANAGEMENT SERVICE
 * ==============================================================================
 *
 * Provides authoritative management for:
 * 1. Businesses (create, update, activate, suspend, archive, get, list)
 * 2. Business Memberships (add, update role, revoke, list, set default)
 * 3. Access resolution for users and platform administrators
 * ==============================================================================
 */

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const numberingService = require('./numbering.service');
const { ensureSystemAccounts } = require('./chartOfAccounts.service');
const { ensureFinancialYear } = require('./financialYear.service');

class BusinessError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'BusinessError';
        this.statusCode = statusCode;
    }
}

/**
 * Validate business code: alphanumeric, hyphen, underscore, 2-50 chars.
 */
function validateBusinessCode(code, name = '') {
    let clean = (code || '').toString().trim().toUpperCase();
    if (!clean && name) {
        clean = name.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 30);
    }
    if (!clean) {
        throw new BusinessError('Business code is required.');
    }
    if (!/^[A-Z0-9_-]{2,50}$/.test(clean)) {
        throw new BusinessError('Business code must be 2-50 uppercase alphanumeric characters, hyphens or underscores.');
    }
    return clean;
}

/**
 * Create a new business with canonical identity, initial profile, and owner membership.
 */
async function createBusiness(data = {}, actorUserId = null) {
    const code = validateBusinessCode(data.code, data.name);
    const name = (data.name || '').trim();
    if (!name) throw new BusinessError('Business name is required.');

    const existingCode = await prisma.business.findUnique({ where: { code } });
    if (existingCode) {
        throw new BusinessError(`Business code '${code}' is already registered.`, 409);
    }

    const business = await prisma.$transaction(async (tx) => {
        const b = await tx.business.create({
            data: {
                code,
                name,
                legalName: data.legalName ? data.legalName.trim() : name,
                gstin: data.gstin ? data.gstin.trim().toUpperCase() : null,
                stateCode: data.stateCode ? data.stateCode.trim() : null,
                currency: data.currency ? data.currency.trim().toUpperCase() : 'INR',
                timeZone: data.timeZone ? data.timeZone.trim() : 'Asia/Kolkata',
                status: 'ACTIVE',
                email: data.email ? data.email.trim() : null,
                phone: data.phone ? data.phone.trim() : null,
                address: data.address ? data.address.trim() : null,
                website: data.website ? data.website.trim() : null,
                logoUrl: data.logoUrl || null
            }
        });

        // Create initial business profile for document presentation
        await tx.businessProfile.create({
            data: {
                businessId: b.id,
                legalName: b.legalName || b.name,
                displayName: b.name,
                workspaceName: b.name,
                gstin: b.gstin,
                stateCode: b.stateCode,
                currency: b.currency,
                timeZone: b.timeZone,
                email: b.email,
                phone: b.phone,
                address: b.address,
                website: b.website,
                logoUrl: b.logoUrl,
                defaultTerms: '1. Payment is due within 15 days of invoice issue.\n2. Interest @ 18% p.a. will be charged on overdue payments.',
                defaultRemarks: 'Thank you for your business!'
            }
        });

        // Add actor as OWNER membership if actorUserId provided
        if (actorUserId) {
            await tx.businessMembership.create({
                data: {
                    userId: actorUserId,
                    businessId: b.id,
                    role: 'OWNER',
                    status: 'ACTIVE',
                    isDefault: true
                }
            });
        }

        return b;
    });

    // Provision standard accounting accounts and financial year for this business
    try {
        await ensureSystemAccounts(actorUserId, business.id);
        await ensureFinancialYear(new Date(), business.id);
    } catch (err) {
        console.warn(`[BUSINESS] Non-fatal initialization warning for business ${business.id}:`, err.message);
    }

    if (actorUserId) {
        await activityService.log({
            actorUserId,
            businessId: business.id,
            action: 'BUSINESS_CREATED',
            module: 'ADMINISTRATION',
            targetReference: business.code,
            metadata: { name: business.name, code: business.code }
        });
    }

    return business;
}

/**
 * Update business details.
 */
async function updateBusiness(businessIdInput, data = {}, actorUserId = null) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');

    const existing = await prisma.business.findUnique({ where: { id: businessId } });
    if (!existing) throw new BusinessError('Business not found.', 404);

    const updateData = {};
    if (data.name !== undefined) {
        const n = String(data.name).trim();
        if (!n) throw new BusinessError('Business name cannot be empty.');
        updateData.name = n;
    }
    if (data.legalName !== undefined) updateData.legalName = data.legalName ? String(data.legalName).trim() : null;
    if (data.gstin !== undefined) updateData.gstin = data.gstin ? String(data.gstin).trim().toUpperCase() : null;
    if (data.stateCode !== undefined) updateData.stateCode = data.stateCode ? String(data.stateCode).trim() : null;
    if (data.currency !== undefined) updateData.currency = data.currency ? String(data.currency).trim().toUpperCase() : 'INR';
    if (data.timeZone !== undefined) updateData.timeZone = data.timeZone ? String(data.timeZone).trim() : 'Asia/Kolkata';
    if (data.email !== undefined) updateData.email = data.email ? String(data.email).trim() : null;
    if (data.phone !== undefined) updateData.phone = data.phone ? String(data.phone).trim() : null;
    if (data.address !== undefined) updateData.address = data.address ? String(data.address).trim() : null;
    if (data.website !== undefined) updateData.website = data.website ? String(data.website).trim() : null;
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl || null;

    if (data.status && ['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(data.status)) {
        updateData.status = data.status;
    }

    const updated = await prisma.business.update({
        where: { id: businessId },
        data: updateData
    });

    // Sync business profile displayName and legalName
    try {
        await prisma.businessProfile.updateMany({
            where: { businessId },
            data: {
                displayName: updated.name,
                legalName: updated.legalName || updated.name,
                gstin: updated.gstin,
                stateCode: updated.stateCode,
                currency: updated.currency,
                timeZone: updated.timeZone,
                email: updated.email,
                phone: updated.phone,
                address: updated.address,
                website: updated.website,
                logoUrl: updated.logoUrl
            }
        });
    } catch (_) {}

    if (actorUserId) {
        await activityService.log({
            actorUserId,
            businessId,
            action: 'BUSINESS_UPDATED',
            module: 'ADMINISTRATION',
            targetReference: updated.code,
            metadata: updateData
        });
    }

    return updated;
}

/**
 * Get business by ID with member count.
 */
async function getBusinessById(businessIdInput) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');

    const b = await prisma.business.findUnique({
        where: { id: businessId },
        include: {
            _count: {
                select: {
                    memberships: true,
                    invoices: true,
                    clients: true
                }
            }
        }
    });
    if (!b) throw new BusinessError('Business not found.', 404);
    return b;
}

/**
 * List businesses with status filters.
 */
async function listBusinesses(filters = {}) {
    const where = {};
    if (filters.status) {
        where.status = filters.status;
    }
    if (filters.search) {
        const s = String(filters.search).trim();
        where.OR = [
            { name: { contains: s } },
            { code: { contains: s } },
            { legalName: { contains: s } }
        ];
    }

    return await prisma.business.findMany({
        where,
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        include: {
            _count: {
                select: { memberships: true, invoices: true, clients: true }
            }
        }
    });
}

/**
 * Resolve all accessible businesses for a user.
 * Platform administrators have access to all ACTIVE businesses (or ARCHIVED if includeArchived is requested).
 * Regular users have access to ACTIVE businesses where they have an ACTIVE membership.
 */
async function getUserAccessibleBusinesses(userId, userRole = null, options = {}) {
    if (!userId) return [];

    let isPlatformAdmin = userRole === 'ADMIN' || (typeof userRole === 'boolean' && userRole === true);
    if (!isPlatformAdmin && userRole === null) {
        const u = await prisma.user.findUnique({
            where: { id: Number(userId) },
            select: { role: true }
        });
        if (u && u.role === 'ADMIN') {
            isPlatformAdmin = true;
        }
    }
    const includeArchived = options && (options.includeArchived === true || options.includeInactive === true);
    const statusFilter = includeArchived ? { in: ['ACTIVE', 'ARCHIVED', 'SUSPENDED'] } : 'ACTIVE';

    if (isPlatformAdmin) {
        return await prisma.business.findMany({
            where: { status: statusFilter },
            orderBy: { name: 'asc' }
        });
    }

    const memberships = await prisma.businessMembership.findMany({
        where: {
            userId: Number(userId),
            status: 'ACTIVE',
            business: { status: statusFilter }
        },
        include: {
            business: true
        },
        orderBy: [{ isDefault: 'desc' }, { business: { name: 'asc' } }]
    });

    return memberships.map(m => ({
        ...m.business,
        membershipRole: m.role,
        isDefault: m.isDefault
    }));
}

/**
 * Add or update a user membership in a business.
 */
async function setBusinessMembership(businessIdInput, userIdInput, role = 'MEMBER', actorUserId = null) {
    let businessId, userId, actualRole = role, actualActor = actorUserId;
    if (typeof businessIdInput === 'object' && businessIdInput !== null) {
        businessId = parseInt(businessIdInput.businessId, 10);
        userId = parseInt(businessIdInput.userId, 10);
        actualRole = businessIdInput.role || 'MEMBER';
        actualActor = businessIdInput.actorUserId || null;
    } else {
        businessId = parseInt(businessIdInput, 10);
        userId = parseInt(userIdInput, 10);
    }
    if (isNaN(businessId) || isNaN(userId)) throw new BusinessError('Invalid business or user ID.');

    const validRoles = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];
    const normRole = validRoles.includes(actualRole) ? actualRole : 'MEMBER';

    const membership = await prisma.businessMembership.upsert({
        where: {
            userId_businessId: { userId, businessId }
        },
        create: {
            userId,
            businessId,
            role: normRole,
            status: 'ACTIVE'
        },
        update: {
            role: normRole,
            status: 'ACTIVE'
        },
        include: {
            user: { select: { id: true, name: true, email: true } },
            business: { select: { id: true, name: true, code: true } }
        }
    });

    if (actualActor) {
        await activityService.log({
            actorUserId: actualActor,
            businessId,
            action: 'MEMBERSHIP_UPDATED',
            module: 'ADMINISTRATION',
            targetReference: `${membership.user.email} -> ${membership.business.code}`,
            metadata: { userId, businessId, role: normRole }
        });
    }

    return membership;
}

/**
 * Revoke a user's membership in a business.
 */
async function revokeBusinessMembership(businessIdInput, userIdInput, actorUserId = null) {
    let businessId, userId, actualActor = actorUserId;
    if (typeof businessIdInput === 'object' && businessIdInput !== null) {
        businessId = parseInt(businessIdInput.businessId, 10);
        userId = parseInt(businessIdInput.userId, 10);
        actualActor = businessIdInput.actorUserId || null;
    } else {
        businessId = parseInt(businessIdInput, 10);
        userId = parseInt(userIdInput, 10);
    }
    if (isNaN(businessId) || isNaN(userId)) throw new BusinessError('Invalid business or user ID.');

    const updated = await prisma.businessMembership.updateMany({
        where: { businessId, userId },
        data: { status: 'REVOKED' }
    });

    if (actualActor) {
        await activityService.log({
            actorUserId: actualActor,
            businessId,
            action: 'MEMBERSHIP_REVOKED',
            module: 'ADMINISTRATION',
            targetReference: `User ${userId} from Business ${businessId}`,
            metadata: { userId, businessId }
        });
    }

    return updated;
}

/**
 * List all members of a business.
 */
async function listBusinessMembers(businessIdInput) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');

    return await prisma.businessMembership.findMany({
        where: { businessId },
        include: {
            user: {
                select: { id: true, name: true, email: true, status: true, avatarUrl: true }
            }
        },
        orderBy: [{ status: 'asc' }, { role: 'asc' }]
    });
}

/**
 * Asserts that a business is active and permitted for transactional posting.
 */
async function assertBusinessActive(businessIdInput) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');
    const b = await prisma.business.findUnique({ where: { id: businessId } });
    if (!b) throw new BusinessError('Business not found.', 404);
    if (b.status === 'ARCHIVED') {
        throw new BusinessError(`Business "${b.name}" is archived. New transactions cannot be posted to an archived organization. Historical reporting remains available in read-only mode.`, 403);
    }
    if (b.status === 'SUSPENDED') {
        throw new BusinessError(`Business "${b.name}" is suspended. Transaction posting is prohibited while suspended.`, 403);
    }
    return b;
}

/**
 * Archive a business: preserves 100% of data, disables new transactional posting, allows read-only historical reporting.
 */
async function archiveBusiness(businessIdInput, actorUserId = null) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');
    const existing = await prisma.business.findUnique({ where: { id: businessId } });
    if (!existing) throw new BusinessError('Business not found.', 404);

    const updated = await prisma.business.update({
        where: { id: businessId },
        data: { status: 'ARCHIVED' }
    });

    if (actorUserId) {
        await activityService.log({
            actorUserId,
            businessId,
            action: 'BUSINESS_ARCHIVED',
            module: 'ADMINISTRATION',
            targetReference: updated.code,
            metadata: { previousStatus: existing.status, newStatus: 'ARCHIVED' }
        });
    }

    return updated;
}

/**
 * Suspend a business.
 */
async function suspendBusiness(businessIdInput, actorUserId = null) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');
    const existing = await prisma.business.findUnique({ where: { id: businessId } });
    if (!existing) throw new BusinessError('Business not found.', 404);

    const updated = await prisma.business.update({
        where: { id: businessId },
        data: { status: 'SUSPENDED' }
    });

    if (actorUserId) {
        await activityService.log({
            actorUserId,
            businessId,
            action: 'BUSINESS_SUSPENDED',
            module: 'ADMINISTRATION',
            targetReference: updated.code,
            metadata: { previousStatus: existing.status, newStatus: 'SUSPENDED' }
        });
    }

    return updated;
}

/**
 * Reactivate a business.
 */
async function reactivateBusiness(businessIdInput, actorUserId = null) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');
    const existing = await prisma.business.findUnique({ where: { id: businessId } });
    if (!existing) throw new BusinessError('Business not found.', 404);

    const updated = await prisma.business.update({
        where: { id: businessId },
        data: { status: 'ACTIVE' }
    });

    if (actorUserId) {
        await activityService.log({
            actorUserId,
            businessId,
            action: 'BUSINESS_ACTIVATED',
            module: 'ADMINISTRATION',
            targetReference: updated.code,
            metadata: { previousStatus: existing.status, newStatus: 'ACTIVE' }
        });
    }

    return updated;
}

/**
 * Delete a business:
 * Strictly prevents business deletion while retained records (invoices, payments, journals, bills, audit logs) depend on it.
 * Provides a clear administrator-facing explanation and enforces archiving instead.
 */
async function deleteBusiness(businessIdInput, actorUserId = null) {
    const businessId = parseInt(businessIdInput, 10);
    if (isNaN(businessId) || businessId <= 0) throw new BusinessError('Invalid business ID.');

    const existing = await prisma.business.findUnique({ where: { id: businessId } });
    if (!existing) throw new BusinessError('Business not found.', 404);

    if (existing.code === 'DEFAULT' || businessId === 1) {
        throw new BusinessError('The default organization cannot be deleted.', 400);
    }

    // Check all retained compliance and financial dependencies
    const [
        invoiceCount,
        paymentCount,
        journalCount,
        billCount,
        supplierPaymentCount,
        stockMovementCount,
        noteCount,
        activityCount
    ] = await Promise.all([
        prisma.invoice.count({ where: { businessId } }),
        prisma.payment.count({ where: { businessId } }),
        prisma.journalEntry.count({ where: { businessId } }),
        prisma.supplierBill.count({ where: { businessId } }),
        prisma.supplierPayment.count({ where: { businessId } }),
        prisma.stockMovement.count({ where: { businessId } }),
        prisma.creditDebitNote.count({ where: { businessId } }),
        prisma.userActivityLog.count({ where: { businessId } })
    ]);

    const retained = [];
    if (invoiceCount > 0) retained.push(`${invoiceCount} invoice(s)`);
    if (paymentCount > 0) retained.push(`${paymentCount} payment receipt(s)`);
    if (journalCount > 0) retained.push(`${journalCount} general ledger journal(s)`);
    if (billCount > 0) retained.push(`${billCount} supplier bill(s)`);
    if (supplierPaymentCount > 0) retained.push(`${supplierPaymentCount} supplier payment(s)`);
    if (stockMovementCount > 0) retained.push(`${stockMovementCount} inventory stock movement(s)`);
    if (noteCount > 0) retained.push(`${noteCount} credit/debit note(s)`);
    if (activityCount > 0) retained.push(`${activityCount} audit log record(s)`);

    if (retained.length > 0) {
        throw new BusinessError(
            `Cannot delete business "${existing.name}" (Code: ${existing.code}) because it contains retained compliance records: ${retained.join(', ')}. In accordance with self-hosted financial ERP data preservation and statutory audit standards, physical deletion of businesses with historical financial/audit data is prohibited. Please archive or suspend the business instead.`,
            400
        );
    }

    // Cleanly delete empty business with zero financial history
    await prisma.$transaction(async (tx) => {
        await tx.businessMembership.deleteMany({ where: { businessId } });
        await tx.businessPrefixConfig.deleteMany({ where: { businessId } });
        await tx.numberingSequence.deleteMany({ where: { businessId } });
        await tx.businessProfile.deleteMany({ where: { businessId } });
        await tx.chartOfAccount.updateMany({ where: { businessId }, data: { parentId: null } });
        await tx.chartOfAccount.deleteMany({ where: { businessId } });
        await tx.financialYear.deleteMany({ where: { businessId } });
        await tx.client.deleteMany({ where: { businessId } });
        await tx.supplier.deleteMany({ where: { businessId } });
        await tx.item.deleteMany({ where: { businessId } });
        await tx.unit.deleteMany({ where: { businessId } });
        await tx.business.delete({ where: { id: businessId } });
    });

    if (actorUserId) {
        await activityService.log({
            actorUserId,
            action: 'BUSINESS_DELETED',
            module: 'ADMINISTRATION',
            targetReference: existing.code,
            metadata: { deletedBusinessId: businessId, code: existing.code, name: existing.name }
        });
    }

    return { success: true, deletedBusinessId: businessId, code: existing.code };
}

module.exports = {
    BusinessError,
    validateBusinessCode,
    createBusiness,
    updateBusiness,
    getBusinessById,
    listBusinesses,
    getUserAccessibleBusinesses,
    getAccessibleBusinesses: getUserAccessibleBusinesses,
    setBusinessMembership,
    addOrUpdateMember: setBusinessMembership,
    revokeBusinessMembership,
    revokeMember: revokeBusinessMembership,
    listBusinessMembers,
    assertBusinessActive,
    archiveBusiness,
    suspendBusiness,
    reactivateBusiness,
    deleteBusiness
};
