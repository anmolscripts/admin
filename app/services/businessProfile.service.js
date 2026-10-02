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

const DEFAULT_PROFILE = {
    legalName: 'Spark Admin Technologies Pvt Ltd',
    displayName: 'Spark Admin',
    gstin: '27AABCS1429B1ZB',
    stateCode: '27',
    email: 'billing@sparkadmin.io',
    phone: '+91 98765 43210',
    address: 'Level 5, Spark Tower, BKC, Bandra East, Mumbai 400051',
    defaultTerms: '1. Payment is due within 15 days of invoice issue.\n2. Interest @ 18% p.a. will be charged on overdue payments.',
    defaultRemarks: 'Thank you for your business!'
};

/**
 * Get current business profile or create default if none exists
 */
async function getProfile() {
    let profile = await prisma.businessProfile.findFirst({
        orderBy: { id: 'asc' }
    });

    if (!profile) {
        profile = await prisma.businessProfile.create({
            data: DEFAULT_PROFILE
        });
    }

    return {
        ...profile,
        companyName: profile.displayName || profile.legalName
    };
}

/**
 * Update business profile
 */
async function updateProfile(data = {}) {
    if (!data || typeof data !== 'object') {
        throw new ValidationError('Profile data is required.');
    }

    const legalName = (data.companyName || data.legalName || '').trim();
    if (!legalName) {
        throw new ValidationError('Company / Legal name is required.');
    }

    let gstin = data.gstin ? data.gstin.trim().toUpperCase() : null;
    if (gstin && !GSTIN_REGEX.test(gstin)) {
        throw new ValidationError('Invalid GSTIN format. Expected 15-character Indian GSTIN (e.g. 27AABCS1429B1ZB).');
    }

    const stateCode = data.stateCode ? data.stateCode.trim() : (gstin ? gstin.substring(0, 2) : '27');
    const email = data.email ? data.email.trim() : null;
    const phone = data.phone ? data.phone.trim() : null;
    const address = data.address ? data.address.trim() : null;
    const defaultTerms = data.defaultTerms !== undefined ? (data.defaultTerms ? data.defaultTerms.trim() : null) : undefined;
    const defaultRemarks = data.defaultRemarks !== undefined ? (data.defaultRemarks ? data.defaultRemarks.trim() : null) : undefined;
    const displayName = data.displayName ? data.displayName.trim() : legalName;

    let profile = await prisma.businessProfile.findFirst({
        orderBy: { id: 'asc' }
    });

    const updateData = {
        legalName,
        displayName,
        gstin,
        stateCode,
        email,
        phone,
        address
    };

    if (defaultTerms !== undefined) updateData.defaultTerms = defaultTerms;
    if (defaultRemarks !== undefined) updateData.defaultRemarks = defaultRemarks;

    if (profile) {
        profile = await prisma.businessProfile.update({
            where: { id: profile.id },
            data: updateData
        });
    } else {
        profile = await prisma.businessProfile.create({
            data: {
                ...DEFAULT_PROFILE,
                ...updateData
            }
        });
    }

    return {
        ...profile,
        companyName: profile.displayName || profile.legalName
    };
}

module.exports = {
    ValidationError,
    NotFoundError,
    getProfile,
    updateProfile,
    DEFAULT_PROFILE
};
