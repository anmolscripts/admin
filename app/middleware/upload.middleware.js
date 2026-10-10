const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '../../assets/uploads/avatars');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
        const uniqueName = `${crypto.randomUUID()}${safeExt}`;
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];

    if (!allowedMimes.includes(file.mimetype) || !allowedExts.includes(ext)) {
        const error = new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.');
        error.code = 'INVALID_FILE_TYPE';
        return cb(error, false);
    }

    // Explicitly reject svg or executable files
    if (ext === '.svg' || file.mimetype.includes('svg')) {
        const error = new Error('SVG images are not allowed for profile avatars.');
        error.code = 'INVALID_FILE_TYPE';
        return cb(error, false);
    }

    cb(null, true);
};

const uploadAvatar = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 2 * 1024 * 1024 // 2MB max
    }
});

module.exports = {
    uploadAvatar,
    UPLOAD_DIR
};
