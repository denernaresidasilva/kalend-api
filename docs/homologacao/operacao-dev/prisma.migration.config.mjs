// Fixed approved artifact and DEV peer identity. No dotenv or inherited URL.
import { defineConfig } from '/srv/kalend-dev-migration/db182667ca565bdb18370dc1c209d129e6e139a0/node_modules/prisma/config.js';
export default defineConfig({
  schema: '/srv/kalend-dev-migration/db182667ca565bdb18370dc1c209d129e6e139a0/prisma/schema.prisma',
  migrations: { path: '/srv/kalend-dev-migration/db182667ca565bdb18370dc1c209d129e6e139a0/prisma/migrations' },
  datasource: {
    url: 'postgresql://kalend_dev_migrator@localhost:5432/kalend_dev?host=%2Fvar%2Frun%2Fpostgresql&options=-c%20lock_timeout%3D3000%20-c%20statement_timeout%3D30000',
  },
});
