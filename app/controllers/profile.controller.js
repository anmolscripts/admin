const profileService = require('../services/profile.service');

async function renderProfile(req, res, next) {
    try {
        const userId = req.session.user.id;
        const profile = await profileService.getUserProfile(userId);
        res.render('profile/index', {
            pageTitle: 'My Profile',
            pageSubtitle: 'Manage your personal account information, security credentials, and avatar.',
            profile,
            user: profile,
            csrfToken: req.session ? req.session.csrfToken : '',
            success: req.query.success === 'true',
            passwordSuccess: req.query.passwordSuccess === 'true'
        });
    } catch (err) {
        next(err);
    }
}

async function updateProfile(req, res) {
    try {
        const userId = req.session.user.id;
        if(req.profileUploadError) throw req.profileUploadError;
        const updated = await profileService.updateUserProfile(userId, req.body, req.file);

        // Synchronize active session user object
        req.session.user.name = updated.name;
        req.session.user.email = updated.email;
        if (updated.avatarUrl) {
            req.session.user.avatarUrl = updated.avatarUrl;
        }

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, user: updated });
        }

        return res.redirect('/profile?success=true');
    } catch (err) {
        const profile = await profileService.getUserProfile(req.session.user.id).catch(() => req.session.user);
        const statusCode = err.statusCode || (err instanceof profileService.ValidationError ? 400 : (err instanceof profileService.ConflictError ? 409 : 500));

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(statusCode).json({ success: false, error: err.message });
        }

        return res.status(statusCode).render('profile/index', {
            pageTitle: 'My Profile',
            pageSubtitle: 'Manage your personal account information, security credentials, and avatar.',
            profile: { ...profile, ...Object.fromEntries(['name','email','phone'].filter(key=>typeof req.body?.[key]==='string').map(key=>[key,req.body[key]])) },
            user: profile,
            error: err.message,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    }
}

async function changePassword(req, res) {
    try {
        const userId = req.session.user.id;
        const result = await profileService.changePassword(userId, req.body);
        req.session.credentialVersion = result.credentialVersion;
        await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, message: 'Password updated successfully.' });
        }

        return res.redirect('/profile?passwordSuccess=true');
    } catch (err) {
        const profile = await profileService.getUserProfile(req.session.user.id).catch(() => req.session.user);
        const statusCode = err instanceof profileService.UnauthorizedError ? 401 : 400;

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(statusCode).json({ success: false, error: err.message });
        }

        return res.status(statusCode).render('profile/index', {
            pageTitle: 'My Profile',
            pageSubtitle: 'Manage your personal account information, security credentials, and avatar.',
            profile,
            user: profile,
            passwordError: err.message,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    }
}

module.exports = {
    renderProfile,
    updateProfile,
    changePassword
};
