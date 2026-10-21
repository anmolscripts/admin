const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

class UnauthorizedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnauthorizedError';
        this.statusCode = 401;
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
 * Validates raster magic bytes (PNG, JPEG, WebP)
 */
function validateRasterMagicBytes(filePath) {
    if(Buffer.isBuffer(filePath)) return validateRasterBuffer(filePath);
    if (!fs.existsSync(filePath)) {
        return false;
    }

    const buffer = Buffer.alloc(16);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    return validateRasterBuffer(buffer);
}
function validateRasterBuffer(buffer) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
                  buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;

    // JPEG: FF D8 FF
    const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;

    // WebP: RIFF .... WEBP
    const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

    return isPng || isJpeg || isWebp;
}

/**
 * Remove avatar file safely from assets/uploads/avatars
 */
function removeAvatarFile(avatarUrl) {
    if (!avatarUrl || typeof avatarUrl !== 'string') return;
    if (!avatarUrl.startsWith('/uploads/avatars/')) return;

    const filename = path.basename(avatarUrl);
    // Path traversal defense: ensure basename has no path separators
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return;

    const fullPath = path.join(__dirname, '../../assets/uploads/avatars', filename);
    try {
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    } catch (err) {
        console.warn('[AVATAR CLEANUP WARNING]: Could not delete file:', err.message);
    }
}

/**
 * Get profile for authenticated user
 */
async function getUserProfile(userId) {
    const user = await prisma.user.findUnique({
        where: { id: Number(userId) },
        select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
            status: true,
            createdAt: true,
            lastLoginAt: true,
            assignedRole: {
                select: {
                    name: true,
                    description: true
                }
            }
        }
    });

    if (!user) {
        throw new ValidationError('User not found.');
    }

    return user;
}

/**
 * Update personal profile details
 */
async function updateUserProfile(userId, data = {}, file = null) {
    const id = Number(userId);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
        throw new ValidationError('User not found.');
    }

    if(typeof data.name!=='string' || typeof data.email!=='string' || (data.phone!=null && typeof data.phone!=='string')) throw new ValidationError('Name, email and phone must contain text.');
    const name = (data.name || '').trim();
    if (!name || name.length < 2 || name.length > 100) {
        if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw new ValidationError('Full name must be at least 2 characters.');
    }

    const email = (data.email || '').trim().toLowerCase();
    if (!email || email.length>191 || !email.includes('@')) {
        if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw new ValidationError('A valid email address is required.');
    }

    if (email !== existing.email.toLowerCase()) {
        const emailTaken = await prisma.user.findFirst({
            where: {
                email,
                id: { not: id }
            }
        });
        if (emailTaken) {
            if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
            throw new ConflictError('This email is already in use by another account.');
        }
    }

    const phone = data.phone !== undefined ? (data.phone ? data.phone.trim() : null) : existing.phone;

    if(phone && phone.length>50) throw new ValidationError('Phone number must not exceed 50 characters.');
    let newAvatarUrl = existing.avatarUrl;
    if (file) {
        // Validate magic bytes
        if (!validateRasterMagicBytes(file.buffer || file.path)) {
            if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
            throw new ValidationError('Invalid image content. Only authentic PNG, JPEG, and WebP images are allowed.');
        }

        if(file.buffer) {
            const ext=path.extname(file.originalname || '').toLowerCase();
            if(!['.png','.jpg','.jpeg','.webp'].includes(ext)) throw new ValidationError('Unsupported image extension.');
            const directory=path.join(__dirname,'../../assets/uploads/avatars');
            fs.mkdirSync(directory,{recursive:true});
            file.path=path.join(directory,require('node:crypto').randomUUID()+ext);
            fs.writeFileSync(file.path,file.buffer,{flag:'wx'});
        }
        const safeFilename = path.basename(file.path);
        newAvatarUrl = `/uploads/avatars/${safeFilename}`;


    }

    // Role cannot be updated via personal profile
    let updated;
    try { updated = await prisma.user.update({
        where: { id },
        data: {
            name,
            email,
            phone,
            avatarUrl: newAvatarUrl
        },
        select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
            status: true
        }
    });

    } catch(error) {
        if(file?.path && newAvatarUrl!==existing.avatarUrl) removeAvatarFile(newAvatarUrl);
        if(error.code==='P2002') throw new ConflictError('This email is already in use by another account.');
        throw error;
    }
    if(file && existing.avatarUrl && existing.avatarUrl!==newAvatarUrl) removeAvatarFile(existing.avatarUrl);
    return updated;
}

/**
 * Change password
 */
async function changePassword(userId, { currentPassword, newPassword, confirmPassword }) {
    const id = Number(userId);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
        throw new ValidationError('User not found.');
    }

    if (!currentPassword) {
        throw new ValidationError('Current password is required.');
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
        throw new UnauthorizedError('Current password is incorrect.');
    }

    if (!newPassword || newPassword.length < 8) {
        throw new ValidationError('New password must be at least 8 characters long.');
    }

    if (newPassword !== confirmPassword) {
        throw new ValidationError('New password and confirmation do not match.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    const updated = await prisma.user.updateMany({
        where: { id, password: user.password },
        data: { password: hashedPassword }
    });
    if (!updated.count) throw new ConflictError('Password changed concurrently. Sign in again before retrying.');

    return { success: true, message: 'Password changed successfully.', credentialVersion: require('./auth.service').getCredentialVersion({ id, password: hashedPassword }) };
}

module.exports = {
    ValidationError,
    UnauthorizedError,
    ConflictError,
    getUserProfile,
    updateUserProfile,
    changePassword,
    validateRasterMagicBytes,
    removeAvatarFile
};
