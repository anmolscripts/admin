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
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const DEFAULT_PROFILE = {
    legalName: 'Spark Admin Technologies Pvt Ltd',
    displayName: 'Spark Admin',
    workspaceName: 'Spark Admin',
    gstin: '27AABCS1429B1ZB',
    stateCode: '27',
    email: 'billing@sparkadmin.io',
    phone: '+91 98765 43210',
    address: 'Level 5, Spark Tower, BKC, Bandra East, Mumbai 400051',
    defaultTerms: '1. Payment is due within 15 days of invoice issue.\n2. Interest @ 18% p.a. will be charged on overdue payments.',
    defaultRemarks: 'Thank you for your business!',
    currency: 'INR',
    timeZone: 'Asia/Kolkata'
};

const PROD_DEFAULT_PROFILE = {
    legalName: 'My Organization',
    displayName: 'My Organization',
    workspaceName: 'Spark Admin',
    stateCode: '27',
    currency: 'INR',
    timeZone: 'Asia/Kolkata'
};

// In-memory cache for fast branding lookups in template middleware
let cachedBranding = null;
let cachedBrandingTimestamp = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

function invalidateBrandingCache() {
    cachedBranding = null;
    cachedBrandingTimestamp = 0;
}

/**
 * Get current business profile or create default if none exists
 * @param {number|null} [businessId=null]
 */
async function getProfile(businessId = null) {
    const where = {};
    if (businessId) {
        where.businessId = Number(businessId);
    }
    let profile = await prisma.businessProfile.findFirst({
        where,
        orderBy: { id: 'asc' }
    });

    if (!profile) {
        let b = null;
        if (businessId) {
            b = await prisma.business.findUnique({ where: { id: Number(businessId) } });
        }
        const initialData = process.env.NODE_ENV === 'production' ? PROD_DEFAULT_PROFILE : DEFAULT_PROFILE;
        profile = await prisma.businessProfile.create({
            data: {
                ...initialData,
                businessId: businessId ? Number(businessId) : 1,
                displayName: b ? b.name : initialData.displayName,
                legalName: b ? (b.legalName || b.name) : initialData.legalName,
                gstin: b ? b.gstin : initialData.gstin,
                currency: b ? b.currency : initialData.currency,
                timeZone: b ? b.timeZone : initialData.timeZone
            }
        });
        invalidateBrandingCache();
    }

    const companyName = profile.displayName || profile.legalName;
    const workspaceName = profile.workspaceName || companyName || 'Spark Admin';

    return {
        ...profile,
        companyName,
        workspaceName
    };
}

/**
 * Fast cached branding resolver for global template middleware
 * @param {number|null} [businessId=null]
 */
async function getBranding(businessId = null) {
    try {
        const profile = await getProfile(businessId);
        return {
            workspaceName: profile.workspaceName || profile.displayName || profile.legalName || 'Spark Admin',
            displayName: profile.displayName || profile.legalName || 'Spark Admin',
            legalName: profile.legalName || 'Spark Admin',
            companyName: profile.displayName || profile.legalName || 'Spark Admin',
            logoUrl: profile.logoUrl || null,
            currency: profile.currency || 'INR',
            timeZone: profile.timeZone || 'Asia/Kolkata'
        };
    } catch (_) {
        return {
            workspaceName: 'Spark Admin',
            displayName: 'Spark Admin',
            legalName: 'Spark Admin',
            companyName: 'Spark Admin',
            logoUrl: null,
            currency: 'INR',
            timeZone: 'Asia/Kolkata'
        };
    }
}

/**
 * Update business profile with validation
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

    let stateCode = data.stateCode ? data.stateCode.trim() : (gstin ? gstin.substring(0, 2) : '27');
    if (gstin && stateCode && gstin.substring(0, 2) !== stateCode) {
        throw new ValidationError(`GSTIN state prefix (${gstin.substring(0, 2)}) does not match configured state code (${stateCode}).`);
    }

    let ifsc = data.ifsc ? data.ifsc.trim().toUpperCase() : null;
    if (ifsc && !IFSC_REGEX.test(ifsc)) {
        throw new ValidationError('Invalid IFSC format. Expected 11-character Indian IFSC code (e.g. HDFC0001234).');
    }

    const email = data.email ? data.email.trim() : null;
    const phone = data.phone ? data.phone.trim() : null;
    const website = data.website ? data.website.trim() : null;
    const address = data.address ? data.address.trim() : null;
    const displayName = data.displayName ? data.displayName.trim() : legalName;
    const workspaceName = data.workspaceName ? data.workspaceName.trim() : displayName;
    const logoUrl = data.logoUrl ? data.logoUrl.trim() : null;

    // Banking
    const bankName = data.bankName ? data.bankName.trim() : null;
    const accountHolder = data.accountHolder ? data.accountHolder.trim() : null;
    const accountNumber = data.accountNumber ? data.accountNumber.trim() : null;
    const branch = data.branch ? data.branch.trim() : null;
    const upiId = data.upiId ? data.upiId.trim() : null;

    // Document & localization defaults
    const defaultTerms = data.defaultTerms !== undefined ? (data.defaultTerms ? data.defaultTerms.trim() : null) : undefined;
    const defaultRemarks = data.defaultRemarks !== undefined ? (data.defaultRemarks ? data.defaultRemarks.trim() : null) : undefined;
    const invoiceFooter = data.invoiceFooter !== undefined ? (data.invoiceFooter ? data.invoiceFooter.trim() : null) : undefined;
    const paymentInstructions = data.paymentInstructions !== undefined ? (data.paymentInstructions ? data.paymentInstructions.trim() : null) : undefined;
    const timeZone = data.timeZone ? data.timeZone.trim() : 'Asia/Kolkata';
    const currency = data.currency ? data.currency.trim().toUpperCase() : 'INR';

    let profile = await prisma.businessProfile.findFirst({
        orderBy: { id: 'asc' }
    });

    const updateData = {
        legalName,
        displayName,
        workspaceName,
        logoUrl,
        gstin,
        stateCode,
        email,
        phone,
        website,
        address,
        bankName,
        accountHolder,
        accountNumber,
        ifsc,
        branch,
        upiId,
        timeZone,
        currency
    };

    if (defaultTerms !== undefined) updateData.defaultTerms = defaultTerms;
    if (defaultRemarks !== undefined) updateData.defaultRemarks = defaultRemarks;
    if (invoiceFooter !== undefined) updateData.invoiceFooter = invoiceFooter;
    if (paymentInstructions !== undefined) updateData.paymentInstructions = paymentInstructions;

    if (profile) {
        profile = await prisma.businessProfile.update({
            where: { id: profile.id },
            data: updateData
        });
    } else {
        const base = process.env.NODE_ENV === 'production' ? PROD_DEFAULT_PROFILE : DEFAULT_PROFILE;
        profile = await prisma.businessProfile.create({
            data: {
                ...base,
                ...updateData
            }
        });
    }

    invalidateBrandingCache();

    const companyName = profile.displayName || profile.legalName;
    return {
        ...profile,
        companyName,
        workspaceName: profile.workspaceName || companyName
    };
}

module.exports = {
    ValidationError,
    NotFoundError,
    getProfile,
    getBranding,
    updateProfile,
    invalidateBrandingCache,
    DEFAULT_PROFILE
};
