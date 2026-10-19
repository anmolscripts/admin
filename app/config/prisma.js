require('dotenv').config();
const isTestExecution = process.env.NODE_ENV === 'test' ||
                        process.argv.some(arg => typeof arg === 'string' && (arg.includes('--test') || arg.includes('tests\\') || arg.includes('tests/')));
if (isTestExecution) {
  process.env.NODE_ENV = 'test';
  require('dotenv').config({ path: '.env.test', override: true });
}
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

    const protectedDbs = ['admin', 'spark_admin', 'spark_admin_prod', 'spark_admin_test', 'spark_admin_prod_test'];
    if (isTestExecution && (!database || protectedDbs.includes(database.toLowerCase()))) {
        throw new Error(`[PRISMA GUARD]: Direct connection to protected or unspecified database "${database}" is strictly prohibited during test execution.`);
    }

    const adapter = new PrismaMariaDb({
        host,
        port,
        user,
        password,
        database,
        connectionLimit: Number(process.env.DB_POOL_LIMIT) || 30
    });

    prismaInstance = new PrismaClient({
        adapter,
        transactionOptions: {
            maxWait: 10000,
            timeout: 20000
        },
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
