const prisma = require('../app/config/prisma');

async function check() {
  const [dbRes] = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS usr');
  console.log('Effective Prisma connected database:', dbRes.db);
  console.log('Effective Prisma connected user:', dbRes.usr);

  const migrations = await prisma.$queryRawUnsafe('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at ASC');
  console.log('Total migrations applied in effective database:', migrations.length);
  const pending = migrations.filter(m => !m.finished_at);
  console.log('Pending or failed migrations in effective database:', pending.length);

  // Check admin database state without modifying
  const adminTables = await prisma.$queryRawUnsafe('SELECT table_name FROM information_schema.tables WHERE table_schema = "admin"');
  const adminMigrations = await prisma.$queryRawUnsafe('SELECT migration_name FROM admin._prisma_migrations');
  console.log('Admin database table count (untouched):', adminTables.length);
  console.log('Admin database migration count (untouched):', adminMigrations.length);
  
  await prisma.$disconnect();
}

check().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
