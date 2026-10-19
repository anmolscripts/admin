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

const attachmentStorage = multer.memoryStorage();

const ALLOWED_ATTACHMENT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_ATTACHMENT_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
const PROHIBITED_EXTS = ['.exe', '.bat', '.cmd', '.sh', '.bin', '.dll', '.msi', '.vbs', '.js', '.svg', '.html', '.htm', '.php', '.pif', '.scr'];

const attachmentFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    // 1. Prohibited dangerous extensions
    if (PROHIBITED_EXTS.includes(ext)) {
        const error = new Error(`Unsupported file type: extension '${ext}' is strictly prohibited.`);
        error.code = 'INVALID_FILE_TYPE';
        error.status = 415;
        error.statusCode = 415;
        return cb(error, false);
    }

    // 2. Both extension and MIME type must be in allowed white-lists
    if (!ALLOWED_ATTACHMENT_EXTS.includes(ext) || !ALLOWED_ATTACHMENT_MIMES.includes(mime)) {
        const error = new Error(`Unsupported media type. Only PDF documents (.pdf) and images (.jpg, .jpeg, .png, .webp) are supported.`);
        error.code = 'INVALID_FILE_TYPE';
        error.status = 415;
        error.statusCode = 415;
        return cb(error, false);
    }

    // 3. Extension to MIME correlation check
    if (ext === '.pdf' && mime !== 'application/pdf') {
        const error = new Error('MIME type does not match .pdf file extension.');
        error.code = 'INVALID_FILE_TYPE';
        error.status = 415;
        error.statusCode = 415;
        return cb(error, false);
    }

    cb(null, true);
};

const uploadAttachmentFile = multer({
    storage: attachmentStorage,
    fileFilter: attachmentFilter,
    limits: {
        fileSize: 15 * 1024 * 1024 // 15MB max
    }
});

/**
 * Express middleware wrapper for attachment uploads that guarantees documented
 * client error responses (HTTP 415 Unsupported Media Type or HTTP 400/413)
 * without leaking internal server stack traces or returning HTTP 500.
 */
function handleAttachmentUpload(fieldName = 'file') {
    const upload = uploadAttachmentFile.single(fieldName);
    return (req, res, next) => {
        upload(req, res, (err) => {
            if (err) {
                if (err instanceof multer.MulterError) {
                    if (err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({
                            success: false,
                            error: 'File size exceeds maximum allowed limit of 15MB.'
                        });
                    }
                    return res.status(400).json({
                        success: false,
                        error: `File upload error: ${err.message}`
                    });
                }
                const statusCode = err.status || err.statusCode || (err.code === 'INVALID_FILE_TYPE' ? 415 : 400);
                return res.status(statusCode).json({
                    success: false,
                    error: err.message || 'Invalid or unsupported file upload.'
                });
            }
            next();
        });
    };
}

module.exports = {
    uploadAvatar,
    uploadAttachmentFile,
    handleAttachmentUpload,
    UPLOAD_DIR
};
