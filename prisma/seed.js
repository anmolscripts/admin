'use strict';

require('dotenv').config();

const prisma = require('../app/config/prisma');
const { DEFAULT_UNITS, MASTER_ITEMS } = require('./seed/common');
const { seedProduction } = require('./seed/production');
const { seedDevelopment } = require('./seed/development');

/**
 * Main Seed Dispatcher.
 *
 * Routes execution deterministically between Production and Development seed logic:
 * - Production: Strictly provisions system RBAC, units, items, and initial OWNER admin. Zero demo records.
 * - Development: Provisions system RBAC, units, items, development admin, and demo data.
 *
 * @param {Object} [options={}]
 * @param {boolean} [options.isProduction] Override production mode
 * @param {boolean} [options.seedDemoData] Override demo data flag
 * @param {string} [options.adminEmail] Explicit admin email
 * @param {string} [options.adminPassword] Explicit admin password
 * @returns {Promise<Object>} Seeding execution summary
 */
async function main(options = {}) {
    const isProduction = options.isProduction !== undefined
        ? options.isProduction
        : (process.env.NODE_ENV === 'production');

    if (isProduction) {
        return await seedProduction(prisma, options);
    } else {
        return await seedDevelopment(prisma, options);
    }
}

module.exports = main;
module.exports.main = main;
module.exports.DEFAULT_UNITS = DEFAULT_UNITS;
module.exports.MASTER_ITEMS = MASTER_ITEMS;

if (require.main === module) {
    main()
        .then(() => {
            console.log('Seed process finished successfully.');
        })
        .catch((error) => {
            console.error('Seed failed:', error);
            process.exitCode = 1;
        })
        .finally(async () => {
            await prisma.$disconnect();
        });
}