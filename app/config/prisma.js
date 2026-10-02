const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

let prismaInstance = null;

function createPrismaClient() {
    if (prismaInstance) {
        return prismaInstance;
    }

    let host = process.env.DATABASE_HOST || 'localhost';
    let port = Number(process.env.DATABASE_PORT || 3306);
    let user = process.env.DATABASE_USER;
    let password = process.env.DATABASE_PASSWORD;
    let database = process.env.DATABASE_NAME;

    // Fallback: parse from DATABASE_URL if granular parameters are not supplied
    if (process.env.DATABASE_URL && (!user || !database)) {
        try {
            const parsed = new URL(process.env.DATABASE_URL);
            host = parsed.hostname || host;
            port = Number(parsed.port) || port;
            user = decodeURIComponent(parsed.username) || user;
            password = decodeURIComponent(parsed.password) || password;
            database = (parsed.pathname ? parsed.pathname.replace(/^\//, '') : '') || database;
        } catch (_) {
            // Ignore URL parsing errors, fallback to default params
        }
    }

    const adapter = new PrismaMariaDb({
        host,
        port,
        user,
        password,
        database
    });

    prismaInstance = new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
    });

    return prismaInstance;
}

const prisma = createPrismaClient();

// Graceful shutdown handling
let isDisconnecting = false;
async function disconnectPrisma() {
    if (isDisconnecting || !prismaInstance) return;
    isDisconnecting = true;
    try {
        await prismaInstance.$disconnect();
    } catch (error) {
        console.error('Error during Prisma disconnect:', error.message || error);
    }
}

process.on('beforeExit', async () => {
    await disconnectPrisma();
});

module.exports = prisma;
module.exports.disconnectPrisma = disconnectPrisma;
