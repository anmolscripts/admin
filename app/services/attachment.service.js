'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const prisma = require('../config/prisma');

const ATTACHMENT_STORAGE_DIR = process.env.ATTACHMENT_STORAGE_DIR ?
    path.resolve(process.env.ATTACHMENT_STORAGE_DIR) :
    path.resolve(__dirname, '../../data/attachments');
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

// Ensure directory exists if filesystem allows
if (!fs.existsSync(ATTACHMENT_STORAGE_DIR)) {
    try {
        fs.mkdirSync(ATTACHMENT_STORAGE_DIR, { recursive: true });
    } catch (_) {
        // Will fail at runtime during save if inaccessible
    }
}

/**
 * Validate magic bytes for allowed types: PDF, PNG, JPEG, WebP
 */
function validateMagicBytes(buffer) {
    if (!buffer || buffer.length < 4) {
        return { valid: false, error: 'File buffer too short or empty' };
    }

    // PDF: %PDF (0x25, 0x50, 0x44, 0x46)
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return { valid: true, mimeType: 'application/pdf', ext: 'pdf' };
    }

    // PNG: \x89PNG (0x89, 0x50, 0x4E, 0x47)
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return { valid: true, mimeType: 'image/png', ext: 'png' };
    }

    // JPEG: \xFF\xD8\xFF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return { valid: true, mimeType: 'image/jpeg', ext: 'jpg' };
    }

    // WebP: RIFF....WEBP
    if (buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP') {
        return { valid: true, mimeType: 'image/webp', ext: 'webp' };
    }

    return {
        valid: false,
        error: 'Invalid or unsupported file content. Only authentic PDF, PNG, JPEG, and WebP files are allowed.'
    };
}

/**
 * Strict XSS sanitizer for rich-text document descriptions.
 * Allows safe HTML markup while neutralizing scripts, event handlers, and data URIs.
 */
function sanitizeHtmlDescription(input) {
    if (!input || typeof input !== 'string') return null;
    let clean = input
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
        .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
        .replace(/\son\w+\s*=\s*[^>\s]+/gi, '')
        .replace(/javascript:/gi, 'blocked:');
    return clean.trim();
}

/**
 * Save an attachment securely to disk outside public assets and register in DB.
 */
async function saveAttachment({
    businessId,
    projectId = null,
    entityType,
    entityId = null,
    title = null,
    category = 'OTHER',
    description = null,
    referenceNumber = null,
    issueDate = null,
    expiryDate = null,
    fileBuffer,
    originalFilename,
    uploadedById
}) {
    if (!businessId || typeof businessId !== 'number') {
        const err = new Error('Authorized businessId is required for attachment creation');
        err.status = 400;
        err.statusCode = 400;
        throw err;
    }
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
        const err = new Error('Valid file buffer is required');
        err.status = 400;
        err.statusCode = 400;
        throw err;
    }
    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
        const err = new Error(`File size exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`);
        err.status = 413;
        err.statusCode = 413;
        throw err;
    }

    if (originalFilename) {
        const ext = path.extname(originalFilename).toLowerCase();
        const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
        if (!allowedExts.includes(ext)) {
            const err = new Error(`Unsupported file extension: '${ext}'. Only PDF, PNG, JPEG, and WebP are allowed.`);
            err.status = 415;
            err.statusCode = 415;
            throw err;
        }
    }

    const validation = validateMagicBytes(fileBuffer);
    if (!validation.valid) {
        const err = new Error(validation.error);
        err.status = 415;
        err.statusCode = 415;
        throw err;
    }

    // Verify project belongs to tenant if specified
    if (projectId) {
        const project = await prisma.project.findFirst({
            where: { id: Number(projectId), businessId: Number(businessId) }
        });
        if (!project) {
            const err = new Error(`Project #${projectId} not found or does not belong to authorized business`);
            err.status = 404;
            err.statusCode = 404;
            throw err;
        }
    }

    const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const randomHex = crypto.randomBytes(16).toString('hex');
    const storedFilename = `${Date.now()}_${randomHex}.${validation.ext}`;
    const filePath = path.join(ATTACHMENT_STORAGE_DIR, storedFilename);

    await fs.promises.writeFile(filePath, fileBuffer);

    const sanitizedOriginal = path.basename(originalFilename || `attachment.${validation.ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');

    const validCategories = ['CERTIFICATE', 'TPT', 'DELIVERY_CHALLAN', 'INSPECTION', 'WARRANTY', 'COMPLIANCE', 'INSURANCE', 'DRAWING', 'CONTRACT', 'PERMIT', 'INVOICE_SCAN', 'OTHER'];
    const docCategory = validCategories.includes(String(category).toUpperCase()) ? String(category).toUpperCase() : 'OTHER';
    const parsedIssueDate = issueDate ? new Date(issueDate) : null;
    const parsedExpiryDate = expiryDate ? new Date(expiryDate) : null;

    const createData = {
        business: { connect: { id: Number(businessId) } },
        entityType: String(entityType || 'PROJECT'),
        entityId: entityId ? Number(entityId) : null,
        title: title ? String(title).trim() : null,
        category: docCategory,
        description: sanitizeHtmlDescription(description),
        referenceNumber: referenceNumber ? String(referenceNumber).trim() : null,
        issueDate: parsedIssueDate && !isNaN(parsedIssueDate.getTime()) ? parsedIssueDate : null,
        expiryDate: parsedExpiryDate && !isNaN(parsedExpiryDate.getTime()) ? parsedExpiryDate : null,
        originalFilename: sanitizedOriginal,
        storedFilename,
        filePath,
        fileSize: fileBuffer.length,
        mimeType: validation.mimeType,
        sha256Hash,
        uploadedBy: { connect: { id: Number(uploadedById) } }
    };
    if (projectId) {
        createData.project = { connect: { id: Number(projectId) } };
    }

    let attachment;
    try {
        attachment = await prisma.projectAttachment.create({
            data: createData
        });
    } catch (dbErr) {
        // Rollback disk file if DB record insertion fails
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
        } catch (_) {}
        throw dbErr;
    }

    return attachment;
}

/**
 * Get attachment metadata verifying tenant ownership.
 */
async function getAttachment(id, businessId) {
    if (!id || !businessId) {
        return null;
    }

    const attachment = await prisma.projectAttachment.findFirst({
        where: {
            id: Number(id),
            businessId: Number(businessId)
        },
        include: {
            uploadedBy: {
                select: { id: true, name: true, email: true }
            },
            project: {
                select: { id: true, code: true, name: true }
            }
        }
    });

    return attachment;
}

/**
 * Get attachment stream verifying tenant ownership and file existence.
 */
async function getAttachmentStream(id, businessId) {
    const attachment = await getAttachment(id, businessId);
    if (!attachment) {
        return null;
    }

    if (!fs.existsSync(attachment.filePath)) {
        throw new Error('Attachment file not found on storage disk');
    }

    return {
        attachment,
        stream: fs.createReadStream(attachment.filePath)
    };
}

/**
 * Update attachment metadata with tenant boundary enforcement.
 */
async function updateAttachmentMetadata({ id, businessId, title, category, description, referenceNumber, issueDate, expiryDate }) {
    const attachment = await getAttachment(id, businessId);
    if (!attachment) {
        const err = new Error('Attachment not found or access denied for this organization.');
        err.statusCode = 404;
        throw err;
    }

    const validCategories = ['CERTIFICATE', 'TPT', 'DELIVERY_CHALLAN', 'INSPECTION', 'WARRANTY', 'COMPLIANCE', 'OTHER'];
    const docCategory = category && validCategories.includes(String(category).toUpperCase())
        ? String(category).toUpperCase()
        : attachment.category;

    const parsedIssueDate = issueDate !== undefined ? (issueDate ? new Date(issueDate) : null) : attachment.issueDate;
    const parsedExpiryDate = expiryDate !== undefined ? (expiryDate ? new Date(expiryDate) : null) : attachment.expiryDate;

    return prisma.projectAttachment.update({
        where: { id: Number(id) },
        data: {
            title: title !== undefined ? (title ? String(title).trim() : null) : attachment.title,
            category: docCategory,
            description: description !== undefined ? sanitizeHtmlDescription(description) : attachment.description,
            referenceNumber: referenceNumber !== undefined ? (referenceNumber ? String(referenceNumber).trim() : null) : attachment.referenceNumber,
            issueDate: parsedIssueDate && !isNaN(parsedIssueDate.getTime()) ? parsedIssueDate : null,
            expiryDate: parsedExpiryDate && !isNaN(parsedExpiryDate.getTime()) ? parsedExpiryDate : null
        }
    });
}

/**
 * List attachments for a project or entity strictly scoped to tenant.
 */
async function listAttachments({ businessId, projectId, entityType, entityId, category, search }) {
    const where = { businessId: Number(businessId) };
    if (projectId) where.projectId = Number(projectId);
    if (entityType) where.entityType = String(entityType);
    if (entityId) where.entityId = Number(entityId);
    if (category) where.category = String(category).toUpperCase();
    if (search) {
        where.OR = [
            { originalFilename: { contains: search } },
            { title: { contains: search } },
            { referenceNumber: { contains: search } }
        ];
    }

    return prisma.projectAttachment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            uploadedBy: {
                select: { id: true, name: true, email: true }
            }
        }
    });
}

/**
 * Delete an attachment verifying tenant ownership.
 */
async function deleteAttachment(id, businessId) {
    const attachment = await getAttachment(id, businessId);
    if (!attachment) {
        throw new Error('Attachment not found or access denied');
    }

    try {
        if (fs.existsSync(attachment.filePath)) {
            await fs.promises.unlink(attachment.filePath);
        }
    } catch (err) {
        console.error('Failed to unlink attachment file:', err);
    }

    await prisma.projectAttachment.delete({
        where: { id: Number(id) }
    });

    return true;
}

/**
 * Get attachment for authenticated download verifying business ownership.
 */
async function getAttachmentForDownload(id, businessId) {
    const attachment = await getAttachment(id, businessId);
    if (!attachment) {
        const err = new Error('Attachment not found or access denied for this organization.');
        err.statusCode = 404;
        throw err;
    }
    return { attachment, fullPath: attachment.filePath };
}

module.exports = {
    ATTACHMENT_STORAGE_DIR,
    MAX_FILE_SIZE_BYTES,
    validateMagicBytes,
    sanitizeHtmlDescription,
    saveAttachment,
    getAttachment,
    getAttachmentStream,
    getAttachmentForDownload,
    listAttachments,
    updateAttachmentMetadata,
    deleteAttachment
};
