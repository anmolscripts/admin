if (process.env.NODE_ENV === 'test') {
  require('dotenv').config({ path: '.env.test', override: !process.env.DATABASE_NAME });
}
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { resolveDbTarget } = require('./db-target');

/**
 * Validate the test environment before any Prisma client is instantiated.
 * Throws an Error on validation failure; callers should exit with a non‑zero code.
 */
function validateTestEnv(prismaClient) {
  // 1. Ensure .env.test exists
  const envTestPath = path.resolve(process.cwd(), '.env.test');
  if (!fs.existsSync(envTestPath)) {
    throw new Error('Test configuration missing: .env.test file not found.');
  }

  // 2. Required env vars
  const { DATABASE_NAME, DATABASE_URL } = process.env;
  if (!DATABASE_NAME) {
    throw new Error('DATABASE_NAME is not set in environment.');
  }

  // 3. Reject production database
  if (DATABASE_NAME.toLowerCase() === 'admin') {
    throw new Error('Use of production database "admin" is prohibited in test mode.');
  }

  // 4. Resolve effective target using the same logic as Prisma config
  const { database: resolvedDb } = resolveDbTarget();

  // 5. Ensure resolved database matches the explicit DATABASE_NAME
  if (resolvedDb !== DATABASE_NAME) {
    throw new Error(`Resolved database "${resolvedDb}" does not match DATABASE_NAME "${DATABASE_NAME}".`);
  }

  // 6. If DATABASE_URL is present, its pathname must match DATABASE_NAME
  if (DATABASE_URL) {
    try {
      const parsed = new URL(DATABASE_URL);
      const urlDb = parsed.pathname.replace(/^\//, '');
      if (urlDb && urlDb !== DATABASE_NAME) {
        throw new Error(`DATABASE_URL points to "${urlDb}", which conflicts with DATABASE_NAME "${DATABASE_NAME}".`);
      }
    } catch (e) {
      throw new Error('Invalid DATABASE_URL format.');
    }
  }

  // 7. Live connection validation – query the current DB name if a client is supplied
  if (prismaClient) {
    return (async () => {
      try {
        const result = await prismaClient.$queryRaw`SELECT DATABASE() AS db`;
        const currentDb = Array.isArray(result)
          ? result[0]?.db ?? result[0]?.DATABASE ?? result[0]?.database
          : result?.db ?? result?.DATABASE ?? result?.database;
        if (currentDb !== DATABASE_NAME) {
          throw new Error(`Live connection reports database "${currentDb}", expected "${DATABASE_NAME}".`);
        }
      } catch (err) {
        throw new Error(`Failed to validate live database connection: ${err.message}`);
      }
    })();
  }
}

module.exports = { validateTestEnv };
