import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { defineConfig } from 'tsup'

// esbuild strips module-level "use client" directives when bundling (it warns
// and drops them). Re-add the directive to the built React adapter outputs so
// the published package ships a real client-component boundary for React Server
// Components / the Next.js App Router. The core and testing entries are
// intentionally left without it (the core must stay server-safe).
const REACT_OUTPUTS = ['dist/react/index.js', 'dist/react/index.cjs']
const CLIENT_DIRECTIVE = '"use client";\n'

async function ensureClientDirective(): Promise<void> {
  await Promise.all(
    REACT_OUTPUTS.map(async (relativePath) => {
      const file = resolve(relativePath)
      const code = await readFile(file, 'utf8')
      if (!/^\s*["']use client["']/.test(code)) {
        await writeFile(file, CLIENT_DIRECTIVE + code)
      }
    }),
  )
}

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  target: 'es2022',
  // Keep React peer-only; never embed it in the bundle.
  external: ['react', 'react-dom'],
  clean: true,
  onSuccess: ensureClientDirective,
})
