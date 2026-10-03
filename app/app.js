require('dotenv').config();

const express = require('express');
const path = require('path');

const prisma = require('./config/prisma');
const { sessionMiddleware } = require('./config/session');
const { csrfProtection } = require('./middleware/csrf.middleware');
const webRoutes = require('./routes/web.routes');
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const invoiceRoutes = require('./routes/invoice.routes');

const {
    notFound,
    errorHandler
} = require('./middleware/error.middleware');

const app = express();

// Trust reverse proxy (Nginx) in production or when explicitly configured
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
}

// Basic production-safe security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
app.use(express.static(path.join(__dirname, '../assets')));

// Body parsing with safe size limits (2MB protects against unbounded memory exhaustion while supporting multi-item documents)
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '2mb';
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
app.use(express.json({ limit: BODY_LIMIT }));

// Health check endpoint (public, monitoring probe, zero session/CSRF overhead)
app.get('/health', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            database: 'connected'
        });
    } catch (err) {
        return res.status(503).json({
            status: 'degraded',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            database: 'disconnected'
        });
    }
});

const teamRoutes = require('./routes/team.routes');
const { attachUserPermissions } = require('./middleware/permission.middleware');

// Session management
app.use(sessionMiddleware);

// CSRF protection for all state-changing requests
app.use(csrfProtection);

// Global EJS variables & RBAC permission resolution
app.use((req, res, next) => {
    res.locals.user = req.session ? req.session.user || null : null;
    res.locals.currentPath = req.path;
    next();
});
app.use(attachUserPermissions);

// Routes
app.use('/', authRoutes);
app.use('/', webRoutes);
app.use('/', adminRoutes);
app.use('/api', invoiceRoutes);
app.use('/api', teamRoutes);

// Error handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;