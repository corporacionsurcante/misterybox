import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 movió la connection string fuera del schema.
 * Acá vive la URL para migrate/introspect; el cliente en runtime la recibe
 * a través del adapter (ver src/lib/prisma.ts).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
