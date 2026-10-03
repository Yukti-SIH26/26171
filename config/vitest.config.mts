import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // This file lives in config/, but every glob below is relative to the repo root.
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.output/**', '**/.wxt/**'],
    environment: 'node',
    reporters: ['default'],
    // happy-dom costs ~7s of startup per isolated worker. Our tests do not
    // mutate shared module state, so reusing workers is safe and much faster.
    isolate: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
});
