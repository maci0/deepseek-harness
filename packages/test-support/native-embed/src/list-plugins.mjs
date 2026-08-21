/**
 * Inventoried Cordis plugins: export function apply, YAML name: rows, and
 * default-export concrete Service classes. Shared by native-binary tests and
 * the product --npm-static compile list.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const YAML_BUNDLE_PACKAGES = new Set(['@deepseek-ai/dsh-base'])
const YAML_NAME_RE = /name:\s*['"](@deepseek-ai\/[^'"]+)['"]/g
const APPLY_RE = /export\s+(async\s+)?function\s+apply\b/
const ABSTRACT_SERVICE_RE = /export\s+abstract\s+class\s+(\w+)\s+extends\s+Service\b/g
const CONCRETE_SERVICE_RE = /export\s+class\s+(\w+)\s+extends\s+Service\b/g
const DEFAULT_EXPORT_RE = /export\s+default\s+(\w+)\b/g

function isDefaultServicePlugin(text) {
  const abstract = new Set([...text.matchAll(ABSTRACT_SERVICE_RE)].map((match) => match[1]))
  const concrete = new Set([...text.matchAll(CONCRETE_SERVICE_RE)].map((match) => match[1]))
  for (const match of text.matchAll(DEFAULT_EXPORT_RE)) {
    const ident = match[1]
    if (concrete.has(ident) && !abstract.has(ident)) return true
  }
  return false
}

function pkgNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function walkDirs(start, skip, visitFile) {
  const stack = [...start]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else visitFile(path, entry.name)
    }
  }
}

function addPlugin(byName, name, dir, kind) {
  let row = byName.get(name)
  if (row === undefined) {
    row = { name, dir, kinds: [] }
    byName.set(name, row)
  }
  if (typeof dir === 'string' && dir !== '' && (row.dir === '' || dir.length < row.dir.length)) {
    row.dir = dir
  }
  if (kind !== undefined && !row.kinds.includes(kind)) row.kinds.push(kind)
}

/**
 * @param {string} root - deepseek-harness repository root
 * @returns {{ name: string, dir: string, kinds: string[] }[]}
 */
export function listApplyPlugins(root) {
  const byName = new Map()
  const pkgDirByName = new Map()
  walkDirs(
    [join(root, 'packages'), join(root, 'vendor'), join(root, 'apps')],
    new Set(['node_modules', 'lib']),
    (path, name) => {
      if (name !== 'package.json') return
      if (path.includes('/tests/fixtures/')) return
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@deepseek-ai/')) return
      const dir = dirname(path)
      pkgDirByName.set(pkg.name, dir)
      const srcRoot = join(dir, 'src')
      walkDirs([srcRoot], new Set(['node_modules']), (srcPath, srcName) => {
        if (!srcName.endsWith('.ts') && !srcName.endsWith('.tsx')) return
        if (srcName === 'invariant.ts') return
        const text = readFileSync(srcPath, 'utf8')
        if (APPLY_RE.test(text)) addPlugin(byName, pkg.name, dir, 'apply')
        if (srcName === 'index.ts' && isDefaultServicePlugin(text)) addPlugin(byName, pkg.name, dir, 'service')
      })
    },
  )
  walkDirs(
    [join(root, 'packages'), join(root, 'vendor'), join(root, 'apps'), join(root, 'examples')],
    new Set(['node_modules', 'lib']),
    (path, name) => {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) return
      const text = readFileSync(path, 'utf8')
      YAML_NAME_RE.lastIndex = 0
      let match
      while ((match = YAML_NAME_RE.exec(text)) !== null) {
        const pkg = pkgNameOf(match[1])
        if (YAML_BUNDLE_PACKAGES.has(pkg)) continue
        addPlugin(byName, pkg, pkgDirByName.get(pkg) ?? dirname(path), 'yaml')
      }
    },
  )
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {string} root - deepseek-harness repository root
 * @returns {string[]} sorted package names
 */
export function listApplyPluginNames(root) {
  return listApplyPlugins(root).map((row) => row.name)
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  const root = process.argv[2]
  if (root === undefined || root === '') {
    process.stderr.write('usage: list-plugins.mjs <repo-root>\n')
    process.exit(1)
  }
  process.stdout.write(`${listApplyPluginNames(root).join('\n')}\n`)
}
