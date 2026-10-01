require('dotenv').config();

const express = require('express');
const path = require('path');

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
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
app.use(express.static(path.join(__dirname, '../assets')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session management
app.use(sessionMiddleware);

// CSRF protection for all state-changing requests
app.use(csrfProtection);

// Global EJS variables
app.use((req, res, next) => {
    res.locals.user = req.session ? req.session.user || null : null;
    next();
});

// Routes
app.use('/', authRoutes);
app.use('/', webRoutes);
app.use('/', adminRoutes);
app.use('/api', invoiceRoutes);

// Error handling
app.use(notFound);
app.use(errorHandler);

// Server startup
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;