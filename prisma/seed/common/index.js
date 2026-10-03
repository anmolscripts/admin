'use strict';

const rbacService = require('../../../app/services/rbac.service');

// Predefined Unit Master entries (13 standard units)
const DEFAULT_UNITS = [
    { name: 'Piece', symbol: 'PCS', description: 'Standard piece count' },
    { name: 'Meter', symbol: 'm', description: 'Length in meters' },
    { name: 'Unit', symbol: 'unit', description: 'Standard unit count' },
    { name: 'Project', symbol: 'Project', description: 'Fixed price project engagement' },
    { name: 'Hours', symbol: 'Hours', description: 'Time in hours' },
    { name: 'Months', symbol: 'Months', description: 'Duration in months' },
    { name: 'Units', symbol: 'Units', description: 'Quantity count' },
    { name: 'License', symbol: 'License', description: 'Software license seat or subscription' },
    { name: 'Year', symbol: 'Year', description: 'Annual subscription or duration' },
    { name: 'Package', symbol: 'Package', description: 'Bundled package' },
    { name: 'Set', symbol: 'Set', description: 'Matched set of components' },
    { name: 'Kilogram', symbol: 'KG', description: 'Weight in kilograms' },
    { name: 'Service', symbol: 'Service', description: 'Professional service delivery' }
];

// Provided Master Items (21 items)
const MASTER_ITEMS = [
    {
        name: 'Pipe Seamless S-40 Sudul 40 extra heavy pipe 40/50 mm PNG',
        unit: 'm',
        rate: 900.00
    },
    {
        name: 'Band Seamless 1BR with Lab Testing Reporting TC 50, 40 mm',
        unit: 'm',
        rate: 300.00
    },
    {
        name: 'Ball Valve L&T Audco 40/50 mm super strong extra autocut',
        unit: 'unit',
        rate: 6800.00
    },
    {
        name: 'Line Valve heat proof super strong extra autocut L&T',
        unit: 'unit',
        rate: 900.00
    },
    {
        name: 'Clamps industrial with fastener, nut bolt, super strong with Gaskit',
        unit: 'unit',
        rate: 300.00
    },
    {
        name: 'Tee 50mm with TC Lab Reporting 18R Seamless',
        unit: 'unit',
        rate: 1200.00
    },
    {
        name: 'Meter Gauge 4” dia looking pressure Liquid 10KG',
        unit: 'unit',
        rate: 2000.00
    },
    {
        name: 'Bullnose with brass nut Gaskit with reducer',
        unit: 'unit',
        rate: 1800.00
    },
    {
        name: 'Flexible Hydraulic Suraksha Long heavy',
        unit: 'unit',
        rate: 700.00
    },
    {
        name: 'Nitrogen Pressure holding Line testing',
        unit: 'unit',
        rate: 8500.00
    },
    {
        name: 'Labour charges, Welding, testing, fitting charges etc',
        unit: 'unit',
        rate: 145000.00
    },
    {
        name: 'TPT (Third Party Testing) by Govt Body IGL & Report',
        unit: 'unit',
        rate: 9500.00
    },
    {
        name: 'Paint, Primer, Cutting, Welding Rod, Loading & Unloading Fare',
        unit: 'unit',
        rate: 18000.00
    },
    {
        name: 'Sonolet Valve, Midas, Made in Japan, 40mm',
        unit: 'unit',
        rate: 18500.00
    },
    {
        name: 'DBR 8 zone, Panel automatic super sensor',
        unit: 'unit',
        rate: 22500.00
    },
    {
        name: 'Leak Detector LED Imported Auto Sensor LED',
        unit: 'unit',
        rate: 12500.00
    },
    {
        name: 'Hooter Alarm Auto Detect super power',
        unit: 'unit',
        rate: 2000.00
    },
    {
        name: 'Cabel 4 core super single controller',
        unit: 'unit',
        rate: 180.00
    },
    {
        name: 'Canduit Metal with fastener nut bolt',
        unit: 'unit',
        rate: 80.00
    },
    {
        name: 'Labour Charge Electronic working with TC',
        unit: 'unit',
        rate: 20000.00
    },
    {
        name: 'Imported Gas Meter 1 Bar super flame',
        unit: 'unit',
        rate: 68000.00
    }
];

/**
 * Seeds RBAC roles and permissions, unit master data, and item master data idempotently.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {Object} [adminUser=null] - Optional admin user to associate createdBy
 * @returns {Promise<{ unitsCreated: number, itemsCreated: number }>}
 */
async function seedCommon(prisma, adminUser = null) {
    // 1. RBAC Permissions and Default System Roles
    await rbacService.seedPermissionsAndRoles();

    // 2. Unit Master (13 predefined units)
    let unitsCreated = 0;
    for (const u of DEFAULT_UNITS) {
        const existingUnit = await prisma.unit.findUnique({
            where: { symbol: u.symbol }
        });
        if (!existingUnit) {
            await prisma.unit.create({
                data: {
                    name: u.name,
                    symbol: u.symbol,
                    description: u.description,
                    active: true,
                    createdById: adminUser ? adminUser.id : null
                }
            });
            unitsCreated++;
        }
    }

    // 3. Item Master (21 predefined items)
    let itemsCreated = 0;
    for (const item of MASTER_ITEMS) {
        const trimmedName = item.name.trim();
        const existingItem = await prisma.item.findUnique({
            where: { name: trimmedName }
        });

        if (!existingItem) {
            await prisma.item.create({
                data: {
                    name: trimmedName,
                    unit: item.unit.trim(),
                    rate: item.rate,
                    active: true,
                    createdById: adminUser ? adminUser.id : null
                }
            });
            itemsCreated++;
        }
    }

    return { unitsCreated, itemsCreated };
}

module.exports = {
    DEFAULT_UNITS,
    MASTER_ITEMS,
    seedCommon
};
