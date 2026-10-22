import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    include: [
      'test/entitlement-native.native.ts',
      'test/entitlement-backfill.e2e-spec.ts',
    ],
    testTimeout: 30000,
  },
});
