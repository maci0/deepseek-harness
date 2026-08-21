/**
 * Real `scriptc coverage` of the native compile entry with `--npm-static`
 * for every inventoried plugin. Asserts each name is `static`, never
 * `island fallback`. Runs twice.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { listApplyPluginNames } from '../src/list-plugins.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const workspaceRoot = resolve(repoRoot, '..')
const scriptc = join(workspaceRoot, 'tools/node_modules/.bin/scriptc')
const patchSdk = join(workspaceRoot, 'tools/patch-mcp-sdk-exports.mjs')
const entry = join(here, '../src/bin.ts')
const scratch = process.env.SCRATCH ?? '/tmp/grok-goal-a4c7cd5a2606/implementer'
const coverageTimeoutMs = 300_000

function runCoverage(names) {
  const args = ['coverage', entry, '--dynamic']
  for (const name of names) args.push('--npm-static', name)
  const env = { ...process.env }
  if (env.HOME) env.PATH = `${env.HOME}/.local/bin:${env.PATH ?? ''}`
  const result = spawnSync(scriptc, args, {
    encoding: 'utf8',
    env,
    timeout: coverageTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  const out = `${result.stdout}\n${result.stderr}`
  return { status: result.status, signal: result.signal, error: result.error, out }
}

function parseNpmStatic(out) {
  const marker = 'npm packages compiled statically'
  const idx = out.indexOf(marker)
  const section = idx === -1 ? '' : out.slice(idx)
  const staticHits = [...section.matchAll(/^\s+(\S+)\s+static\s*$/gm)].map((match) => match[1])
  const fallbackHits = [...section.matchAll(/^\s+(\S+)\s+island fallback(?:\s+\((.+)\))?\s*$/gm)]
    .map((match) => [match[1], match[2] ?? ''])
  return { staticHits, fallbackHits, hasSection: idx !== -1 }
}

function assertAllStatic(names, parsed, out) {
  assert.ok(parsed.hasSection, `missing "npm packages compiled statically" section\n${out.slice(-4000)}`)
  const staticSet = new Set(parsed.staticHits)
  const fallback = parsed.fallbackHits.filter(([name]) => names.includes(name))
  assert.equal(
    fallback.length,
    0,
    `inventoried plugins reported island fallback:\n${fallback.map(([n, r]) => `  ${n} (${r})`).join('\n')}`,
  )
  const missing = names.filter((name) => !staticSet.has(name))
  assert.deepEqual(missing, [], `inventoried plugins missing a static line: ${missing.join(', ')}`)
}

test('scriptc --npm-static every inventoried plugin is static (two passes)', { timeout: 600_000 }, () => {
  mkdirSync(scratch, { recursive: true })
  const patched = spawnSync(process.execPath, [patchSdk], { encoding: 'utf8' })
  assert.equal(patched.status, 0, patched.stderr || patched.stdout)
  const names = listApplyPluginNames(repoRoot)
  assert.ok(names.length > 0, 'plugin scanner returned no names')
  const first = runCoverage(names)
  writeFileSync(join(scratch, 'npm-static-plugins.txt'), first.out)
  assert.equal(first.error, undefined, first.error ? String(first.error) : '')
  assert.equal(first.signal, null, `scriptc signal ${first.signal}`)
  assert.equal(first.status, 0, `scriptc status ${first.status}\n${first.out.slice(-4000)}`)
  const parsedFirst = parseNpmStatic(first.out)
  assertAllStatic(names, parsedFirst, first.out)

  const second = runCoverage(names)
  writeFileSync(join(scratch, 'npm-static-plugins-2.txt'), second.out)
  assert.equal(second.error, undefined, second.error ? String(second.error) : '')
  assert.equal(second.signal, null, `scriptc signal ${second.signal}`)
  assert.equal(second.status, 0, `scriptc status ${second.status}\n${second.out.slice(-4000)}`)
  const parsedSecond = parseNpmStatic(second.out)
  assertAllStatic(names, parsedSecond, second.out)
  assert.deepEqual(parsedSecond.staticHits, parsedFirst.staticHits)
})
