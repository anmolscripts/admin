const invitationService = require('../services/invitation.service');

async function showSetupPasswordPage(req, res) {
    const rawToken = req.params.token;
    try {
        const check = await invitationService.getInvitationByToken(rawToken);

        if (!check.valid) {
            let errorMsg = 'This invitation link is invalid or has expired.';
            if (check.reason === 'ALREADY_ACCEPTED') {
                errorMsg = 'This invitation has already been accepted. Please sign in with your credentials.';
            } else if (check.reason === 'REVOKED') {
                errorMsg = 'This invitation has been revoked by an administrator.';
            } else if (check.reason === 'EXPIRED') {
                errorMsg = 'This invitation link has expired. Please ask your administrator to send a new invitation.';
            }

            return res.status(400).render('auth/login', {
                pageTitle: 'Invitation Invalid',
                error: errorMsg,
                email: ''
            });
        }

        res.render('auth/setup-password', {
            pageTitle: 'Set Password',
            user: check.user,
            token: rawToken,
            error: null,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        console.error('[INVITATION] Error loading invitation setup:', err);
        return res.status(500).render('errors/500', {
            pageTitle: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err : null
        });
    }
}

async function handleSetupPassword(req, res) {
    const rawToken = req.params.token;
    const { password, confirmPassword } = req.body || {};

    try {
        const csrfToken = req.session ? req.session.csrfToken : '';
        if (!password || !confirmPassword) {
            const check = await invitationService.getInvitationByToken(rawToken);
            return res.status(400).render('auth/setup-password', {
                pageTitle: 'Set Password',
                user: check.user,
                token: rawToken,
                csrfToken,
                error: 'Both password and confirmation are required.'
            });
        }

        if (password !== confirmPassword) {
            const check = await invitationService.getInvitationByToken(rawToken);
            return res.status(400).render('auth/setup-password', {
                pageTitle: 'Set Password',
                user: check.user,
                token: rawToken,
                csrfToken,
                error: 'Passwords do not match.'
            });
        }

        const complexity = invitationService.validatePasswordComplexity(password);
        if (!complexity.valid) {
            const check = await invitationService.getInvitationByToken(rawToken);
            return res.status(400).render('auth/setup-password', {
                pageTitle: 'Set Password',
                user: check.user,
                token: rawToken,
                csrfToken,
                error: complexity.message
            });
        }

        const ua = req.headers ? req.headers['user-agent'] : null;
        await invitationService.acceptInvitation(rawToken, password, req.ip, ua);

        return res.redirect('/login?setup=success');
    } catch (err) {
        console.error('[INVITATION] Error accepting invitation:', err);
        const check = await invitationService.getInvitationByToken(rawToken).catch(() => ({ valid: false }));
        return res.status(400).render('auth/setup-password', {
            pageTitle: 'Set Password',
            user: check.user || null,
            token: rawToken,
            csrfToken: req.session ? req.session.csrfToken : '',
            error: err.message || 'Failed to complete password setup.'
        });
    }
}

module.exports = {
    showSetupPasswordPage,
    handleSetupPassword
};
