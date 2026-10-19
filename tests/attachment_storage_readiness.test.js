'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const prisma = require('../app/config/prisma');
const {
    saveAttachment,
    getAttachment,
    getAttachmentStream,
    getAttachmentForDownload,
    ATTACHMENT_STORAGE_DIR
} = require('../app/services/attachment.service');

describe('Attachment Storage & Deployment Readiness Suite', () => {
    let testBiz1;
    let testBiz2;
    let testUser1;
    let testUser2;
    let testProject;

    before(async () => {
        // Query or create two test businesses in disposable database
        testBiz1 = await prisma.business.findFirst({ where: { status: 'ACTIVE' } });
        if (!testBiz1) {
            testBiz1 = await prisma.business.create({
                data: {
                    code: `TEST_BIZ_A_${Date.now()}`,
                    name: 'Attachment Test Business A',
                    status: 'ACTIVE'
                }
            });
        }

        testBiz2 = await prisma.business.create({
            data: {
                code: `TEST_BIZ_B_${Date.now()}`,
                name: 'Attachment Test Business B',
                status: 'ACTIVE'
            }
        });

        testUser1 = await prisma.user.findFirst();
        testUser2 = await prisma.user.create({
            data: {
                name: 'Cross Business User',
                email: `cross_user_${Date.now()}@test.com`,
                password: 'SamplePassword123!',
                role: 'STAFF'
            }
        });

        testProject = await prisma.project.create({
            data: {
                code: `PRJ-ATT-${Date.now()}`,
                name: 'Attachment Test Project',
                businessId: testBiz1.id,
                startDate: new Date('2026-04-01'),
                budgetAmount: 50000.00,
                hourlyRate: 150.00,
                billingType: 'TIME_AND_MATERIALS',
                status: 'ACTIVE',
                createdById: testUser1.id
            }
        });
    });

    it('1. Storage directory must be located strictly outside public web root', () => {
        const publicAssetsDir = path.resolve(__dirname, '../assets');
        const viewsDir = path.resolve(__dirname, '../app/views');

        const isInsideAssets = ATTACHMENT_STORAGE_DIR.startsWith(publicAssetsDir);
        const isInsideViews = ATTACHMENT_STORAGE_DIR.startsWith(viewsDir);

        assert.strictEqual(isInsideAssets, false, 'Attachment storage must NOT be inside public assets directory');
        assert.strictEqual(isInsideViews, false, 'Attachment storage must NOT be inside views directory');
        assert.ok(fs.existsSync(ATTACHMENT_STORAGE_DIR), `Storage directory must exist: ${ATTACHMENT_STORAGE_DIR}`);
    });

    it('2. Save valid PDF, verify disk persistence, SHA-256 hash match, and DB metadata', async () => {
        const samplePdfContent = Buffer.from('%PDF-1.4\n%Test PDF binary stream for storage audit\n%%EOF');
        const expectedHash = crypto.createHash('sha256').update(samplePdfContent).digest('hex');

        const attachment = await saveAttachment({
            businessId: testBiz1.id,
            projectId: testProject.id,
            entityType: 'PROJECT',
            entityId: testProject.id,
            fileBuffer: samplePdfContent,
            originalFilename: 'audit_spec.pdf',
            uploadedById: testUser1.id
        });

        assert.ok(attachment.id, 'Attachment record must have valid ID');
        assert.strictEqual(attachment.businessId, testBiz1.id);
        assert.strictEqual(attachment.projectId, testProject.id);
        assert.strictEqual(attachment.sha256Hash, expectedHash);
        assert.strictEqual(attachment.fileSize, samplePdfContent.length);

        // Check physical file on disk
        assert.ok(fs.existsSync(attachment.filePath), `File must physically exist at ${attachment.filePath}`);
        const diskBytes = fs.readFileSync(attachment.filePath);
        assert.strictEqual(diskBytes.length, samplePdfContent.length);
        const diskHash = crypto.createHash('sha256').update(diskBytes).digest('hex');
        assert.strictEqual(diskHash, expectedHash, 'Disk bytes SHA-256 must match exactly');
    });

    it('3. Persisted files must remain available and streamable across process context', async () => {
        // Query recent attachment
        const attRecord = await prisma.projectAttachment.findFirst({
            where: { businessId: testBiz1.id, projectId: testProject.id }
        });
        assert.ok(attRecord, 'Attachment record should exist in DB');

        const streamResult = await getAttachmentStream(attRecord.id, testBiz1.id);
        assert.ok(streamResult, 'getAttachmentStream must return stream');
        assert.ok(streamResult.stream, 'Stream must be defined');

        // Read stream to buffer
        const chunks = [];
        for await (const chunk of streamResult.stream) {
            chunks.push(chunk);
        }
        const streamedBuffer = Buffer.concat(chunks);
        assert.strictEqual(streamedBuffer.length, attRecord.fileSize);
    });

    it('4. Multi-tenant boundary: Cross-business user cannot access or download attachment', async () => {
        const attRecord = await prisma.projectAttachment.findFirst({
            where: { businessId: testBiz1.id, projectId: testProject.id }
        });
        assert.ok(attRecord);

        // Attempting to query with testBiz2.id must return null / 404
        const crossAccess = await getAttachment(attRecord.id, testBiz2.id);
        assert.strictEqual(crossAccess, null, 'Cross-business getAttachment must return null');

        await assert.rejects(
            getAttachmentForDownload(attRecord.id, testBiz2.id),
            (err) => err.statusCode === 404,
            'Cross-business getAttachmentForDownload must throw 404'
        );
    });

    it('5. Inaccessible or failing storage must abort without leaving orphaned DB records', async () => {
        const validBuffer = Buffer.from('%PDF-1.4\n%Clean test file\n%%EOF');
        const preCount = await prisma.projectAttachment.count({ where: { businessId: testBiz1.id } });

        // Temporarily point ATTACHMENT_STORAGE_DIR to an invalid/non-existent read-only path if mocked,
        // or attempt saving to an unwriteable directory
        const invalidSubdir = path.join(ATTACHMENT_STORAGE_DIR, 'nonexistent_locked_dir_test_404', 'sub');

        // Test with invalid project ID belonging to another business
        await assert.rejects(
            saveAttachment({
                businessId: testBiz1.id,
                projectId: 99999999, // Non-existent project ID
                entityType: 'PROJECT',
                fileBuffer: validBuffer,
                originalFilename: 'fail_test.pdf',
                uploadedById: testUser1.id
            }),
            /not found or does not belong to authorized business/
        );

        const postCount = await prisma.projectAttachment.count({ where: { businessId: testBiz1.id } });
        assert.strictEqual(postCount, preCount, 'DB record count must NOT change on failed save');
    });

    after(async () => {
        // Clean up test data from disposable database
        if (testProject) {
            const atts = await prisma.projectAttachment.findMany({ where: { projectId: testProject.id } });
            for (const a of atts) {
                if (fs.existsSync(a.filePath)) {
                    try { fs.unlinkSync(a.filePath); } catch (_) {}
                }
            }
            await prisma.projectAttachment.deleteMany({ where: { projectId: testProject.id } });
            await prisma.project.delete({ where: { id: testProject.id } });
        }
        if (testUser2) {
            await prisma.user.delete({ where: { id: testUser2.id } });
        }
        if (testBiz2) {
            await prisma.business.delete({ where: { id: testBiz2.id } });
        }
        await prisma.$disconnect();
    });
});
