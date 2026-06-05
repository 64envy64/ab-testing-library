import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

// The example imports the SDK by its package name; alias it to source so the example
// tests resolve it the same way the Vite dev server does. (SDK's own tests use
// relative imports and are unaffected.)
const sdkRoot = resolve(import.meta.dirname, 'src')

export default defineConfig({
  resolve: {
    alias: {
      'ab-testing-library/react': resolve(sdkRoot, 'react/index.ts'),
      'ab-testing-library/testing': resolve(sdkRoot, 'testing/index.ts'),
      'ab-testing-library': resolve(sdkRoot, 'index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary'],
      // Floors the suite already clears (measured ~89/84/89/91); a regression trips CI.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 88,
      },
    },
  },
})
