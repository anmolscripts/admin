/**
 * In-memory brute-force rate limiter for authentication routes.
 * Tracks failed login attempts per client IP.
 */

const attempts = new Map();

// Configuration defaults
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10; // Max failed attempts per window

// Periodic cleanup of expired entries
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of attempts.entries()) {
        if (now > data.resetTime) {
            attempts.delete(key);
        }
    }
}, 5 * 60 * 1000).unref(); // unref so it does not keep process open

/**
 * NOTE ON ARCHITECTURE:
 * This rate limiter is strictly process-local (in-memory Map).
 * It is suitable for development and single-instance environments.
 * For production environments or horizontally scaled multi-instance deployments,
 * replace this in-memory store with a shared, persistent store (such as Redis or Memcached)
 * to ensure rate-limit consistency across instances.
 */

function getClientIdentifier(req) {
    if (!req) return '127.0.0.1';
    return req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

function loginRateLimiter(req, res, next) {
    // If rate limiting is disabled for specific test runs
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
        return next();
    }

    const key = getClientIdentifier(req);
    const now = Date.now();
    const record = attempts.get(key);

    if (record) {
        if (now > record.resetTime) {
            // Window has expired; reset
            attempts.delete(key);
        } else if (record.count >= MAX_ATTEMPTS) {
            const retryAfterSec = Math.ceil((record.resetTime - now) / 1000);
            res.setHeader('Retry-After', retryAfterSec);

            return res.status(429).render('auth/login', {
                pageTitle: 'Login',
                error: `Too many failed login attempts. Please try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
                email: req.body && req.body.email ? req.body.email.trim() : ''
            });
        }
    }

    next();
}

function recordFailedLogin(req) {
    const key = getClientIdentifier(req);
    const now = Date.now();
    const record = attempts.get(key);

    if (!record || now > record.resetTime) {
        attempts.set(key, {
            count: 1,
            resetTime: now + WINDOW_MS
        });
    } else {
        record.count += 1;
    }
}

function resetLoginAttempts(req) {
    const key = getClientIdentifier(req);
    attempts.delete(key);
}

module.exports = {
    loginRateLimiter,
    recordFailedLogin,
    resetLoginAttempts,
    // Exported for testing/inspection
    _attempts: attempts
};
