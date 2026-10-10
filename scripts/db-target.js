'use strict';

/**
 * Resolve the effective database connection target using the same logic as Prisma config.
 * Returns an object { host, port, database }.
 */
function resolveDbTarget() {
  const env = process.env;
  // Prefer granular variables, fallback to DATABASE_URL parsing.
  if (env.DATABASE_URL) {
    try {
      const parsed = new URL(env.DATABASE_URL);
      return {
        host: parsed.hostname || 'localhost',
        port: parsed.port || '3306',
        database: parsed.pathname.replace(/^\//, '') || env.DATABASE_NAME || 'admin'
      };
    } catch (_) {
      // malformed URL – fall back to granular vars.
    }
  }
  return {
    host: env.DATABASE_HOST || 'localhost',
    port: env.DATABASE_PORT || '3306',
    database: env.DATABASE_NAME || 'admin'
  };
}

module.exports = { resolveDbTarget };
