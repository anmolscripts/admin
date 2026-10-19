'use strict';

const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

// Load base .env for protected admin database connection
require('dotenv').config();

async function inspectProtectedAdmin() {
    let host = process.env.DATABASE_HOST || 'localhost';
    let port = Number(process.env.DATABASE_PORT || 3306);
    let user = process.env.DATABASE_USER || 'root';
    let password = process.env.DATABASE_PASSWORD;
    let database = 'admin';

    if (process.env.DATABASE_URL) {
        try {
            const parsed = new URL(process.env.DATABASE_URL);
            host = parsed.hostname || host;
            port = Number(parsed.port) || port;
            user = decodeURIComponent(parsed.username) || user;
            password = decodeURIComponent(parsed.password) || password;
        } catch (_) {}
    }

    const adapter = new PrismaMariaDb({ host, port, user, password, database, connectionLimit: 2 });
    const prisma = new PrismaClient({ adapter, log: ['error'] });

    try {
        const dbRes = await prisma.$queryRawUnsafe('SELECT DATABASE() AS current_db');
        const activeDb = dbRes[0]?.current_db || dbRes[0]?.['DATABASE()'];
        console.log(`[READONLY-INSPECTION] Target Database Verified: ${activeDb}`);

        if (activeDb !== 'admin') {
            console.error(`[ABORT] Expected 'admin' database, but connected to '${activeDb}'`);
            process.exit(1);
        }

        // 1. Project ID 1
        let project1 = null;
        try {
            project1 = await prisma.$queryRawUnsafe('SELECT id, code, name, businessId, createdAt FROM projects WHERE id = 1');
        } catch (e) { project1 = `Query error: ${e.message}`; }

        // 2. Attachment metadata ID 1
        let attachment1 = null;
        try {
            attachment1 = await prisma.$queryRawUnsafe('SELECT id, originalFilename, storedFilename, businessId, createdAt FROM project_attachments WHERE id = 1');
        } catch (e) {
            try {
                attachment1 = await prisma.$queryRawUnsafe('SELECT id, originalFilename, storedFilename, businessId, createdAt FROM attachments WHERE id = 1');
            } catch (e2) { attachment1 = `Table error: ${e2.message}`; }
        }

        // 3. DailyWorker ID 1
        let dailyWorker1 = null;
        try {
            dailyWorker1 = await prisma.$queryRawUnsafe('SELECT id, name, businessId, createdAt FROM daily_workers WHERE id = 1');
        } catch (e) { dailyWorker1 = `Table error: ${e.message}`; }

        // 4. Client IDs 9 and 10
        let clients = null;
        try {
            clients = await prisma.$queryRawUnsafe('SELECT id, name, businessId, createdAt FROM clients WHERE id IN (9, 10)');
        } catch (e) { clients = `Query error: ${e.message}`; }

        // 5. User IDs 8 and 9 (Omit passwordHash)
        let users = null;
        try {
            users = await prisma.$queryRawUnsafe('SELECT id, name, email, role, createdAt FROM users WHERE id IN (8, 9)');
        } catch (e) { users = `Query error: ${e.message}`; }

        // 6. Business IDs 3 and 4
        let businesses = null;
        try {
            businesses = await prisma.$queryRawUnsafe('SELECT id, name, code, createdAt FROM businesses WHERE id IN (3, 4)');
        } catch (e) { businesses = `Query error: ${e.message}`; }

        // 7. Business Memberships
        let memberships = null;
        try {
            memberships = await prisma.$queryRawUnsafe('SELECT id, userId, businessId, role, createdAt FROM business_memberships WHERE userId IN (1, 8, 9) OR businessId IN (3, 4)');
        } catch (e) { memberships = `Query error: ${e.message}`; }

        console.log('\n--- FORENSIC INSPECTION RESULTS ---');
        console.log('Project ID 1:', JSON.stringify(project1));
        console.log('Attachment ID 1:', JSON.stringify(attachment1));
        console.log('DailyWorker ID 1:', JSON.stringify(dailyWorker1));
        console.log('Clients 9 & 10:', JSON.stringify(clients));
        console.log('Users 8 & 9:', JSON.stringify(users));
        console.log('Businesses 3 & 4:', JSON.stringify(businesses));
        console.log('Memberships (Users 1, 8, 9 / Biz 3, 4):', JSON.stringify(memberships));

    } finally {
        await prisma.$disconnect();
    }
}

inspectProtectedAdmin().catch(console.error);
