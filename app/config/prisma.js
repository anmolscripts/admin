const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

let prismaInstance = null;

function createPrismaClient() {
    if (prismaInstance) {
        return prismaInstance;
    }

    const host = process.env.DATABASE_HOST || 'localhost';
    const port = Number(process.env.DATABASE_PORT || 3306);
    const user = process.env.DATABASE_USER;
    const password = process.env.DATABASE_PASSWORD;
    const database = process.env.DATABASE_NAME;

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
        console.error('Error during Prisma disconnect:', error);
    }
}

process.on('SIGINT', async () => {
    await disconnectPrisma();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await disconnectPrisma();
    process.exit(0);
});

process.on('beforeExit', async () => {
    await disconnectPrisma();
});

module.exports = prisma;
