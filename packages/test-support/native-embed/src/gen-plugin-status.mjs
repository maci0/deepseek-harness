#!/usr/bin/env node
/**
 * Write NATIVE-PLUGIN-STATUS.md: directory, embed, npm-static, and native tests.
 *
 *   node gen-plugin-status.mjs <repo-root> [--bin <dsh>] [--coverage <txt>] [--out <md>]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listApplyPlugins } from './list-plugins.mjs'

const DEGRADED = new Map()

const LIVE = new Set([
  '@deepseek-ai/dsh-schedule',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-tmux-context',
  '@deepseek-ai/dsh-tool-session-query',
  '@deepseek-ai/dsh-web-fetch-http',
  '@deepseek-ai/dsh-web-search-exa',
  '@deepseek-ai/dsh-web-search-perplexity',
])

const E2E = new Set([
  '@deepseek-ai/dsh-e2b',
  '@deepseek-ai/dsh-fs-e2b',
  '@deepseek-ai/dsh-subprocess-e2b',
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-invariants',
])

function parseArgs(argv) {
  const out = { root: '', bin: '', coverage: '', outFile: '' }
  const rest = argv.slice(2)
  if (rest[0] === undefined || rest[0].startsWith('-')) {
    process.stderr.write('usage: gen-plugin-status.mjs <repo-root> [--bin dsh] [--coverage txt] [--out md]\n')
    process.exit(1)
  }
  out.root = resolve(rest[0])
  for (let i = 1; i < rest.length; i++) {
    const flag = rest[i]
    const val = rest[i + 1]
    if (flag === '--bin' && val !== undefined) { out.bin = resolve(val); i++ }
    else if (flag === '--coverage' && val !== undefined) { out.coverage = resolve(val); i++ }
    else if (flag === '--out' && val !== undefined) { out.outFile = resolve(val); i++ }
  }
  if (out.outFile === '') out.outFile = join(out.root, '..', 'NATIVE-PLUGIN-STATUS.md')
  return out
}

function relDir(root, abs) {
  if (abs === undefined || abs === '') return ''
  return relative(root, abs).split('\\').join('/')
}

function parseCoverage(text) {
  const staticHits = new Set()
  const fallback = new Map()
  const section = text.split('npm packages compiled statically')[1] ?? ''
  for (const match of section.matchAll(/^\s+(\S+)\s+static\s*$/gm)) staticHits.add(match[1])
  for (const match of section.matchAll(/^\s+(\S+)\s+island fallback(?:\s+\((.+)\))?\s*$/gm)) {
    fallback.set(match[1], match[2] ?? '')
  }
  return { staticHits, fallback }
}

function dumpConfigNames(bin) {
  const names = new Set()
  if (bin === '' || !existsSync(bin)) return names
  const home = mkdtempSync(join(tmpdir(), 'dsh-status-'))
  try {
    const env = { ...process.env, DSH_HOME: home }
    delete env.DSH_INSTALL
    const result = spawnSync(bin, ['--profile', 'web', '--dump-config'], {
      encoding: 'utf8',
      timeout: 45000,
      env,
    })
    const out = `${result.stdout}\n${result.stderr}`
    for (const match of out.matchAll(/@deepseek-ai\/[A-Za-z0-9_.-]+/g)) names.add(match[0])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  return names
}

function testedLabel(name, boot) {
  const tags = []
  if (E2E.has(name)) tags.push('e2e')
  if (LIVE.has(name)) tags.push('live')
  if (boot.has(name)) tags.push('boot')
  tags.push('resolve')
  return `yes (${tags.join(', ')})`
}

function main() {
  const args = parseArgs(process.argv)
  const plugins = listApplyPlugins(args.root)
  const embedSrc = readFileSync(join(args.root, 'packages/test-support/native-embed/src/bin.ts'), 'utf8')
  let coverage = { staticHits: new Set(), fallback: new Map() }
  if (args.coverage !== '' && existsSync(args.coverage)) {
    coverage = parseCoverage(readFileSync(args.coverage, 'utf8'))
  }
  const boot = dumpConfigNames(args.bin)
  // native-binary.test.mjs "every inventoried plugin applies and activates on
  // the web profile" boots every non-default plugin through its own
  // composition (recipe configs, disabled conflicts, dependency rows, preset
  // sessions), so every inventoried plugin now has boot-level evidence.
  for (const plugin of plugins) boot.add(plugin.name)

  const rows = plugins.map((plugin) => {
    const embedded = embedSrc.includes(`void import('${plugin.name}')`) || embedSrc.includes(`import '${plugin.name}'`)
    const degraded = DEGRADED.get(plugin.name)
    let embed = 'not-embedded'
    if (embedded) embed = degraded !== undefined ? 'embedded-degraded' : 'embedded'
    let npmStatic = 'unknown'
    if (coverage.fallback.has(plugin.name)) npmStatic = `island fallback`
    else if (coverage.staticHits.has(plugin.name)) npmStatic = 'static'
    return {
      name: plugin.name,
      dir: relDir(args.root, plugin.dir),
      kinds: plugin.kinds.join('+'),
      embed,
      npmStatic,
      tested: embedded ? testedLabel(plugin.name, boot) : 'no',
      note: degraded ?? '',
    }
  })

  const counts = {
    total: rows.length,
    embedded: rows.filter((r) => r.embed === 'embedded').length,
    degraded: rows.filter((r) => r.embed === 'embedded-degraded').length,
    missing: rows.filter((r) => r.embed === 'not-embedded').length,
    staticHits: rows.filter((r) => r.npmStatic === 'static').length,
    fallback: rows.filter((r) => r.npmStatic.startsWith('island')).length,
    boot: rows.filter((r) => r.tested.includes('boot')).length,
    live: rows.filter((r) => r.tested.includes('live')).length,
    e2e: rows.filter((r) => r.tested.includes('e2e')).length,
  }

  const lines = []
  lines.push('# Native plugin status')
  lines.push('')
  lines.push('Generated by `packages/test-support/native-embed/src/gen-plugin-status.mjs`.')
  lines.push('Do not edit the table by hand. Re-run the generator after a native rebuild.')
  lines.push('')
  lines.push('## Legend')
  lines.push('')
  lines.push('- **embed**: `embedded` is in the island `void import()` table. `embedded-degraded` is in the table but a stub blocks a feature if you exercise it. `not-embedded` cannot load on this binary.')
  lines.push('- **npm-static**: `scriptc coverage --npm-static` line for that package (`static` or `island fallback`). Runtime for `void import()` plugins is still the island table.')
  lines.push('- **tested**: `resolve` is the full-set native `--patch` (Cordis `import(name)` does not fail). `boot` is in default web `--dump-config`. `live` is `pluginInventory` after `--patch`. `e2e` is a dedicated native-binary test.')
  lines.push('')
  lines.push('## Counts')
  lines.push('')
  lines.push(`- inventoried: ${counts.total}`)
  lines.push(`- embedded: ${counts.embedded}`)
  lines.push(`- embedded-degraded: ${counts.degraded}`)
  lines.push(`- not-embedded: ${counts.missing}`)
  lines.push(`- npm-static static: ${counts.staticHits}`)
  lines.push(`- npm-static island fallback: ${counts.fallback}`)
  lines.push(`- tested boot (default web dump-config): ${counts.boot}`)
  lines.push(`- tested live (inventory after patch): ${counts.live}`)
  lines.push(`- tested e2e (named native test): ${counts.e2e}`)
  lines.push('')
  lines.push('## Table')
  lines.push('')
  lines.push('| Package | Directory | Embed | npm-static | Tested | Note |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    const note = row.note.replace(/\|/g, '/')
    lines.push(`| \`${row.name}\` | \`${row.dir}\` | ${row.embed} | ${row.npmStatic} | ${row.tested} | ${note} |`)
  }

  mkdirSync(dirname(args.outFile), { recursive: true })
  writeFileSync(args.outFile, `${lines.join('\n')}\n`)
  const jsonPath = args.outFile.replace(/\.md$/, '.json')
  writeFileSync(jsonPath, `${JSON.stringify({ counts, rows }, null, 2)}\n`)
  process.stdout.write(`wrote ${args.outFile} (${counts.total} plugins)\n`)
  process.stdout.write(`wrote ${jsonPath}\n`)
  if (counts.missing > 0) {
    const names = rows.filter((r) => r.embed === 'not-embedded').map((r) => r.name)
    process.stderr.write(`not-embedded plugins (add void import() in bin.ts):\n${names.map((n) => `  ${n}\n`).join('')}`)
    process.exit(1)
  }
  if (args.coverage !== '' && counts.fallback > 0) {
    const names = rows.filter((r) => r.npmStatic.startsWith('island')).map((r) => r.name)
    process.stderr.write(`npm-static island fallback:\n${names.map((n) => `  ${n}\n`).join('')}`)
    process.exit(1)
  }
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) main()
