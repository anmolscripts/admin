require('dotenv').config();

const { validateEnv } = require('./config/env');
const app = require('./app');
const prisma = require('./config/prisma');

// Validate runtime environment variables before listening
validateEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
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

    // 1. Stop accepting new HTTP requests
    server.close(async (err) => {
        if (err) {
            console.error('[SHUTDOWN] Error closing HTTP server:', err.message);
        } else {
            console.log('[SHUTDOWN] HTTP server closed successfully.');
        }

        // 2. Disconnect Prisma
        try {
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
    });

    // Close idle keep-alive connections if supported by Node runtime
    if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
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
