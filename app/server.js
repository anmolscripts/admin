require('dotenv').config();

const { validateEnv } = require('./config/env');
const { assertSchemaReadiness } = require('./config/schemaReadiness');
const app = require('./app');
const prisma = require('./config/prisma');

// Validate runtime environment variables before listening
validateEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

let server = null;

async function start() {
    await assertSchemaReadiness();
    server = app.listen(PORT, HOST, () => {
        console.log(`Server running at http://${HOST}:${PORT}`);
    });
}

start().catch(err => {
    console.error(`[STARTUP FAILURE] ${err.message}`);
    process.exit(1);
});

let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SHUTDOWN] Received ${signal}. Starting graceful shutdown...`);

    // Sane shutdown timer (10s force exit)
    const forceExitTimer = setTimeout(() => {
        console.error('[SHUTDOWN] Forceful shutdown timeout exceeded (10s). Terminating process.');
        process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    const cleanup = async () => {
        try {
            const { sessionStore } = require('./config/session');
            if (sessionStore && typeof sessionStore.close === 'function') {
                sessionStore.close();
            }
            if (typeof prisma.disconnectPrisma === 'function') {
                await prisma.disconnectPrisma();
            } else if (typeof prisma.$disconnect === 'function') {
                await prisma.$disconnect();
            }
            console.log('[SHUTDOWN] Database connections closed.');
        } catch (dbErr) {
            console.error('[SHUTDOWN] Error disconnecting from database:', dbErr.message);
        }
        console.log('[SHUTDOWN] Graceful shutdown complete.');
        clearTimeout(forceExitTimer);
        process.exit(0);
    };

    if (server) {
        server.close(async (err) => {
            if (err) {
                console.error('[SHUTDOWN] Error closing HTTP server:', err.message);
            } else {
                console.log('[SHUTDOWN] HTTP server closed successfully.');
            }
            await cleanup();
        });

        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
    } else {
        await cleanup();
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error.message || error);
    gracefulShutdown('uncaughtException');
});

module.exports = server;
