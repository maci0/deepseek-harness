import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

describe('Loader internal shape detection', () => {
  it('imports relative plugins from their configured parent without Node internals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-import-'))
    try {
      writeFileSync(join(dir, 'plugin.mjs'), 'export const marker = 42')
      const loaded: unknown = await ModuleLoader.importFrom(undefined, './plugin.mjs', pathToFileURL(dir).href + '/', {})
      expect(loaded).toMatchObject({ marker: 42 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tags the running Node loader with the resolver signature that runtime accepts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-shape-'))
    const baseUrl = pathToFileURL(dir).href + '/'
    const ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader)
    try {
      const internal = ctx.loader.internal
      expect(internal, 'Node module internals are unreachable; HMR reload and client-module resolution both need them').toBeDefined()
      // Resolving through the tag is exactly what Hmr._resolve() and the
      // client-modules registry do. A tag taken from the Node major instead of
      // the loader's own API rejects every call on 24.0-24.11.1, which report
      // major 24 while carrying the v1 loader: v2 arrived only in 24.12.0.
      const resolved = internal!.version === 'v2'
        ? internal!.resolveSync(baseUrl, { specifier: 'node:path', attributes: {} })
        : internal!.resolveSync('node:path', baseUrl, {})
      expect(resolved.url).toBe('node:path')
      const imported: unknown = await ModuleLoader.importFrom(internal, 'node:path', baseUrl, {})
      expect(imported).toMatchObject({ join })
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
