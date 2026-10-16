'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — PRISMA DATABASE SESSION STORE FOR EXPRESS-SESSION
 * ==============================================================================
 *
 * Implements a durable, database-backed session store for MariaDB/MySQL using Prisma:
 * - Compatible with express-session Store API (get, set, destroy, touch, clear).
 * - Persists sessions across application restarts and horizontal scaling.
 * - Automatically purges expired sessions via periodic sweep.
 * - Closes cleanly during graceful application shutdown.
 * ==============================================================================
 */

const session = require('express-session');
const prisma = require('./prisma');

class PrismaSessionStore extends session.Store {
    /**
     * @param {Object} options
     * @param {number} [options.checkIntervalMs=900000] - Interval to sweep expired sessions (default 15m)
     * @param {number} [options.defaultMaxAgeMs=28800000] - Default session TTL (default 8 hours)
     */
    constructor(options = {}) {
        super();
        this.checkIntervalMs = options.checkIntervalMs || 15 * 60 * 1000;
        this.defaultMaxAgeMs = options.defaultMaxAgeMs || 8 * 60 * 60 * 1000;
        this.isClosed = false;

        // Start background expiration sweep
        this.sweepTimer = setInterval(() => {
            this.purgeExpiredSessions().catch(() => {});
        }, this.checkIntervalMs);

        // Do not keep Node process alive solely for session sweep timer
        if (this.sweepTimer && typeof this.sweepTimer.unref === 'function') {
            this.sweepTimer.unref();
        }
    }

    /**
     * Fetch session by SID
     */
    async get(sid, callback) {
        if (this.isClosed) return callback(new Error('Session store is closed.'));
        try {
            const record = await prisma.session.findUnique({
                where: { sid }
            });

            if (!record) {
                return callback(null, null);
            }

            // Check expiration
            if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
                await this.destroy(sid, () => {});
                return callback(null, null);
            }

            const data = JSON.parse(record.data);
            return callback(null, data);
        } catch (err) {
            return callback(err);
        }
    }

    /**
     * Commit session data by SID
     */
    async set(sid, sessionData, callback) {
        if (this.isClosed) return callback(new Error('Session store is closed.'));
        try {
            let expiresAt;
            if (sessionData && sessionData.cookie && sessionData.cookie.expires) {
                expiresAt = new Date(sessionData.cookie.expires);
            } else {
                expiresAt = new Date(Date.now() + this.defaultMaxAgeMs);
            }

            const data = JSON.stringify(sessionData || {});

            await prisma.session.upsert({
                where: { sid },
                create: {
                    id: sid,
                    sid,
                    data,
                    expiresAt
                },
                update: {
                    data,
                    expiresAt,
                    updatedAt: new Date()
                }
            });

            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }

    /**
     * Touch session to update expiration
     */
    async touch(sid, sessionData, callback) {
        if (this.isClosed) return callback(new Error('Session store is closed.'));
        try {
            let expiresAt;
            if (sessionData && sessionData.cookie && sessionData.cookie.expires) {
                expiresAt = new Date(sessionData.cookie.expires);
            } else {
                expiresAt = new Date(Date.now() + this.defaultMaxAgeMs);
            }

            await prisma.session.updateMany({
                where: { sid },
                data: { expiresAt, updatedAt: new Date() }
            });

            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    /**
     * Destroy session by SID
     */
    async destroy(sid, callback) {
        if (this.isClosed) {
            if (callback) callback(new Error('Session store is closed.'));
            return;
        }
        try {
            await prisma.session.deleteMany({
                where: { sid }
            });
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    /**
     * Purge all expired sessions from database
     */
    async purgeExpiredSessions() {
        if (this.isClosed) return;
        try {
            await prisma.session.deleteMany({
                where: {
                    expiresAt: { lte: new Date() }
                }
            });
        } catch (_) {}
    }

    /**
     * Clear all sessions (e.g. for testing)
     */
    async clear(callback) {
        try {
            await prisma.session.deleteMany({});
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    /**
     * Cleanly shut down the store
     */
    close() {
        this.isClosed = true;
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }
}

module.exports = PrismaSessionStore;
