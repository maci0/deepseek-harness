import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseNpmStatic } from '../src/coverage.mjs'

test('coverage admission reads the current table and stops at its boundary', () => {
  assert.deepEqual(parseNpmStatic(`npm package compilation:
    @deepseek-ai/dsh-one     static
    @deepseek-ai/dsh-two     refused (computed require)

  blockers:
    unrelated static
`), {
    staticHits: ['@deepseek-ai/dsh-one'],
    refusedHits: [['@deepseek-ai/dsh-two', 'computed require']],
    hasSection: true,
  })
  assert.deepEqual(parseNpmStatic('npm packages compiled statically\n old static\n'), {
    staticHits: [], refusedHits: [], hasSection: false,
  })
})

test('inventory alone never claims native boot, live or e2e verification', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-report-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const entry = join(root, 'packages/test-support/native-embed/src')
  const plugin = join(root, 'packages/testing/schedule')
  mkdirSync(entry, { recursive: true })
  mkdirSync(join(plugin, 'src'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-schedule' }))
  writeFileSync(join(plugin, 'src/index.ts'), 'export function apply() {}\n')
  writeFileSync(join(entry, 'bin.ts'), "void import('@deepseek-ai/dsh-schedule')\n")
  const coverage = join(root, 'coverage.txt')
  const output = join(root, 'status.md')
  writeFileSync(coverage, 'npm package compilation:\n @deepseek-ai/dsh-schedule static\n\n')
  const generator = new URL('../src/gen-plugin-status.mjs', import.meta.url).pathname
  const invoke = (...args) => spawnSync(process.execPath, [generator, root, '--coverage', coverage, '--out', output, ...args], { encoding: 'utf8' })
  const generated = invoke()
  assert.equal(generated.status, 0, generated.stderr)
  const report = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))
  assert.equal(report.rows[0].tested, 'not verified')
  assert.equal(report.rows[0].npmStatic, 'static')
  assert.equal(report.counts.boot + report.counts.live + report.counts.e2e, 0)
  writeFileSync(coverage, 'npm package compilation:\n @deepseek-ai/dsh-schedule refused (not supported)\n\n')
  const refused = invoke()
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /refused/)
  const missing = invoke('--bin', join(root, 'missing-binary'), '--out', join(root, 'invalid.md'))
  assert.equal(missing.status, 1)
  assert.equal(existsSync(join(root, 'invalid.md')), false)
})
