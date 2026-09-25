const express = require('express');

const router = express.Router();


// ==========================================
// Login Page
// ==========================================

router.get('/login', (req, res) => {

    // Already logged in
    if (req.session.user) {
        return res.redirect('/');
    }

    res.render('auth/login', {
        pageTitle: 'Login',
        error: null
    });

});


// ==========================================
// Login Submit
// ==========================================

router.post('/login', (req, res) => {

    const { email, password } = req.body;

    // Development credentials
    const validUser = {
        id: 1,
        name: 'Administrator',
        email: 'admin@email.com',
        password: 'admin123'
    };

    // Validate credentials
    if (
        email !== validUser.email ||
        password !== validUser.password
    ) {

        return res.status(401).render('auth/login', {
            pageTitle: 'Login',
            error: 'Invalid email or password.'
        });

    }

    // Create session
    req.session.user = {
        id: validUser.id,
        name: validUser.name,
        email: validUser.email
    };

    // Redirect to dashboard
    res.redirect('/');

});


// ==========================================
// Logout
// ==========================================

router.get('/logout', (req, res) => {

    req.session.destroy((error) => {

        if (error) {
            console.error('Logout error:', error);

            return res.status(500).send(
                'Unable to logout.'
            );
        }

        res.clearCookie('connect.sid');

        res.redirect('/login');

    });

});


module.exports = router;