import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace api package from source so test mocks can spread
      // the real module (importOriginal) without requiring a prior build.
      'easynews-plus-plus-api': path.resolve(__dirname, '../api/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types.ts',
        'src/i18n/index.ts',
        'src/meta.ts',
        'src/index.ts',
        'src/manifest.ts',
      ],
    },
    globals: true,
  },
});
