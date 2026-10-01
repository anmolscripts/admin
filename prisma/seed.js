require('dotenv').config();

const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const adapter = new PrismaMariaDb({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME
});

const prisma = new PrismaClient({ adapter });

async function main() {
    const email = 'admin@email.com';

    const existingUser = await prisma.user.findUnique({
        where: { email }
    });

    if (existingUser) {
        console.log('Development admin already exists:', email);
        return;
    }

    const password = process.env.SEED_ADMIN_PASSWORD;

    if (!password) {
        throw new Error('SEED_ADMIN_PASSWORD is missing from .env');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const admin = await prisma.user.create({
        data: {
            name: 'Administrator',
            email,
            password: passwordHash,
            role: 'ADMIN',
            active: true
        }
    });

    console.log('Development admin created:', admin.email);
}

main()
    .catch((error) => {
        console.error('Seed failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });