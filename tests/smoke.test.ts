import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('package entrypoints', () => {
  it('core entry is importable and exposes createAbClient + SDK_VERSION', async () => {
    const core = await import('../src/index')
    expect(typeof core.createAbClient).toBe('function')
    expect(core.SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('react entry is importable and exposes the provider and hooks', async () => {
    const react = await import('../src/react/index')
    expect(typeof react.AbTestingProvider).toBe('function')
    expect(typeof react.useExperiment).toBe('function')
    expect(typeof react.useFeatureFlag).toBe('function')
  })

  it('testing entry is importable', async () => {
    const testing = await import('../src/testing/index')
    expect(testing).toBeTypeOf('object')
  })
})

describe('package boundaries', () => {
  it('core entry does not import React', () => {
    const source = readFileSync(resolve(projectRoot, 'src/index.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]react['"]/)
  })

  it('react entry declares the "use client" directive on the first line', () => {
    const source = readFileSync(resolve(projectRoot, 'src/react/index.ts'), 'utf8')
    const firstLine = source.split(/\r?\n/)[0]?.trim()
    expect(firstLine).toBe("'use client'")
  })
})
