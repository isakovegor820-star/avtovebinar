import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,jsx,ts,tsx}'],
    exclude: ['**/node_modules/**', '**/node_modules 2/**', '**/dist/**', '**/tests/e2e/**'],
  },
});
