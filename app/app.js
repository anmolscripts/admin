
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
app.use(express.static(path.join(__dirname, '../assets')));

// Body parser
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Test route
app.get('/test', (req, res) => {
    res.send('Spark Admin server is working!');
});

// Dashboard route
app.get('/', (req, res) => {
    res.render('dashboard/index', {
        pageTitle: 'Dashboard'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});