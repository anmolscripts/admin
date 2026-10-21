const prisma = require('../config/prisma');

/**
 * Compute the financial year code for a given date.
 * Indian FY runs from 01-Apr-YYYY to 31-Mar-(YYYY+1).
 * Returns an object { code, startDate, endDate }.
 */
function computeFinancialYear(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('A valid financial year date is required.');
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
async function getFinancialYearForDate(date, businessId = null) {
  let activeBusinessId = (businessId !== null && businessId !== undefined) ? parseInt(businessId, 10) : null;
  if (!activeBusinessId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
    activeBusinessId = 1;
  }
  const { code } = computeFinancialYear(date);
  const where = { code };
  if (activeBusinessId) where.businessId = activeBusinessId;
  const fy = await prisma.financialYear.findFirst({ where });
  if (!fy) {
    throw new Error(`FinancialYear with code ${code} not found`);
  }
  return fy;
}

/**
 * Create a new FinancialYear manually (used by admin UI).
 * @param {number} year - The starting year (e.g., 2026 for FY 2026-27).
 * @param {number} businessId
 */
async function createFinancialYear(year, businessId = null) {
  let activeBusinessId = (businessId !== null && businessId !== undefined) ? parseInt(businessId, 10) : null;
  if (!activeBusinessId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
    activeBusinessId = 1;
  }
  const startDate = new Date(year, 3, 1);
  const endDate = new Date(year + 1, 2, 31, 23, 59, 59, 999);
  const code = `${year}-${String(year + 1).slice(-2)}`;
  // Ensure no overlapping FY exists
  await validateNoOverlap(startDate, endDate, null, activeBusinessId);
  return await prisma.financialYear.create({
    data: {
      code,
      startDate,
      endDate,
      status: 'OPEN',
      isCurrent: false,
      businessId: activeBusinessId,
    },
  });
}

/**
 * Ensure a FinancialYear exists for the given date, creating it if missing.
 * @param {Date|string|number} date - Date for which to ensure FY.
 * @param {number} [businessId]
 * @returns {Promise<Object>} The FinancialYear record.
/**
 * Ensure a FinancialYear record exists for the given date.
 * If one does not exist, compute the range and insert it with status OPEN.
 * Returns the FinancialYear record (existing or newly created).
 */
async function ensureFinancialYear(date, businessId = null, tx = null) {
  let activeBusinessId = (businessId !== null && businessId !== undefined) ? parseInt(businessId, 10) : null;
  if (!activeBusinessId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
    activeBusinessId = 1;
  }
  const { code, startDate, endDate } = computeFinancialYear(date);
  const client = tx || prisma;
  const where = { code };
  if (activeBusinessId) {
    where.businessId = activeBusinessId;
  }
  const existing = await client.financialYear.findFirst({ where });
  if (existing) {
    return existing;
  }
  try { await validateNoOverlap(startDate, endDate, null, activeBusinessId, client); }
  catch(error) {
    const raced=await client.financialYear.findFirst({where});
    if(raced)return raced;
    throw error;
  }
  let fy;
  try { fy = await client.financialYear.create({
    data: {
      code,
      startDate,
      endDate,
      status: 'OPEN',
      isCurrent: false,
      businessId: activeBusinessId,
    },
  }); } catch (error) {
    if (error.code !== 'P2002') throw error;
    fy = await client.financialYear.findFirst({ where });
    if (!fy) throw error;
  }
  return fy;
}

// Roll the current marker forward without closing or rewriting historical periods.
async function ensureCurrentFinancialYear(businessId, date = new Date()) {
  if (!Number.isInteger(Number(businessId)) || Number(businessId) <= 0) throw new Error('Business is required.');
  const fy = await ensureFinancialYear(date, Number(businessId));
  await prisma.$transaction(async tx => {
    await tx.financialYear.updateMany({ where: { businessId:Number(businessId), isCurrent:true, id:{not:fy.id} }, data:{isCurrent:false} });
    if (!fy.isCurrent) await tx.financialYear.update({where:{id:fy.id},data:{isCurrent:true}});
  });
  return {...fy,isCurrent:true};
}

/**
 * Validate that a new financial year does not overlap any existing period.
 * Throws if an overlap is detected.
 */
async function validateNoOverlap(startDate, endDate, excludeId = null, businessId = null, client = null) {
  const dbClient = client || prisma;
  let activeBusinessId = (businessId !== null && businessId !== undefined) ? parseInt(businessId, 10) : null;
  if (!activeBusinessId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
    activeBusinessId = 1;
  }
  const overlapping = await dbClient.financialYear.findFirst({
    where: {
      ...(activeBusinessId ? { businessId: activeBusinessId } : {}),
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
async function listFinancialYears(businessId = null) {
  return await prisma.financialYear.findMany({
    where: businessId ? {businessId:Number(businessId)} : {},
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
  ensureCurrentFinancialYear,
  setCurrentFinancialYear,
  listFinancialYears,
};
