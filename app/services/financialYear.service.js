const prisma = require('../config/prisma');

/**
 * Compute the financial year code for a given date.
 * Indian FY runs from 01-Apr-YYYY to 31-Mar-(YYYY+1).
 * Returns an object { code, startDate, endDate }.
 */
function computeFinancialYear(date) {
  const d = new Date(date);
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // month index 0-11, April is 3
  const nextYear = year + 1;
  const code = `${year}-${String(nextYear).slice(-2)}`;
  const startDate = new Date(year, 3, 1); // 01-Apr
  const endDate = new Date(nextYear, 2, 31, 23, 59, 59, 999); // 31-Mar end of day
  return { code, startDate, endDate };
}

/**
 * Get (or lazily create) the FinancialYear record for a given date.
 * @param {Date|string|number} date - Date object or parsable date string.
 * @returns {Promise<Object>} FinancialYear record.
 */
async function getFinancialYearForDate(date) {
  const { code } = computeFinancialYear(date);
  // Read‑only lookup – never creates a record
  const fy = await prisma.financialYear.findUnique({ where: { code } });
  if (!fy) {
    throw new Error(`FinancialYear with code ${code} not found`);
  }
  return fy;
}

/**
 * Create a new FinancialYear manually (used by admin UI).
 * @param {number} year - The starting year (e.g., 2026 for FY 2026-27).
 */
async function createFinancialYear(year) {
  const startDate = new Date(year, 3, 1);
  const endDate = new Date(year + 1, 2, 31, 23, 59, 59, 999);
  const code = `${year}-${String(year + 1).slice(-2)}`;
  // Ensure no overlapping FY exists
  await validateNoOverlap(startDate, endDate);
  return await prisma.financialYear.create({
    data: {
      code,
      startDate,
      endDate,
      status: 'OPEN',
      isCurrent: false,
    },
  });
}

/**
 * Ensure a FinancialYear exists for the given date, creating it if missing.
 * @param {Date|string|number} date - Date for which to ensure FY.
 * @returns {Promise<Object>} The FinancialYear record.
 */
async function ensureFinancialYear(date) {
  const { code, startDate, endDate } = computeFinancialYear(date);
  const existing = await prisma.financialYear.findUnique({ where: { code } });
  if (existing) {
    return existing;
  }
  await validateNoOverlap(startDate, endDate);
  const fy = await prisma.financialYear.create({
    data: {
      code,
      startDate,
      endDate,
      status: 'OPEN',
      isCurrent: false,
    },
  });
  return fy;
}

/**
 * Validate that a new financial year does not overlap any existing period.
 * Throws if an overlap is detected.
 */
async function validateNoOverlap(startDate, endDate, excludeId = null) {
  const overlapping = await prisma.financialYear.findFirst({
    where: {
      AND: [
        { startDate: { lte: endDate } },
        { endDate: { gte: startDate } },
        ...(excludeId ? [{ id: { not: excludeId } }] : []),
      ],
    },
  });
  if (overlapping) {
    throw new Error(`Financial year ${overlapping.code} overlaps with requested range ${startDate.toISOString()} - ${endDate.toISOString()}`);
  }
}

/**
 * Set the given FinancialYear as the current one, clearing the flag on others.
 * @param {number|string} id - The primary key of the FinancialYear to set as current.
 */
async function setCurrentFinancialYear(id) {
  await prisma.$transaction(async (tx) => {
    await tx.financialYear.updateMany({
      where: { isCurrent: true },
      data: { isCurrent: false },
    });
    await tx.financialYear.update({
      where: { id: Number(id) },
      data: { isCurrent: true },
    });
  });
}

/**
 * List all Financial Years ordered by start date descending.
 * @returns {Promise<Array<Object>>}
 */
async function listFinancialYears() {
  return await prisma.financialYear.findMany({
    orderBy: { startDate: 'desc' },
    include: {
      closedBy: { select: { id: true, name: true, email: true } },
      _count: {
        select: {
          journalEntries: true,
          invoices: true,
          payments: true,
          creditDebitNotes: true
        }
      }
    }
  });
}

/**
 * Get Financial Year by ID.
 * @param {number|string} id
 * @returns {Promise<Object>}
 */
async function getFinancialYearById(id) {
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    throw new Error('Invalid Financial Year ID.');
  }
  return await prisma.financialYear.findUnique({
    where: { id: numId },
    include: {
      closedBy: { select: { id: true, name: true, email: true } },
      _count: {
        select: {
          journalEntries: true,
          invoices: true,
          payments: true,
          creditDebitNotes: true
        }
      }
    }
  });
}

module.exports = {
  computeFinancialYear,
  getFinancialYearForDate,
  getFinancialYearById,
  createFinancialYear,
  ensureFinancialYear,
  setCurrentFinancialYear,
  listFinancialYears,
};
