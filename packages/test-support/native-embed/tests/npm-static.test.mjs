/**
 * Real `scriptc coverage` of the native compile entry with `--npm-static`
 * for every inventoried plugin. Reject refusals and runtime fences. Runs twice.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { listApplyPluginNames } from '../src/list-plugins.mjs'
import { parseNpmStatic } from '../src/coverage.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const workspaceRoot = resolve(repoRoot, '..')
const scriptc = join(workspaceRoot, 'tools/scriptc-node.mjs')
const entry = join(here, '../src/bin.ts')
const scratch = process.env.SCRATCH ?? join(workspaceRoot, '.scratch')
const coverageTimeoutMs = 300_000

function runCoverage(names) {
  const args = ['coverage', entry, '--fail-on', 'divergences']
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

function assertAllStatic(names, parsed, out) {
  assert.ok(parsed.hasSection, `missing "npm package compilation" section\n${out.slice(-4000)}`)
  const staticSet = new Set(parsed.staticHits)
  const refused = parsed.refusedHits.filter(([name]) => names.includes(name))
  assert.equal(
    refused.length,
    0,
    `inventoried plugins refused:\n${refused.map(([n, r]) => `  ${n} (${r})`).join('\n')}`,
  )
  assert.doesNotMatch(out, /deferred to runtime\s+[1-9]\d* sites/u, 'runtime fences cannot certify working native plugins')
  const missing = names.filter((name) => !staticSet.has(name))
  assert.deepEqual(missing, [], `inventoried plugins missing a static line: ${missing.join(', ')}`)
}

test('scriptc --npm-static every inventoried plugin is static (two passes)', { timeout: 600_000 }, () => {
  mkdirSync(scratch, { recursive: true })
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
