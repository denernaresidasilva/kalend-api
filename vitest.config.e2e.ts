import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Each persisted suite owns a WASM PostgreSQL instance; avoid resource contention.
    fileParallelism: false,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
