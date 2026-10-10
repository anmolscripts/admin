import { config as dotenvConfig } from 'dotenv';
if (process.env.NODE_ENV === 'test') {
  dotenvConfig({ path: '.env.test', override: !process.env.DATABASE_URL });
} else {
  dotenvConfig({ path: '.env', override: !process.env.DATABASE_URL });
}
import { defineConfig, env } from "prisma/config";

export default defineConfig({
    schema: "prisma/schema.prisma",

    migrations: {
        path: "prisma/migrations",
        seed: "node prisma/seed.js",
    },

    datasource: {
        url: env("DATABASE_URL"),
        ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: env("SHADOW_DATABASE_URL") } : {}),
    },
});