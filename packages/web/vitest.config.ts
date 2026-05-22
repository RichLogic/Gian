import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    // Per-test isolation matters because we mutate global WS/fetch mocks.
    pool: 'forks',
    // Keep output terse — agent reads from stdout.
    reporters: ['default'],
  },
});
