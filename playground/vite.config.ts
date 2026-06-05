import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Run from the repo root via `npm run dev` (`vite --config playground/vite.config.ts`).
// The package name resolves to source so the playground imports the SDK exactly as a
// consumer would, with no build step. Longer subpaths must come first.
const sdkRoot = resolve(import.meta.dirname, '..', 'src')

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      'ab-testing-library/react': resolve(sdkRoot, 'react/index.ts'),
      'ab-testing-library/testing': resolve(sdkRoot, 'testing/index.ts'),
      'ab-testing-library': resolve(sdkRoot, 'index.ts'),
    },
  },
  server: {
    port: 5173,
    open: false,
  },
})
