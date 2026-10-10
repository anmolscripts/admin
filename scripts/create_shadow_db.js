require('dotenv').config({ path: '.env.test', override: true });
const mariadb = require('mariadb');
(async () => {
  const url = process.env.SHADOW_DATABASE_URL;
  if (!url) {
    console.error('❌ Missing SHADOW_DATABASE_URL');
    process.exit(1);
  }
  const match = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/);
  if (!match) {
    console.error('❌ Invalid SHADOW_DATABASE_URL format');
    process.exit(1);
  }
  const [, user, password, host, port, dbName] = match;
  const pool = mariadb.createPool({
    host,
    port: Number(port),
    user,
    password: decodeURIComponent(password),
    database: 'information_schema',
    connectionLimit: 5,
    connectTimeout: 5000,
  });
  try {
    const conn = await pool.getConnection();
    await conn.query(`CREATE DATABASE \`${dbName}\``);
    console.log('✅ Shadow database created:', dbName);
    await conn.end();
  } catch (err) {
    if (err.errno === 1007) {
      console.log('ℹ️ Shadow database already exists');
    } else {
      console.error('❌ Error creating shadow DB:', err.message);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
})();
