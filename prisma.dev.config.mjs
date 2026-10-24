import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { devMigrationUrl } from './scripts/ops/dev-migration-target.mjs';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: devMigrationUrl(process.env.DEV_MIGRATION_DATABASE_URL) },
});
