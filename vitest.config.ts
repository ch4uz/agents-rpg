import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/web/**', 'jsdom'],
    ],
  },
});
