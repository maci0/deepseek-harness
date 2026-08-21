/**
 * Drives the scriptc-compiled native dsh binary (not node/tsx).
 * Binary path: DSH_NATIVE_BIN or <workspace>/dist/dsh (the staged install).
 * Native runs must not set DSH_INSTALL: dist/package.json next to the binary
 * is the install anchor.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const workspaceRoot = resolve(repoRoot, '..')
const defaultBin = join(workspaceRoot, 'dist/dsh')
const bin = process.env.DSH_NATIVE_BIN ?? defaultBin
const install = join(repoRoot, 'apps/cli/package.json')
const home = join(tmpdir(), 'dsh-native-embed-home')
mkdirSync(home, { recursive: true })

function nativeEnv(extra = {}) {
  const env = { ...process.env, DSH_HOME: home, ...extra }
  delete env.DSH_INSTALL
  return env
}

function run(args) {
  assert.ok(existsSync(bin), `native binary missing: ${bin}`)
  const result = spawnSync(bin, args, {
    env: nativeEnv(),
    encoding: 'utf8',
    timeout: 45000,
  })
  return result
}

test('native dsh --version', () => {
  const a = run(['-V'])
  const b = run(['-V'])
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /0\.\d+\.\d+/)
  assert.equal(a.stdout, b.stdout)
})

test('native dsh --profile web --help is the web app help', () => {
  const a = run(['--profile', 'web', '--help'])
  const b = run(['--profile', 'web', '--help'])
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /Serve the DeepSeek Harness browser UI/)
  assert.match(a.stdout, /--host/)
  assert.match(a.stdout, /--port/)
  assert.doesNotMatch(a.stdout, /plugin tree failed to load/)
  assert.doesNotMatch(a.stderr, /typert-loader/)
  assert.doesNotMatch(a.stderr, /unexpected token/)
  assert.equal(a.stdout, b.stdout)
})

test('native dsh --profile headless --help is the headless app help', () => {
  const a = run(['--profile', 'headless', '--help'])
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /Answer one task/)
  assert.doesNotMatch(a.stdout, /plugin tree failed to load/)
  assert.doesNotMatch(a.stderr, /typert-loader/)
  assert.doesNotMatch(a.stderr, /unexpected token/)
})

test('native dsh --profile web --dump-config is stable and matches Node', () => {
  const a = run(['--profile', 'web', '--dump-config'])
  const b = run(['--profile', 'web', '--dump-config'])
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /@deepseek-ai\/dsh-base/)
  assert.equal(a.stdout, b.stdout)
  const node = spawnSync(process.execPath, ['--import', 'tsx/esm', join(repoRoot, 'apps/cli/src/bin.ts'), '--profile', 'web', '--dump-config'], {
    cwd: repoRoot,
    env: { ...process.env, DSH_INSTALL: install },
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(node.status, 0, node.stderr)
  assert.equal(a.stdout, node.stdout)
})

/**
 * Spawn the staged native binary, wait for `dsh web: http://127.0.0.1:<port>`,
 * and reject if the process exits first. Callers fetch after listen.
 */
async function bootNativeWeb(env, extraArgs = ['--port', '0'], { openBrowser = false, patchFiles = [] } = {}) {
  assert.ok(existsSync(bin), `native binary missing: ${bin}`)
  const args = ['--profile', 'web']
  for (const patch of patchFiles) {
    args.push('--patch', patch)
  }
  if (!openBrowser) args.push('--no-open')
  const child = spawn(bin, args.concat(extraArgs), {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { state.stdout += chunk })
  child.stderr.on('data', (chunk) => { state.stderr += chunk })
  const url = await new Promise((resolveUrl, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`web boot timed out (listen)\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`))
    }, 20000)
    const onExit = (code, signal) => {
      clearTimeout(deadline)
      reject(new Error(`native dsh exited before listen (code=${code} signal=${signal})\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`))
    }
    child.once('exit', onExit)
    const look = () => {
      const match = state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        clearTimeout(deadline)
        child.off('exit', onExit)
        resolveUrl(match[1])
      }
    }
    child.stdout.on('data', look)
    look()
  })
  const dump = (surface = 'listen') => (
    `${surface}: url=${url} exit=${child.exitCode}\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`
  )
  const stop = async () => {
    child.stdout?.destroy()
    child.stderr?.destroy()
    if (child.exitCode !== null) return
    child.kill('SIGKILL')
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(2000),
    ])
  }
  return { child, url, state, dump, stop }
}

async function postApi(url, method, payload = {}, { body } = {}) {
  const res = await fetch(new URL(`/api/${method}`, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...body === undefined
      ? { body: JSON.stringify({ type: 'client-request', rpcId: `t-${method}`, method, payload }) }
      : body === null ? {} : { body },
    signal: AbortSignal.timeout(10000),
  })
  const text = await res.text()
  return { res, text }
}

function assertRpcOk(method, { res, text }, dump) {
  assert.equal(res.status, 200, `/api/${method}: HTTP ${res.status}\n${text}\n${dump(`/api/${method}`)}`)
  const parsed = JSON.parse(text)
  assert.equal(parsed.type, 'server-response', `/api/${method}: not a server-response\n${text}`)
  assert.equal(parsed.result.ok, true, `/api/${method}: result.ok is false\n${text}\n${dump(`/api/${method}`)}`)
  return parsed
}

async function bootWebAndFetch(env, extraArgs = ['--port', '0'], { openBrowser = false } = {}) {
  const session = await bootNativeWeb(env, extraArgs, { openBrowser })
  const { child, url, state, dump, stop } = session
  try {
    await delay(200)
    assert.equal(child.exitCode, null, `process died after URL\n${dump('listen')}`)
    assert.doesNotMatch(state.stderr, /plugin tree failed to load/, dump('listen'))
    assert.doesNotMatch(state.stderr, /configured for compression/, dump('listen'))
    assert.doesNotMatch(state.stderr, /EADDRINUSE/, dump('listen'))
    assert.doesNotMatch(state.stderr, /Uncaught/, dump('listen'))
    assert.doesNotMatch(state.stderr, /child_process\.spawn is not available/, dump('listen'))
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const body = await res.text()
    assert.equal(res.status, 200, `${dump('listen')}\nbody:\n${body.slice(0, 500)}`)
    assert.match(body, /<!doctype html>/i)
    assert.doesNotMatch(body, /Vite frontend is not in this tree/)
    assert.match(body, /id="root"/)
    const script = body.match(/src="(\/assets\/index-[^"]+\.js)"/)
    assert.ok(script, `missing Vite index script\n${dump('listen')}\nbody:\n${body.slice(0, 500)}`)
    const js = await fetch(new URL(script[1], url), { signal: AbortSignal.timeout(5000) })
    assert.equal(js.status, 200, `asset ${script[1]} from ${url}`)
  } finally {
    await stop()
  }
}

test('native dsh --profile web stays up and serves HTTP', async () => {
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-web-'))
  try {
    await bootWebAndFetch(nativeEnv({ DSH_HOME: bootHome }))
  } finally {
    rmSync(bootHome, { recursive: true, force: true })
  }
})

test('native dsh --profile web boots without DSH_HOME (uses ~/.dsh-native)', async () => {
  const env = { ...process.env }
  delete env.DSH_INSTALL
  delete env.DSH_HOME
  await bootWebAndFetch(env)
})

test('native dsh --profile web picks a free port when 3080 is taken', async () => {
  // Occupy 3080 in a child: an in-process listen can block the event loop
  // (the suite then never reaches its own timeout).
  const occupier = spawn(process.execPath, ['-e', `
    const s = require('node:http').createServer();
    s.on('error', (e) => { process.stderr.write(String(e.code || e) + '\\n'); process.exit(0); });
    s.listen(3080, '127.0.0.1', () => process.stdout.write('ok\\n'));
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  await Promise.race([
    new Promise((resolve) => occupier.stdout.once('data', resolve)),
    delay(2000),
  ])
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-web-busy-'))
  try {
    await bootWebAndFetch(nativeEnv({ DSH_HOME: bootHome }), [])
  } finally {
    occupier.kill('SIGKILL')
    await Promise.race([
      new Promise((resolve) => occupier.once('exit', resolve)),
      delay(1000),
    ])
    rmSync(bootHome, { recursive: true, force: true })
  }
})

test('native dsh web API', async (t) => {
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-api-'))
  const session = await bootNativeWeb(nativeEnv({ DSH_HOME: bootHome }))
  t.after(async () => {
    await session.stop()
    rmSync(bootHome, { recursive: true, force: true })
  })
  const { child, url, state, dump } = session
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, dump('listen'))
  assert.equal(child.exitCode, null, dump('listen'))
  console.log(`native-web-url ${url}`)

  await t.test('/api/host.describe', async () => {
    const got = await postApi(url, 'host.describe')
    assertRpcOk('host.describe', got, dump)
  })
  await t.test('/api/llm.providers', async () => {
    const got = await postApi(url, 'llm.providers')
    const body = assertRpcOk('llm.providers', got, dump)
    assert.ok(Array.isArray(body.result.value.providers), got.text)
    assert.ok(body.result.value.providers.length > 0, got.text)
  })
  await t.test('/api/agentPreset.list', async () => {
    const got = await postApi(url, 'agentPreset.list')
    const body = assertRpcOk('agentPreset.list', got, dump)
    assert.ok(Array.isArray(body.result.value.presets), got.text)
  })
  await t.test('/api/settings.describe', async () => {
    const got = await postApi(url, 'settings.describe')
    const body = assertRpcOk('settings.describe', got, dump)
    assert.equal(body.result.value.writable, true, got.text)
  })
  await t.test('/api/session.create', async () => {
    const got = await postApi(url, 'session.create')
    const body = assertRpcOk('session.create', got, dump)
    console.log(`session-create ${got.text}`)
    assert.equal(typeof body.result.value.sessionId, 'string', got.text)
  })
  await t.test('/api/session.export returns a zip', async () => {
    const created = await postApi(url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, dump).result.value.sessionId
    const exportUrl = new URL('/api/session.export', url)
    exportUrl.searchParams.set('sessionId', sessionId)
    exportUrl.searchParams.set('includeDescendants', 'true')
    const head = await fetch(exportUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    const headText = await head.text().catch(() => '')
    assert.equal(head.status, 200, `HEAD session.export HTTP ${head.status}\n${headText}\n${dump('session.export')}`)
    const got = await fetch(exportUrl, { method: 'GET', signal: AbortSignal.timeout(15000) })
    const body = Buffer.from(await got.arrayBuffer())
    assert.equal(got.status, 200, `GET session.export HTTP ${got.status}\n${body.subarray(0, 300).toString()}\n${dump('session.export')}`)
    assert.match(got.headers.get('content-type') ?? '', /zip/)
    assert.equal(body[0], 0x50, `not a zip: ${body.subarray(0, 20).toString('hex')}`)
    assert.equal(body[1], 0x4b)
  })
  await t.test('/api/session.prompt accepts IANA clientTimeZone', async () => {
    const created = await postApi(url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, dump).result.value.sessionId
    const zoned = await postApi(url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'ping' }],
      clientTimeZone: 'Asia/Shanghai',
    })
    assert.equal(zoned.res.status, 200, zoned.text)
    const zonedBody = JSON.parse(zoned.text)
    assert.notEqual(
      zonedBody.result?.error?.code,
      'invalid-time-zone',
      `IANA clientTimeZone rejected on native\n${zoned.text}\n${dump('session.prompt')}`,
    )
    const utc = await postApi(url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'ping' }],
      clientTimeZone: 'UTC',
    })
    const utcBody = JSON.parse(utc.text)
    assert.notEqual(utcBody.result?.error?.code, 'invalid-time-zone', utc.text)
    const cst = await postApi(url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'ping' }],
      clientTimeZone: 'CST',
    })
    const cstBody = JSON.parse(cst.text)
    assert.equal(cstBody.result?.ok, false, cst.text)
    assert.equal(cstBody.result?.error?.code, 'invalid-time-zone', cst.text)
  })
  await t.test('/api empty POST is HTTP 400', async () => {
    const empty = await postApi(url, 'llm.providers', {}, { body: null })
    assert.equal(empty.res.status, 400, `/api/llm.providers empty POST: HTTP ${empty.res.status}\n${empty.text}\n${dump('empty POST')}`)
  })
  await t.test('events.mux stays up through session.create', async () => {
    const mux = new URL('/api/events.mux', url)
    mux.protocol = 'ws:'
    const ws = new WebSocket(mux)
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`websocket timeout\n${dump('websocket')}`)), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(deadline)
        resolve()
      })
      ws.addEventListener('error', (event) => {
        clearTimeout(deadline)
        reject(new Error(`websocket error ${event.message ?? event}\n${dump('websocket')}`))
      })
    })
    try {
      const got = await postApi(url, 'session.create')
      assertRpcOk('session.create', got, dump)
      await delay(300)
      assert.equal(child.exitCode, null, dump('process death after mux session.create'))
      assert.doesNotMatch(state.stderr, /Unhandled promise rejection/, dump('process death after mux session.create'))
      assert.doesNotMatch(state.stderr, /TypeError: not a function/, dump('process death after mux session.create'))
    } finally {
      ws.close()
    }
  })
})

/**
 * Native island zlib cannot write real zstd, so older runs left plaintext
 * `session.jsonl` (and gzip bytes named `.jsonl.zstd`) under a backend whose
 * YAML default is compression zstd. Listing or prompting those sessions used
 * to throw encodingMismatch. Plant both suffixes, then list/create/export.
 */
function plantJsonlSession(root, { id, cwd, compression }) {
  const project = `--${cwd.replace(/^\/+/, '').replace(/\//g, '-')}--`
  const dir = join(root, 'sessions', project, id)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session',
    version: 0,
    id,
    createdAt: Date.now(),
    cwd,
    delegationDepth: 0,
  })
  const body = `${header}\n`
  if (compression === 'zstd') {
    writeFileSync(join(dir, 'session.jsonl.zstd'), gzipSync(body))
  } else {
    writeFileSync(join(dir, 'session.jsonl'), body)
  }
}

test('native dsh lists planted plaintext session.jsonl under default zstd config', async (t) => {
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-mixed-jsonl-'))
  const cwd = '/home/maci/dshtest'
  const plaintextId = 'session-84e9ca32-231b-4d17-806e-81248d088450'
  const gzipId = 'session-gzip-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  plantJsonlSession(bootHome, { id: plaintextId, cwd, compression: 'none' })
  plantJsonlSession(bootHome, { id: gzipId, cwd, compression: 'zstd' })
  const session = await bootNativeWeb(nativeEnv({ DSH_HOME: bootHome }))
  t.after(async () => {
    await session.stop()
    rmSync(bootHome, { recursive: true, force: true })
  })
  const { child, url, state, dump } = session
  assert.equal(child.exitCode, null, dump('listen'))
  assert.doesNotMatch(state.stderr, /configured for compression/, dump('listen'))
  assert.doesNotMatch(state.stderr, /encodingMismatch/, dump('listen'))

  const listed = await postApi(url, 'session.list')
  const listBody = assertRpcOk('session.list', listed, dump)
  const ids = (listBody.result.value.items ?? []).map((item) => item.sessionId)
  assert.ok(ids.includes(plaintextId), `plaintext jsonl missing from session.list: ${listed.text}`)
  assert.ok(ids.includes(gzipId), `gzip jsonl.zstd missing from session.list: ${listed.text}`)

  const created = await postApi(url, 'session.create')
  assertRpcOk('session.create', created, dump)
  assert.doesNotMatch(state.stderr, /configured for compression/, dump('session.create'))

  for (const sessionId of [plaintextId, gzipId]) {
    const exportUrl = new URL('/api/session.export', url)
    exportUrl.searchParams.set('sessionId', sessionId)
    exportUrl.searchParams.set('includeDescendants', 'true')
    const head = await fetch(exportUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    const headText = await head.text().catch(() => '')
    assert.equal(
      head.status,
      200,
      `HEAD session.export ${sessionId} HTTP ${head.status}\n${headText}\n${dump('session.export')}`,
    )
  }
})

function writeInsertPatch(dir, names, filename = 'overlay.yml') {
  const patch = join(dir, filename)
  const lines = ['- insert:']
  for (const name of names) {
    const id = `collected-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
    lines.push(`    - id: ${id}`, `      name: '${name}'`)
  }
  writeFileSync(patch, `${lines.join('\n')}\n`)
  return patch
}

function resolveErrorPattern(name) {
  return new RegExp(`cannot resolve module '${name.replace(/[/.]/g, '\\$&')}'`)
}

const YAML_BUNDLE_PACKAGES = new Set(['@deepseek-ai/dsh-base'])
const YAML_NAME_RE = /name:\s*['"](@deepseek-ai\/[^'"]+)['"]/g
const APPLY_RE = /export\s+(async\s+)?function\s+apply\b/

function pkgNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** Walk a tree and push directory paths onto `stack`. */
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

/**
 * Cordis plugins: `export function apply` packages plus YAML `name:` plugin rows
 * (class plugins such as the e2b trio). Skip yaml-bundle composition packages.
 */
function listApplyPluginNames(root) {
  const names = new Set()
  walkDirs(
    [join(root, 'packages'), join(root, 'vendor'), join(root, 'apps')],
    new Set(['node_modules', 'lib']),
    (path, name) => {
      if (name !== 'package.json') return
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof pkg.name !== 'string') return
      const srcRoot = join(dirname(path), 'src')
      walkDirs([srcRoot], new Set(['node_modules']), (srcPath, srcName) => {
        if (!srcName.endsWith('.ts') && !srcName.endsWith('.tsx')) return
        if (srcName === 'invariant.ts') return
        if (APPLY_RE.test(readFileSync(srcPath, 'utf8'))) names.add(pkg.name)
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
        if (!YAML_BUNDLE_PACKAGES.has(pkg)) names.add(pkg)
      }
    },
  )
  return [...names].sort()
}

/** Spawn native web with a launcher `--patch` and wait for listen or exit. */
function spawnWebPatch(env, patch, { timeoutMs = 20000 } = {}) {
  assert.ok(existsSync(bin), `native binary missing: ${bin}`)
  const child = spawn(bin, ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { state.stdout += chunk })
  child.stderr.on('data', (chunk) => { state.stderr += chunk })
  const done = new Promise((resolve) => {
    const deadline = setTimeout(() => {
      const match = state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      resolve({ kind: match ? 'listen' : 'timeout', url: match?.[1], code: child.exitCode })
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(deadline)
      const match = state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      resolve({ kind: match ? 'listen' : 'exit', url: match?.[1], code, signal })
    })
  })
  return { child, state, done }
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill('SIGKILL')
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(2000),
  ])
}

const MISSING_ISLAND_NAME = '@deepseek-ai/dsh-definitely-not-embedded'

test('native dsh resolves every apply() plugin', async () => {
  const applyNames = listApplyPluginNames(repoRoot)
  assert.ok(applyNames.length > 0, 'no apply() packages found')
  const embedSrc = readFileSync(join(here, '../src/bin.ts'), 'utf8')
  const missingEmbed = applyNames.filter((name) => !new RegExp(`void import\\('${name.replace(/[/.]/g, '\\$&')}'\\)`).test(embedSrc))
  assert.deepEqual(missingEmbed, [], `apply() packages missing void import(): ${missingEmbed.join(', ')}`)
  const extrasPath = join(here, '../collected-extras.json')
  const extras = JSON.parse(readFileSync(extrasPath, 'utf8'))
  assert.ok(Array.isArray(extras) && extras.length > 0, 'collected-extras.json is empty')

  const missingDir = mkdtempSync(join(tmpdir(), 'dsh-native-missing-'))
  const missingPatch = writeInsertPatch(missingDir, [MISSING_ISLAND_NAME])
  try {
    const missing = spawnWebPatch(nativeEnv({ DSH_HOME: missingDir }), missingPatch)
    const result = await missing.done
    const output = `${missing.state.stdout}\n${missing.state.stderr}`
    await stopChild(missing.child)
    assert.equal(result.kind, 'exit', `missing island name must not listen\n${output}`)
    assert.notEqual(result.code, 0, output)
    assert.match(output, resolveErrorPattern(MISSING_ISLAND_NAME), output)
    assert.match(output, /scriptc embeds npm code at build time/, output)
  } finally {
    rmSync(missingDir, { recursive: true, force: true })
  }

  const allDir = mkdtempSync(join(tmpdir(), 'dsh-native-all-apply-'))
  const allPatch = writeInsertPatch(allDir, applyNames)
  try {
    const all = spawnWebPatch(nativeEnv({ DSH_HOME: allDir }), allPatch, { timeoutMs: 25000 })
    const result = await all.done
    const output = `${all.state.stdout}\n${all.state.stderr}`
    await stopChild(all.child)
    assert.doesNotMatch(output, /scriptc embeds npm code at build time/, output)
    assert.doesNotMatch(output, /scr:import-trap/, output)
    assert.doesNotMatch(output, /Could not find export 'default'/, output)
    for (const name of applyNames) {
      assert.doesNotMatch(output, resolveErrorPattern(name), `native resolve failed for ${name}\n${output}`)
    }
    assert.match(
      output,
      /failed to (apply|import) loader entry|dsh web: http:\/\/127\.0\.0\.1:\d+/,
      `apply() overlay did not reach Cordis import()\n${output}`,
    )
  } finally {
    rmSync(allDir, { recursive: true, force: true })
  }

  const liveNames = extras.filter((name) => [
    '@deepseek-ai/dsh-schedule',
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
    '@deepseek-ai/dsh-subagent-codex',
    '@deepseek-ai/dsh-tmux-context',
    '@deepseek-ai/dsh-tool-session-query',
    '@deepseek-ai/dsh-web-fetch-http',
    '@deepseek-ai/dsh-web-search-exa',
    '@deepseek-ai/dsh-web-search-perplexity',
  ].includes(name))
  assert.ok(liveNames.length > 0, 'no collected extras remain that activate on default web')

  const liveDir = mkdtempSync(join(tmpdir(), 'dsh-native-live-extras-'))
  const livePatch = writeInsertPatch(liveDir, liveNames)
  const session = await bootNativeWeb(nativeEnv({ DSH_HOME: liveDir }), ['--port', '0'], {
    patchFiles: [livePatch],
  })
  try {
    const got = await postApi(session.url, 'pluginInventory/list', { args: {} })
    const body = assertRpcOk('pluginInventory/list', got, session.dump)
    const entries = body.result.value.entries
    assert.ok(Array.isArray(entries), got.text)
    for (const name of liveNames) {
      const entry = entries.find((row) => row.moduleName === name)
      assert.ok(entry, `Loader has no entry for ${name}\n${got.text}\n${session.dump('inventory')}`)
      assert.notEqual(
        entry.fiberPhase,
        null,
        `${name} fiberPhase is null (import did not run)\n${JSON.stringify(entry)}\n${session.dump('inventory')}`,
      )
    }
    const missingEntry = entries.find((row) => row.moduleName === MISSING_ISLAND_NAME)
    assert.equal(missingEntry, undefined, `absent island name must not be a live Loader entry\n${got.text}`)
  } finally {
    await session.stop()
    rmSync(liveDir, { recursive: true, force: true })
  }
})

test('native dsh --patch e2b trio does not import-trap', async () => {
  const e2bNames = [
    '@deepseek-ai/dsh-e2b',
    '@deepseek-ai/dsh-fs-e2b',
    '@deepseek-ai/dsh-subprocess-e2b',
  ]
  const applyNames = listApplyPluginNames(repoRoot)
  for (const name of e2bNames) {
    assert.ok(applyNames.includes(name), `${name} missing from apply()/YAML plugin scan`)
  }
  const embedSrc = readFileSync(join(here, '../src/bin.ts'), 'utf8')
  for (const name of e2bNames) {
    assert.match(embedSrc, new RegExp(`void import\\('${name.replace(/[/.]/g, '\\$&')}'\\)`), `${name} missing void import()`)
  }
  const e2bDir = mkdtempSync(join(tmpdir(), 'dsh-native-e2b-trio-'))
  const e2bPatch = writeInsertPatch(e2bDir, e2bNames)
  try {
    const e2b = spawnWebPatch(nativeEnv({ DSH_HOME: e2bDir }), e2bPatch, { timeoutMs: 25000 })
    await e2b.done
    const output = `${e2b.state.stdout}\n${e2b.state.stderr}`
    await stopChild(e2b.child)
    assert.doesNotMatch(output, /scr:import-trap/, output)
    assert.doesNotMatch(output, /Could not find export 'default'/, output)
    assert.doesNotMatch(output, /#ansi-styles/, output)
    assert.doesNotMatch(output, /failed to import loader entry/, output)
    for (const name of e2bNames) {
      assert.doesNotMatch(output, resolveErrorPattern(name), `native resolve failed for ${name}\n${output}`)
    }
    assert.match(
      output,
      /failed to apply loader entry|dsh web: http:\/\/127\.0\.0\.1:\d+/,
      `e2b trio overlay did not reach Cordis import()\n${output}`,
    )
  } finally {
    rmSync(e2bDir, { recursive: true, force: true })
  }
})

test('native dsh settings.openDocument hands the file to xdg-open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-open-cfg-'))
  const opener = join(dir, 'xdg-open')
  const opened = join(dir, 'opened')
  writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" > "${opened}"\n`)
  chmodSync(opener, 0o755)
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-settings-open-'))
  const session = await bootNativeWeb(nativeEnv({
    DSH_HOME: bootHome,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
  }))
  try {
    const got = await postApi(session.url, 'settings.openDocument')
    const body = assertRpcOk('settings.openDocument', got, session.dump)
    assert.equal(body.result.value.opened, true, got.text)
    assert.doesNotMatch(got.text, /execFile is not available/, got.text)
    assert.equal(existsSync(opened), true, `xdg-open was not invoked (${opened})\n${session.dump('settings.openDocument')}`)
    const target = readFileSync(opened, 'utf8').trim()
    assert.match(target, /settings\.ya?ml$/, target)
  } finally {
    await session.stop()
    rmSync(bootHome, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native dsh --profile web hands the URL to xdg-open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-xdg-'))
  const opener = join(dir, 'xdg-open')
  const opened = join(dir, 'opened')
  writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" > "${opened}"\n`)
  chmodSync(opener, 0o755)
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-web-open-'))
  try {
    await bootWebAndFetch(nativeEnv({
      DSH_HOME: bootHome,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
    }), [], { openBrowser: true })
    assert.equal(existsSync(opened), true, `xdg-open was not invoked (${opened})`)
    assert.match(readFileSync(opened, 'utf8').trim(), /^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    rmSync(bootHome, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
