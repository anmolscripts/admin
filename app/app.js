const express = require('express');
const path = require('path');
const session = require('express-session');
require('dotenv').config();

const webRoutes = require('./routes/web.routes');
const authRoutes = require('./routes/auth.routes');

const {
    notFound,
    errorHandler
} = require('./middleware/error.middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '../assets')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());


// Session
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'spark-admin-secret',
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: false,
            maxAge: 1000 * 60 * 60 * 8
        }
    })
);


// Global EJS variables
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});


// Routes
app.use('/', authRoutes);
app.use('/', webRoutes);


// Error handling
app.use(notFound);
app.use(errorHandler);


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});