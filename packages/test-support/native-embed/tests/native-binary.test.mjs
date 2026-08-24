/**
 * Drives the scriptc-compiled native dsh binary (not node/tsx).
 * Binary path: DSH_NATIVE_BIN or <workspace>/dist/dsh (the staged install).
 * Native runs must not set DSH_INSTALL: dist/package.json next to the binary
 * is the install anchor.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync, inflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { listApplyPluginNames } from '../src/list-plugins.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const workspaceRoot = resolve(repoRoot, '..')
const defaultBin = join(workspaceRoot, 'dist/dsh')
const bin = process.env.DSH_NATIVE_BIN ?? defaultBin
const install = join(repoRoot, 'apps/cli/package.json')

/** Copy process.env, overlay `extra`, drop DSH_INSTALL. `undefined` values remove keys. */
function nativeEnv(extra = {}) {
  const env = { ...process.env }
  delete env.DSH_INSTALL
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function run(args) {
  assert.ok(existsSync(bin), `native binary missing: ${bin}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-cli-'))
  try {
    return spawnSync(bin, args, {
      env: nativeEnv({ DSH_HOME: dir }),
      encoding: 'utf8',
      timeout: 45000,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  assert.notEqual(
    parsed.result,
    undefined,
    `/api/${method}: missing result\n${text}\n${dump(`/api/${method}`)}`,
  )
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

test('native dsh --profile web boots without DSH_HOME (uses ~/.dsh-native)', async (t) => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-native-user-home-'))
  t.after(() => rmSync(isolatedHome, { recursive: true, force: true }))
  assert.notEqual(isolatedHome, process.env.HOME, 'temp HOME must not be the real user home')
  const env = nativeEnv({ HOME: isolatedHome, DSH_HOME: undefined })
  if (process.platform === 'win32') env.USERPROFILE = isolatedHome
  assert.equal(env.HOME, isolatedHome)
  assert.equal(env.DSH_HOME, undefined)
  await bootWebAndFetch(env)
  assert.equal(
    existsSync(join(isolatedHome, '.dsh-native')),
    true,
    `native default home was not created under redirected HOME (${isolatedHome})`,
  )
})

test('native dsh --profile web picks a free port when 3080 is taken', async () => {
  // Occupy 3080 in a child: an in-process listen can block the event loop
  // (the suite then never reaches its own timeout).
  const occupier = spawn(process.execPath, ['-e', `
    const s = require('node:http').createServer();
    s.on('error', (e) => { process.stderr.write(String(e.code || e) + '\\n'); process.exit(1); });
    s.listen(3080, '127.0.0.1', () => process.stdout.write('ok\\n'));
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  occupier.stdout.setEncoding('utf8')
  occupier.stderr.setEncoding('utf8')
  let occupierOut = ''
  let occupierErr = ''
  const handshake = Promise.race([
    new Promise((resolve, reject) => {
      occupier.stdout.on('data', (chunk) => {
        occupierOut += chunk
        if (occupierOut.includes('ok')) resolve('ok')
      })
      occupier.stderr.on('data', (chunk) => { occupierErr += chunk })
      occupier.once('exit', (code) => {
        if (occupierOut.includes('ok')) return
        reject(new Error(`3080 occupier exited ${code} without ok\nstdout:\n${occupierOut}\nstderr:\n${occupierErr}`))
      })
    }),
    delay(2000).then(() => null),
  ])
  const gotOk = await handshake
  assert.equal(
    gotOk,
    'ok',
    `3080 occupier did not print ok\nstdout:\n${occupierOut}\nstderr:\n${occupierErr}`,
  )
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
  await t.test('idle native web does not busy-loop', async () => {
    const pid = child.pid
    assert.ok(typeof pid === 'number' && pid > 0, dump('idle cpu pid'))
    const cpuTicks = () => {
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const parts = st.slice(st.lastIndexOf(')') + 2).split(' ')
      return Number(parts[11]) + Number(parts[12])
    }
    const before = cpuTicks()
    await delay(1000)
    const used = cpuTicks() - before
    assert.ok(
      used < 40,
      `idle web burned ${used} ticks in 1s (~100 is a full core)\n${dump('idle cpu')}`,
    )
  })
  await t.test('session.prompt keeps the jsonl header and export stays 200', async () => {
    const created = await postApi(url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, dump).result.value.sessionId
    const prompted = await postApi(url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'ping' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(800)
    const logs = listSessionJsonl(bootHome)
    assert.ok(logs.length > 0, `no session.jsonl under ${bootHome}\n${dump('session.prompt persist')}`)
    const matching = logs.filter((path) => path.includes(sessionId))
    assert.ok(matching.length > 0, `session ${sessionId} jsonl missing: ${logs.join('\n')}`)
    const first = readFileSync(matching[0], 'utf8').split('\n', 1)[0]
    assert.match(first, /"type":"session"/, `jsonl lost its header:\n${first}\n${dump('session.prompt persist')}`)
    const exportUrl = new URL('/api/session.export', url)
    exportUrl.searchParams.set('sessionId', sessionId)
    exportUrl.searchParams.set('includeDescendants', 'true')
    const head = await fetch(exportUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    const headText = await head.text().catch(() => '')
    assert.equal(
      head.status,
      200,
      `HEAD session.export after prompt HTTP ${head.status}\n${headText}\n${dump('session.export after prompt')}`,
    )
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
    const ac = new AbortController()
    const res = await fetch(mux, { signal: ac.signal })
    assert.equal(res.status, 200, `GET events.mux HTTP ${res.status}\n${dump('events.mux')}`)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/, dump('events.mux'))
    try {
      const got = await postApi(url, 'session.create')
      assertRpcOk('session.create', got, dump)
      await delay(300)
      assert.equal(child.exitCode, null, dump('process death after mux session.create'))
      assert.doesNotMatch(state.stderr, /Unhandled promise rejection/, dump('process death after mux session.create'))
      assert.doesNotMatch(state.stderr, /TypeError: not a function/, dump('process death after mux session.create'))
    } finally {
      ac.abort()
    }
  })
})

/**
 * Native island zlib cannot write real zstd, so older runs left plaintext
 * `session.jsonl` (and gzip bytes named `.jsonl.zstd`) under a backend whose
 * YAML default is compression zstd. Listing or prompting those sessions used
 * to throw encodingMismatch. Plant both suffixes, then list/create/export.
 */
function listSessionJsonl(root) {
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name)
      if (ent.isDirectory()) walk(path)
      else if (ent.name === 'session.jsonl' || ent.name === 'session.jsonl.zstd') files.push(path)
    }
  }
  walk(join(root, 'sessions'))
  return files
}

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

function embedImportPattern(name) {
  return new RegExp(`(?:void )?import\\('${name.replace(/[/.]/g, '\\$&')}'\\)`)
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
  const done = new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(result)
    }
    const deadline = setTimeout(() => {
      const match = state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      finish({ kind: match ? 'listen' : 'timeout', url: match?.[1], code: child.exitCode })
    }, timeoutMs)
    const onChunk = (chunk) => {
      state.stdout += chunk
      const match = state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) finish({ kind: 'listen', url: match[1], code: child.exitCode })
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', (chunk) => { state.stderr += chunk })
    child.once('exit', (code, signal) => {
      const match = state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      finish({ kind: match ? 'listen' : 'exit', url: match?.[1], code, signal })
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
  const missingEmbed = applyNames.filter((name) => !embedImportPattern(name).test(embedSrc))
  assert.deepEqual(missingEmbed, [], `apply() packages missing embed import(): ${missingEmbed.join(', ')}`)
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
    assert.match(embedSrc, embedImportPattern(name), `${name} missing embed import()`)
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

test('native dsh --patch authorization and invariants do not import-trap', async () => {
  const names = [
    '@deepseek-ai/dsh-authorization',
    '@deepseek-ai/dsh-invariants',
  ]
  const applyNames = listApplyPluginNames(repoRoot)
  const embedSrc = readFileSync(join(here, '../src/bin.ts'), 'utf8')
  for (const name of names) {
    assert.ok(applyNames.includes(name), `${name} missing from apply()/YAML/Service plugin scan`)
    assert.match(embedSrc, embedImportPattern(name), `${name} missing embed import()`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-auth-inv-'))
  const patch = writeInsertPatch(dir, names)
  try {
    const spawned = spawnWebPatch(nativeEnv({ DSH_HOME: dir }), patch, { timeoutMs: 25000 })
    await spawned.done
    const output = `${spawned.state.stdout}\n${spawned.state.stderr}`
    await stopChild(spawned.child)
    assert.doesNotMatch(output, /scr:import-trap/, output)
    assert.doesNotMatch(output, /Could not find export 'default'/, output)
    assert.doesNotMatch(output, /failed to import loader entry/, output)
    for (const name of names) {
      assert.doesNotMatch(output, resolveErrorPattern(name), `native resolve failed for ${name}\n${output}`)
    }
    assert.match(
      output,
      /failed to apply loader entry|dsh web: http:\/\/127\.0\.0\.1:\d+/,
      `authorization overlay did not reach Cordis import()\n${output}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test('native dsh binary is a statically linked ELF with no island import-trap', () => {
  assert.ok(existsSync(bin), `native binary missing: ${bin}`)
  const bytes = readFileSync(bin)
  assert.equal(bytes[0], 0x7f, 'not an ELF (magic byte 0)')
  assert.equal(bytes[1], 0x45, 'not an ELF (magic byte 1)')
  assert.equal(bytes[4], 2, 'not ELF64')
  assert.equal(bytes[5], 1, 'not little-endian')
  assert.equal(bytes.readUInt16LE(18), 0x3e, 'not x86-64 (e_machine)')
  const phoff = Number(bytes.readBigUInt64LE(32))
  const phentsize = bytes.readUInt16LE(54)
  const phnum = bytes.readUInt16LE(56)
  let dynamicHeaders = 0
  for (let i = 0; i < phnum; i++) {
    if (bytes.readUInt32LE(phoff + i * phentsize) === 2 /* PT_DYNAMIC */) dynamicHeaders++
  }
  assert.equal(dynamicHeaders, 0, 'binary has a PT_DYNAMIC header (dynamically linked)')
  assert.equal(countOccurrences(bytes, 'scr:import-trap'), 0, 'binary contains scr:import-trap island strings')
  assert.ok(
    countOccurrences(bytes, '@deepseek-ai/dsh-home-paths') > 0,
    'CLI static-import package dsh-home-paths missing from the native code',
  )
  assert.ok(countOccurrences(bytes, '0.1.1-rc.5+scriptc.33') > 0, 'native build version string missing from the binary')
})

test('native dsh --profile headless boots the plugin tree and reaches the LLM boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-headless-boot-'))
  try {
    const r = spawnSync(bin, ['--profile', 'headless', 'say hi'], {
      env: nativeEnv({ DSH_HOME: dir }),
      encoding: 'utf8',
      timeout: 60000,
    })
    const output = `${r.stdout}\n${r.stderr}`
    assert.equal(r.signal, null, `headless killed by ${r.signal}\n${output}`)
    assert.equal(r.status, 1, `headless expected to fail at the LLM boundary, got ${r.status}\n${output}`)
    assert.match(r.stderr, /MISSING_CREDENTIAL/, output)
    assert.doesNotMatch(output, /plugin tree failed to load/, output)
    assert.doesNotMatch(output, /scr:import-trap/, output)
    assert.doesNotMatch(output, /typert-loader/, output)
    assert.doesNotMatch(output, /unexpected token/, output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native dsh --profile headless --dump-config is stable and lists the headless plugin set', () => {
  const a = run(['--profile', 'headless', '--dump-config'])
  const b = run(['--profile', 'headless', '--dump-config'])
  assert.equal(a.status, 0, a.stderr)
  assert.equal(a.stdout, b.stdout)
  assert.match(a.stdout, /@deepseek-ai\/dsh-base/)
  assert.match(a.stdout, /name: '@deepseek-ai\/dsh-llm'/)
  assert.match(a.stdout, /name: '@deepseek-ai\/dsh-tool-bash'/)
  assert.doesNotMatch(a.stdout, /plugin tree failed to load/)
  assert.doesNotMatch(a.stderr, /typert-loader/)
  assert.doesNotMatch(a.stderr, /unexpected token/)
})

test('native dsh web runs a session round-trip with the live extras active', async (t) => {
  const liveExtras = [
    '@deepseek-ai/dsh-schedule',
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
    '@deepseek-ai/dsh-subagent-codex',
    '@deepseek-ai/dsh-tmux-context',
    '@deepseek-ai/dsh-tool-session-query',
    '@deepseek-ai/dsh-web-fetch-http',
    '@deepseek-ai/dsh-web-search-exa',
    '@deepseek-ai/dsh-web-search-perplexity',
  ]
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-live-rt-'))
  const patch = writeInsertPatch(dir, liveExtras)
  const session = await bootNativeWeb(nativeEnv({ DSH_HOME: dir }), ['--port', '0'], {
    patchFiles: [patch],
  })
  t.after(async () => {
    await session.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const { url, state, dump } = session
  assert.equal(session.child.exitCode, null, dump('listen'))
  assert.doesNotMatch(state.stderr, /plugin tree failed to load/, dump('listen'))
  assert.doesNotMatch(state.stderr, /scr:import-trap/, dump('listen'))
  // The extras occupy the event loop briefly; the listener binds a tick after
  // the URL is printed. Give it a beat before the first request.
  await delay(300)
  const created = await postApi(url, 'session.create')
  const sessionId = assertRpcOk('session.create', created, dump).result.value.sessionId
  const prompted = await postApi(url, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'ping' }],
    clientTimeZone: 'UTC',
  })
  assert.equal(prompted.res.status, 200, prompted.text)
  await delay(800)
  const jsonl = listSessionJsonl(dir).filter((path) => path.includes(sessionId))
  assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId} with live extras patched\n${dump('live round-trip')}`)
  const header = readFileSync(jsonl[0], 'utf8').split('\n', 1)[0]
  assert.match(header, /"type":"session"/, `jsonl lost its header:\n${header}\n${dump('live round-trip')}`)
  const exportUrl = new URL('/api/session.export', url)
  exportUrl.searchParams.set('sessionId', sessionId)
  exportUrl.searchParams.set('includeDescendants', 'true')
  const exp = await fetch(exportUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
  assert.equal(exp.status, 200, `session.export ${sessionId} HTTP ${exp.status}\n${dump('live round-trip')}`)
})

test('native dsh persists a created session across process restarts', async (t) => {
  const bootHome = mkdtempSync(join(tmpdir(), 'dsh-native-restart-'))
  let sessionId = ''
  const first = await bootNativeWeb(nativeEnv({ DSH_HOME: bootHome }))
  try {
    const created = await postApi(first.url, 'session.create')
    sessionId = assertRpcOk('session.create', created, first.dump).result.value.sessionId
    const prompted = await postApi(first.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'persist me' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(800)
  } finally {
    await first.stop()
  }
  const second = await bootNativeWeb(nativeEnv({ DSH_HOME: bootHome }))
  t.after(async () => {
    await second.stop()
    rmSync(bootHome, { recursive: true, force: true })
  })
  const listed = await postApi(second.url, 'session.list')
  const ids = (assertRpcOk('session.list', listed, second.dump).result.value.items ?? []).map((item) => item.sessionId)
  assert.ok(ids.includes(sessionId), `session ${sessionId} lost after restart\n${listed.text}\n${second.dump('restart list')}`)
  const exportUrl = new URL('/api/session.export', second.url)
  exportUrl.searchParams.set('sessionId', sessionId)
  exportUrl.searchParams.set('includeDescendants', 'true')
  const exp = await fetch(exportUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
  assert.equal(exp.status, 200, `session.export ${sessionId} HTTP ${exp.status} after restart\n${second.dump('restart export')}`)
  const jsonl = listSessionJsonl(bootHome).filter((path) => path.includes(sessionId))
  assert.ok(jsonl.length > 0, `session.jsonl for ${sessionId} gone after restart`)
})

/** The default web profile's `name:` rows, parsed from `--profile web --dump-config`. */
function webProfilePluginNames() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-web-profile-'))
  try {
    const r = spawnSync(bin, ['--profile', 'web', '--dump-config'], {
      env: nativeEnv({ DSH_HOME: dir }),
      encoding: 'utf8',
      timeout: 45000,
    })
    assert.equal(r.status, 0, r.stderr)
    return new Set([...r.stdout.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)].map((m) => m[1]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** YAML indentation for a plain object (values JSON-encoded; nested objects recurse). */
function yamlLines(value, indent) {
  const out = []
  for (const [key, val] of Object.entries(value)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      out.push(`${indent}${key}:`)
      out.push(...yamlLines(val, `${indent}  `))
    } else {
      out.push(`${indent}${key}: ${JSON.stringify(val)}`)
    }
  }
  return out
}

/**
 * Boot the web profile with one non-default plugin inserted (plus its recipe:
 * config, disabled conflicts, dependency plugins, entry overrides) and assert
 * the plugin applies and activates. Every inventoried plugin that is not part
 * of the default web profile gets a dedicated boot here, so the status report
 * has per-plugin functional evidence instead of "resolve only".
 */
test('every inventoried plugin applies and activates on the web profile', { timeout: 1_200_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-native-per-plugin-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  // Fixtures consumed by plugin configs.
  const includeTarget = join(scratch, 'include-entries.yml')
  writeFileSync(includeTarget, `- id: noop\n  name: '@deepseek-ai/cordis-plugin-logger-console'\n  disabled: true\n`)
  const hooksConfig = join(scratch, 'hooks-config.json')
  writeFileSync(hooksConfig, '{}\n')
  const replayFixture = join(scratch, 'replay.jsonl')
  writeFileSync(replayFixture, '{"kind":"chunks","chunks":[]}\n')
  const dbPath = join(scratch, 'test.db')

  const RECIPES = {
    '@deepseek-ai/cordis-plugin-include': { config: { path: includeTarget } },
    '@deepseek-ai/dsh-acp-demo': {
      // Self-contained demo: owns JSONL persistence + query index, so it runs
      // on the base bundle with those entries disabled rather than on web.
      profile: { bundles: ['@deepseek-ai/dsh-base'], disable: ['session-persistence-jsonl', 'session-query-sqlite'] },
      config: {
        provider: 'stdio',
        model: 'deepseek-chat',
        workspaceContext: false,
        dshHome: '/tmp',
        tools: {},
        sessionTitle: { fallbackMaxWords: 8, fallbackMaxBytes: 2000, maxTitleBytes: 2000 },
        skills: {},
        toolBash: {},
        jobs: {},
        invariants: {},
        persistenceRoot: join(scratch, 'acpd-sessions'),
      },
    },
    '@deepseek-ai/dsh-agent-spine-demo': {
      config: {
        workspaceContext: false,
        dshHome: '/tmp',
        tools: {},
        sessionTitle: { fallbackMaxWords: 8, fallbackMaxBytes: 2000, maxTitleBytes: 2000 },
        skills: {},
        toolBash: {},
        jobs: {},
        invariants: {},
      },
    },
    '@deepseek-ai/dsh-agent-tool-presentation': { config: { mode: 'native' } },
    '@deepseek-ai/dsh-bash-local': { disable: ['bash-sandbox', 'permission'] },
    '@deepseek-ai/dsh-e2b': { env: { E2B_API_KEY: 'test-key' } },
    '@deepseek-ai/dsh-experimental-tool-agent-team': { deps: ['@deepseek-ai/dsh-experimental-agent-team'] },
    '@deepseek-ai/dsh-fs-e2b': { disable: ['fs-sandbox'], deps: ['@deepseek-ai/dsh-e2b'], env: { E2B_API_KEY: 'test-key' } },
    '@deepseek-ai/dsh-fs-local': { disable: ['fs-sandbox'] },
    '@deepseek-ai/dsh-hooks-claude-code': { config: { configPath: hooksConfig } },
    '@deepseek-ai/dsh-hooks-codex': { config: { configPath: hooksConfig } },
    '@deepseek-ai/dsh-host-directory-picker-browse': {
      disable: ['directory-picker'],
      patch: { connection: { maxRequestBodyBytes: 300_000_000 } },
    },
    '@deepseek-ai/dsh-host-frontend-static': { config: { distIndex: '/index.html' } },
    '@deepseek-ai/dsh-llm-replay': { env: { DSH_SNAPSHOT_FILE: replayFixture } },
    '@deepseek-ai/dsh-lsp-stdio': { deps: ['@deepseek-ai/dsh-lsp'], config: { servers: { test: { command: '/bin/true', extensionToLanguage: { '.ts': 'typescript' } } } } },
    '@deepseek-ai/dsh-mcp-client': { config: { transport: 'stdio', serverName: 'test', command: '/bin/true' } },
    '@deepseek-ai/dsh-pwsh-local': { disable: ['pwsh-sandbox', 'bash-sandbox', 'permission'] },
    '@deepseek-ai/dsh-session-title-all-prompts-llm': { disable: ['session-title-llm'], config: { targetWords: 10, targetCjkCharacters: 10, maxInputBytes: 4000, maxOutputTokens: 256, timeoutMs: 10000 } },
    '@deepseek-ai/dsh-storage-sqlite': { config: { path: dbPath } },
    '@deepseek-ai/dsh-subagent-acp': { config: { command: '/bin/true' } },
    '@deepseek-ai/dsh-subagent-dsh-sdk': { config: { command: '/bin/true' } },
    '@deepseek-ai/dsh-subprocess-e2b': { disable: ['subprocess'], deps: ['@deepseek-ai/dsh-e2b'], env: { E2B_API_KEY: 'test-key' } },
    '@deepseek-ai/dsh-terminal-bash': { deps: ['@deepseek-ai/dsh-terminal'] },
    '@deepseek-ai/dsh-tool-bash-persistent': { deps: ['@deepseek-ai/dsh-terminal'] },
    '@deepseek-ai/dsh-tool-lsp': { deps: ['@deepseek-ai/dsh-lsp'] },
    '@deepseek-ai/dsh-tool-pwsh-persistent': { deps: ['@deepseek-ai/dsh-terminal'] },
    '@deepseek-ai/dsh-tool-terminal': { deps: ['@deepseek-ai/dsh-terminal'] },
    '@deepseek-ai/dsh-time-context': { config: { timeZone: 'UTC' } },
  }

  const profilePlugins = webProfilePluginNames()
  const candidates = listApplyPluginNames(repoRoot).filter((name) => !profilePlugins.has(name))
  assert.ok(candidates.length >= 40, `expected most non-default plugins to be tested, got ${candidates.length}`)

  const failures = []
  for (const name of candidates) {
    // agent-plane rows apply inside an agent scope, which agent presets
    // compose: agent-tool-presentation rides the `code` preset,
    // persona the `standard` preset. Mount them through a preset session
    // instead of a global insert.
    // dsh-headless is the headless profile's app bundle: it runs one task and
    // exits. The headless-profile boot test already applies it and reaches the
    // LLM boundary, so its web-profile insert would only double the coverage.
    if (name === '@deepseek-ai/dsh-headless') continue
    const agentPlanePreset = { '@deepseek-ai/dsh-agent-tool-presentation': 'code', '@deepseek-ai/dsh-persona': 'standard' }[name]
    if (agentPlanePreset !== undefined) {
      const bootHome = join(scratch, `boot-${name.replace(/[^a-z0-9]+/gi, '-')}`)
      mkdirSync(bootHome, { recursive: true })
      const session = await bootNativeWeb(nativeEnv({ DSH_HOME: bootHome }), ['--port', '0'], {})
      const problems = []
      try {
        if (session.child.exitCode !== null) {
          problems.push(`process exited (code ${session.child.exitCode})`)
        } else {
          if (/plugin tree failed to load/.test(session.state.stderr)) problems.push('plugin tree failed to load')
          const created = await postApi(session.url, 'session.create', { agentPreset: agentPlanePreset })
          if (created.res.status === 200) {
            const body = JSON.parse(created.text)
            if (body.result?.ok !== true) problems.push(`${agentPlanePreset}-preset session.create failed: ${created.text.slice(0, 200)}`)
          } else {
            problems.push(`${agentPlanePreset}-preset session.create HTTP ${created.res.status}`)
          }
        }
      } finally {
        await session.stop()
        rmSync(bootHome, { recursive: true, force: true })
      }
      if (problems.length > 0) failures.push(`${name}: ${problems.join('; ')}`)
      continue
    }
    const recipe = RECIPES[name] ?? {}
    const patch = join(scratch, `overlay-${name.replace(/[^a-z0-9]+/gi, '-')}.yml`)
    // writeInsertPatch emits "- insert:" rows; replace it with the recipe-aware overlay.
    const lines = []
    for (const id of recipe.disable ?? []) lines.push(`- id: ${id}`, '  disabled: true')
    for (const [id, overrides] of Object.entries(recipe.patch ?? {})) {
      lines.push(`- id: ${id}`, '  config:', ...yamlLines(overrides, '    '))
    }
    lines.push('- insert:')
    const insertId = `t-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
    lines.push(`    - id: ${insertId}`, `      name: '${name}'`)
    if (recipe.config !== undefined) lines.push('      config:', ...yamlLines(recipe.config, '        '))
    for (const [i, dep] of (recipe.deps ?? []).entries()) {
      lines.push(`    - id: dep-${i}`, `      name: '${dep}'`)
    }
    writeFileSync(patch, `${lines.join('\n')}\n`)

    const bootHome = join(scratch, `boot-${insertId}`)
    mkdirSync(bootHome, { recursive: true })
    const env = nativeEnv({ DSH_HOME: bootHome, ...(recipe.env ?? {}) })
    const profile = recipe.profile
    let session
    if (profile !== undefined) {
      const profileDir = join(bootHome, 'profiles', 'custom')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(
        join(profileDir, 'package.json'),
        `${JSON.stringify({ name: 'custom-profile', version: '0.0.0', private: true, dsh: { profile: { bundles: profile.bundles } } }, null, 2)}\n`,
      )
      const profileLines = []
      for (const id of profile.disable ?? []) profileLines.push(`- id: ${id}`, '  disabled: true')
      profileLines.push(...lines.slice(lines.findIndex((l) => l === '- insert:')))
      writeFileSync(join(profileDir, 'cordis.patch.yml'), `${profileLines.join('\n')}\n`)
      // A custom bundle profile (e.g. a stdio ACP app) may serve no web UI;
      // assert the process stays alive with a clean tree instead of a URL.
      const child = spawn(bin, ['--profile', 'custom', '--no-open', '--port', '0'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const state = { stdout: '', stderr: '' }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { state.stdout += chunk })
      child.stderr.on('data', (chunk) => { state.stderr += chunk })
      await delay(4000)
      session = {
        child,
        url: '',
        state,
        dump: (s = 'listen') => `${s}: exit=${child.exitCode}\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`,
        stop: async () => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          if (child.exitCode !== null) return
          child.kill('SIGKILL')
          await Promise.race([new Promise((r) => child.once('exit', r)), delay(2000)])
        },
      }
    } else {
      session = await bootNativeWeb(env, ['--port', '0'], { patchFiles: [patch] })
    }
    const problems = []
    try {
      if (session.child.exitCode !== null) {
        problems.push(`process exited (code ${session.child.exitCode})`)
      } else {
        if (/plugin tree failed to load/.test(session.state.stderr)) problems.push('plugin tree failed to load')
        if (/scr:import-trap/.test(session.state.stderr)) problems.push('scr:import-trap')
        const failed = session.state.stderr.match(/failed to (?:apply|import) loader entry [a-z0-9-]+ \(@deepseek-ai\/[^)]+\): ([^\n|]+)/g)
        if (failed !== null) problems.push(`loader entry failures: ${failed.slice(0, 2).join(' | ')}`)
        const baseUrl = typeof session.url === 'string' ? session.url : await session.url
        if (baseUrl !== '') {
          let got
          try {
            got = await postApi(baseUrl, 'pluginInventory/list', { args: {} })
          } catch (error) {
            problems.push(`pluginInventory fetch failed (${String(error.cause?.code ?? error)}); process may have died after listen`)
          }
          if (got !== undefined && got.res.status === 200) {
            const body = JSON.parse(got.text)
            const entries = body.result?.value?.entries
            if (Array.isArray(entries)) {
              const entry = entries.find((row) => row.moduleName === name)
              if (entry === undefined) problems.push(`not in plugin inventory`)
              else if (entry.fiberPhase === null) problems.push('fiberPhase null (did not activate)')
            }
          }
        }
      }
    } finally {
      await session.stop()
      rmSync(bootHome, { recursive: true, force: true })
    }
    if (problems.length > 0) {
      failures.push(`${name}: ${problems.join('; ')}\n${session.state.stderr.split('\n').slice(0, 4).join('\n')}`)
    }
  }
  assert.deepEqual(failures, [], `plugins that failed to apply/activate:\n${failures.join('\n\n')}`)
})

/**
 * llm-replay fixtures that make the native agent loop run a COMPLETE turn
 * offline: a canned model script (text answer, or a bash tool-call followed
 * by the final answer) stands in for the LLM, so the loop, tool execution,
 * and session persistence all run end-to-end without network or keys.
 */
function writeReplayFixtures(dir) {
  const primary = join(dir, 'replay-session.jsonl')
  writeFileSync(primary, `${JSON.stringify({ type: 'session', version: 0, id: 'replay', createdAt: Date.now(), cwd: '/tmp', delegationDepth: 0 })}\n`)
  const textScript = join(dir, 'replay-text.json')
  writeFileSync(textScript, `${JSON.stringify([{ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello from native dsh!' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello from native dsh!' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }])}\n`)
  const toolScript = join(dir, 'replay-tool.json')
  writeFileSync(toolScript, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bash', argumentsDelta: '{"command":"echo hello-from-native","description":"test"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: { command: 'echo hello-from-native', description: 'test' } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The command ran and printed hello-from-native' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'The command ran and printed hello-from-native' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}\n`)
  const replayPatch = join(dir, 'llm-replay.yml')
  // The session-title plugin shares the session's LLM route and consumes a
  // replay entry per title generation; disabling it keeps fixture entries in
  // 1:1 correspondence with the turn's model calls.
  writeFileSync(replayPatch, `- id: session-title-llm\n  disabled: true\n- insert:\n    - id: llm-replay\n      name: '@deepseek-ai/dsh-llm-replay'\n`)
  return { primary, textScript, toolScript, replayPatch }
}

function replayEnv(dir, script, extra = {}) {
  return nativeEnv({
    DSH_SNAPSHOT_FILE: join(dir, 'replay-session.jsonl'),
    DSH_SNAPSHOT_OVERRIDE: script,
    ...extra,
  })
}

test('native dsh headless completes a task end-to-end via llm-replay (no network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-'))
  try {
    const { primary, textScript, replayPatch } = writeReplayFixtures(dir)
    const r = spawnSync(bin, ['--profile', 'headless', '--patch', replayPatch, 'say hi'], {
      env: replayEnv(dir, textScript, { DSH_HOME: dir }),
      encoding: 'utf8',
      timeout: 90000,
    })
    assert.equal(r.signal, null, `${r.signal}\n${r.stdout}\n${r.stderr}`)
    assert.equal(r.status, 0, `headless replay run failed (${r.status})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.match(r.stdout, /Hello from native dsh!/, `final answer missing from headless stdout:\n${r.stdout}`)
    assert.doesNotMatch(r.stderr, /plugin tree failed to load/, r.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native dsh web completes a session turn via llm-replay (assistant message persisted)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-web-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { textScript, replayPatch } = writeReplayFixtures(dir)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, textScript, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'say hi' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(2500)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}\n${session.dump('replay turn')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"assistant\/message"/, `assistant message missing — the turn never completed\n${session.dump('replay turn')}`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end\n${session.dump('replay turn')}`)
    assert.match(text, /Hello from native dsh!/, `replayed answer not persisted\n${session.dump('replay turn')}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web executes a bash tool call end-to-end via llm-replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-tool-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { toolScript, replayPatch } = writeReplayFixtures(dir)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, toolScript, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'run a command' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(3500)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}\n${session.dump('tool turn')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"tool\/call"/, `tool call not recorded\n${session.dump('tool turn')}`)
    assert.match(text, /"type":"tool\/result"/, `tool result not recorded — bash never ran\n${session.dump('tool turn')}`)
    assert.match(text, /hello-from-native\\n/, `bash command output missing from the tool result\n${session.dump('tool turn')}`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end\n${session.dump('tool turn')}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web executes a write tool call via llm-replay (file lands on disk)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-write-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fileName = `native-wr-${process.pid}-${Date.now()}.txt`
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-write.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'write', argumentsDelta: JSON.stringify({ file_path: fileName, content: 'written by native dsh' }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'write', arguments: { file_path: fileName, content: 'written by native dsh' } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'File written.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'File written.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}\n`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'write a file' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(3500)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}\n${session.dump('write turn')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"tool\/result"/, `tool result not recorded\n${session.dump('write turn')}`)
    // The sandboxed fs backend resolved the workspace (the process cwd) and
    // really wrote the file: assert both the recorded result and on-disk bytes.
    const landed = join(process.cwd(), fileName)
    assert.equal(existsSync(landed), true, `write tool did not create ${landed}\n${session.dump('write turn')}`)
    assert.equal(readFileSync(landed, 'utf8'), 'written by native dsh', `unexpected file content at ${landed}`)
  } finally {
    await session.stop()
    rmSync(join(process.cwd(), fileName), { force: true })
  }
})

test('native dsh web chains write then read tools via llm-replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-writeread-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fileName = `native-wr-${process.pid}-${Date.now()}.txt`
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-writeread.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'write', argumentsDelta: JSON.stringify({ file_path: fileName, content: 'hello from the write tool' }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'write', arguments: { file_path: fileName, content: 'hello from the write tool' } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_2', name: 'read', argumentsDelta: JSON.stringify({ file_path: fileName }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_2', name: 'read', arguments: { file_path: fileName } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The file contained: hello from the write tool' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'The file contained: hello from the write tool' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}\n`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'write then read a file' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(4500)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}\n${session.dump('write-read turn')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    const results = [...text.matchAll(/"type":"tool\/result"/g)]
    assert.ok(results.length >= 2, `expected write + read results, got ${results.length}\n${session.dump('write-read turn')}`)
    assert.match(text, /hello from the write tool/, `read tool did not return the written content\n${session.dump('write-read turn')}`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end\n${session.dump('write-read turn')}`)
  } finally {
    await session.stop()
    rmSync(join(process.cwd(), fileName), { force: true })
  }
})

test('native dsh web keeps session context across multiple turns via llm-replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-multiturn-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-multiturn.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'First answer.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'First answer.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Second answer.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Second answer.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}\n`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    for (const prompt of ['first turn', 'second turn']) {
      const prompted = await postApi(session.url, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'UTC',
      })
      assert.equal(prompted.res.status, 200, prompted.text)
      await delay(2500)
    }
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}\n${session.dump('multi-turn')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    const turns = [...text.matchAll(/"type":"turn\/end"/g)]
    assert.ok(turns.length >= 2, `expected 2 completed turns, got ${turns.length}\n${session.dump('multi-turn')}`)
    assert.match(text, /First answer\./, `first turn's answer missing\n${session.dump('multi-turn')}`)
    assert.match(text, /Second answer\./, `second turn's answer missing — session context lost\n${session.dump('multi-turn')}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web delegates a subagent via llm-replay (child session + model call)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-subagent-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { primary, replayPatch } = writeReplayFixtures(dir)
  // The child agent's own model call is replayed from a child session fixture.
  const childLog = join(dir, 'child-session.jsonl')
  const childChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'child says hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'child says hi' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  writeFileSync(childLog, [
    JSON.stringify({ type: 'session', version: 0, id: 'child-1', createdAt: Date.now(), cwd: '/tmp', delegationDepth: 1, seedLength: 0 }),
    ...childChunks.map((chunk, i) => JSON.stringify({ type: 'assistant/chunk', seq: i + 1, time: Date.now() + i, data: { turn: 1, step: 1, chunk } })),
    '',
  ].join('\n'))
  const parentScript = join(dir, 'replay-subagent.json')
  writeFileSync(parentScript, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_sub', name: 'subagent', argumentsDelta: JSON.stringify({ description: 'test task', prompt: 'say hi' }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_sub', name: 'subagent', arguments: { description: 'test task', prompt: 'say hi' } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The subagent replied: child says hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'The subagent replied: child says hi' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}\n`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const env = replayEnv(dir, parentScript, { DSH_HOME: bootHome, DSH_SNAPSHOT_CHILD_FILES: childLog })
  const session = await bootNativeWeb(env, ['--port', '0'], { patchFiles: [replayPatch] })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'delegate a task' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(6000)
    const parentLog = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(parentLog.length > 0, `no parent session.jsonl\n${session.dump('subagent')}`)
    const parentText = readFileSync(parentLog[0], 'utf8')
    assert.match(parentText, /"type":"tool\/call"/, `subagent tool call not recorded\n${session.dump('subagent')}`)
    assert.match(parentText, /"type":"tool\/result"/, `subagent result not recorded\n${session.dump('subagent')}`)
    assert.match(parentText, /The subagent replied: child says hi/, `parent final answer missing\n${session.dump('subagent')}`)
    assert.match(parentText, /"turn\/end"/, `parent turn did not end\n${session.dump('subagent')}`)
    // The child ran as its own session with its own replayed model call.
    const childLogs = listSessionJsonl(bootHome).filter((p) => !p.includes(sessionId))
    assert.ok(childLogs.length > 0, `no child session.jsonl created\n${session.dump('subagent')}`)
    const childText = readFileSync(childLogs[0], 'utf8')
    assert.match(childText, /say hi/, `child prompt missing\n${childText}`)
    assert.match(childText, /child says hi/, `child model answer missing\n${childText}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web executes the todo_write tool via llm-replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-todo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-todo.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_todo', name: 'todo_write', argumentsDelta: JSON.stringify({ todos: [{ content: 'native todo task', status: 'pending' }] }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_todo', name: 'todo_write', arguments: { todos: [{ content: 'native todo task', status: 'pending' }] } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Todos updated.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Todos updated.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}
`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'track a task' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(3500)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}
${session.dump('todo')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"tool\/result"/, `todo result not recorded
${session.dump('todo')}`)
    assert.match(text, /1 pending, 0 in progress, 0 completed/, `todo store did not update
${session.dump('todo')}`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end
${session.dump('todo')}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web creates a goal via llm-replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-goal-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-goal.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_g', name: 'create_goal', argumentsDelta: JSON.stringify({ objective: 'write a native goal' }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_g', name: 'create_goal', arguments: { objective: 'write a native goal' } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Goal created.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Goal created.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}
`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'create a goal' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(3500)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}
${session.dump('goal')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"tool\/result"/, `goal result not recorded
${session.dump('goal')}`)
    assert.match(text, /"objective":"write a native goal"/, `created goal objective missing from the result
${session.dump('goal')}`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end
${session.dump('goal')}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web registers an ask_user_question interaction and pauses the turn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-ask-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-ask.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'ask_user_question', argumentsDelta: JSON.stringify({ questions: [{ id: 'q1', question: 'Which color?' }] }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'ask_user_question', arguments: { questions: [{ id: 'q1', question: 'Which color?' }] } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
  ])}
`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'ask the user' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(3000)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl for ${sessionId}
${session.dump('ask')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"tool\/call"/, `ask_user_question call not recorded
${session.dump('ask')}`)
    assert.match(text, /ask_user_question/, `ask tool name missing
${session.dump('ask')}`)
    assert.match(text, /Which color\?/, `question text missing
${session.dump('ask')}`)
    // Unanswered questions leave the turn pending: no result, no turn/end yet.
    assert.doesNotMatch(text, /"type":"tool\/result"/, `ask should not have a result while unanswered
${session.dump('ask')}`)
    assert.doesNotMatch(text, /"type":"turn\/end"/, `ask turn should stay pending
${session.dump('ask')}`)
  } finally {
    await session.stop()
  }
})

/** Minimal ZIP reader: locate the central directory, inflate the named entry. */
function zipEntryText(zipBytes, entryName) {
  const buf = Buffer.from(zipBytes)
  // End of central directory: scan backwards for the 0x06054b50 signature.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  assert.ok(eocd !== -1, 'no EOCD in zip')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    const off = cdOffset + i * 46
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'bad central directory signature')
    const method = buf.readUInt16LE(off + 10)
    const compressedSize = buf.readUInt32LE(off + 20)
    const uncompressedSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    if (name !== entryName) continue
    // Local file header: 30-byte fixed part + name/extra.
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'bad local header signature')
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataStart, dataStart + compressedSize)
    const raw = method === 0 ? data : inflateRawSync(data)
    assert.equal(raw.length, uncompressedSize, `zip entry ${entryName} size mismatch`)
    return raw.toString('utf8')
  }
  assert.fail(`zip entry not found: ${entryName}`)
}

test('native dsh session.export returns a zip containing the session jsonl', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-export-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(nativeEnv({ DSH_HOME: bootHome }), ['--port', '0'], {})
  try {
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const exportUrl = new URL('/api/session.export', session.url)
    exportUrl.searchParams.set('sessionId', sessionId)
    exportUrl.searchParams.set('includeDescendants', 'true')
    const res = await fetch(exportUrl, { signal: AbortSignal.timeout(10000) })
    assert.equal(res.status, 200, `session.export HTTP ${res.status}
${session.dump('export')}`)
    const body = new Uint8Array(await res.arrayBuffer())
    assert.equal(body[0], 0x50, `not a zip: ${Buffer.from(body).subarray(0, 20).toString('hex')}`)
    assert.equal(body[1], 0x4b)
    const jsonl = zipEntryText(body, 'session.jsonl')
    assert.match(jsonl, /"type":"session"/, `exported jsonl lost its header:
${jsonl.slice(0, 200)}`)
    assert.match(jsonl, new RegExp(sessionId.replace(/[-]/g, '\\-')), `exported jsonl missing session ${sessionId}
${jsonl.slice(0, 300)}`)
  } finally {
    await session.stop()
  }
})

test('native dsh headless completes a task with a bash tool call via llm-replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-headless-tool-'))
  try {
    const { primary, replayPatch } = writeReplayFixtures(dir)
    const toolScript = join(dir, 'replay-headless-tool.json')
    writeFileSync(toolScript, `${JSON.stringify([
      { kind: 'chunks', chunks: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bash', argumentsDelta: '{"command":"echo hello-from-native","description":"test"}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: { command: 'echo hello-from-native', description: 'test' } } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] },
      { kind: 'chunks', chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'The command ran and printed hello-from-native' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'The command ran and printed hello-from-native' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ] },
    ])}
`)
    const r = spawnSync(bin, ['--profile', 'headless', '--patch', replayPatch, 'run a command'], {
      env: replayEnv(dir, toolScript, { DSH_HOME: dir }),
      encoding: 'utf8',
      timeout: 120000,
    })
    assert.equal(r.signal, null, `${r.signal}
${r.stdout}
${r.stderr}`)
    assert.equal(r.status, 0, `headless tool run failed (${r.status})
stdout:
${r.stdout}
stderr:
${r.stderr}`)
    assert.match(r.stdout, /The command ran and printed hello-from-native/, `final answer missing:
${r.stdout}`)
    assert.doesNotMatch(r.stderr, /plugin tree failed to load/, r.stderr)
    // The bash tool really ran: its output landed in the headless session log.
    const log = listSessionJsonl(dir)[0]
    assert.ok(log !== undefined, `no headless session.jsonl under ${dir}`)
    const text = readFileSync(log, 'utf8')
    assert.match(text, /hello-from-native\\n/, `bash output missing from headless session
${text.slice(0, 400)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native dsh web runs two sessions concurrently via llm-replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-concurrent-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { primary, replayPatch } = writeReplayFixtures(dir)
  const scriptA = join(dir, 'replay-a.json')
  writeFileSync(scriptA, `${JSON.stringify([{ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'answer from session A' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'answer from session A' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }])}
`)
  // Child fixtures are session logs (the replay derives their script from
  // assistant/chunk events), unlike the primary's override array.
  const scriptB = join(dir, 'replay-b.jsonl')
  const bChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'answer from session B' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'answer from session B' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  writeFileSync(scriptB, [
    JSON.stringify({ type: 'session', version: 0, id: 'session-b', createdAt: Date.now(), cwd: '/tmp', delegationDepth: 0, seedLength: 0 }),
    ...bChunks.map((chunk, i) => JSON.stringify({ type: 'assistant/chunk', seq: i + 1, time: Date.now() + i, data: { turn: 1, step: 1, chunk } })),
    '',
  ].join('\n'))
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, scriptA, { DSH_HOME: bootHome, DSH_SNAPSHOT_CHILD_FILES: scriptB }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const createA = await postApi(session.url, 'session.create')
    const idA = assertRpcOk('session.create', createA, session.dump).result.value.sessionId
    const createB = await postApi(session.url, 'session.create')
    const idB = assertRpcOk('session.create', createB, session.dump).result.value.sessionId
    // Prompt both sessions in parallel; the worker engines must interleave.
    const [ra, rb] = await Promise.all([
      postApi(session.url, 'session.prompt', { sessionId: idA, mode: 'queue', content: [{ type: 'text', text: 'prompt A' }], clientTimeZone: 'UTC' }),
      postApi(session.url, 'session.prompt', { sessionId: idB, mode: 'queue', content: [{ type: 'text', text: 'prompt B' }], clientTimeZone: 'UTC' }),
    ])
    assert.equal(ra.res.status, 200, ra.text)
    assert.equal(rb.res.status, 200, rb.text)
    await delay(4000)
    const logA = listSessionJsonl(bootHome).filter((p) => p.includes(idA))[0]
    const logB = listSessionJsonl(bootHome).filter((p) => p.includes(idB))[0]
    assert.ok(logA !== undefined, `session A jsonl missing
${session.dump('concurrent')}`)
    assert.ok(logB !== undefined, `session B jsonl missing
${session.dump('concurrent')}`)
    const textA = readFileSync(logA, 'utf8')
    const textB = readFileSync(logB, 'utf8')
    assert.match(textA, /answer from session A/, `session A answer missing
${textA.slice(0, 400)}`)
    assert.match(textA, /"type":"turn\/end"/, `session A turn did not end
${textA.slice(0, 400)}`)
    assert.match(textB, /answer from session B/, `session B answer missing
${textB.slice(0, 400)}`)
    assert.match(textB, /"type":"turn\/end"/, `session B turn did not end
${textB.slice(0, 400)}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web edits a file via llm-replay (read→edit→read)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-edit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fileName = `native-edt-${process.pid}-${Date.now()}.txt`
  writeFileSync(join(process.cwd(), fileName), 'hello world\n')
  t.after(() => rmSync(join(process.cwd(), fileName), { force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const args = (id, name, payload) => ({ id, name, payload })
  const script = join(dir, 'replay-edit.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, ...args('r1', 'read', { file_path: fileName }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'r1', name: 'read', arguments: { file_path: fileName } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, ...args('e1', 'edit', { file_path: fileName, old_string: 'world', new_string: 'native' }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'e1', name: 'edit', arguments: { file_path: fileName, old_string: 'world', new_string: 'native' } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, ...args('r2', 'read', { file_path: fileName }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'r2', name: 'read', arguments: { file_path: fileName } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The file now contains hello native' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'The file now contains hello native' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}
`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'edit the file' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(5000)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl
${session.dump('edit')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    const results = [...text.matchAll(/"type":"tool\/result"/g)]
    assert.ok(results.length >= 3, `expected read/edit/read results, got ${results.length}
${session.dump('edit')}`)
    assert.doesNotMatch(text, /isError":true/, `a tool errored in the edit chain
${session.dump('edit')}`)
    // The file on disk really changed and stayed readable (mode preserved).
    assert.equal(readFileSync(join(process.cwd(), fileName), 'utf8'), 'hello native\n', `file not edited on disk`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end
${session.dump('edit')}`)
  } finally {
    await session.stop()
  }
})

test('native dsh web contains a model error via llm-replay (process survives)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-error-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-throw.json')
  writeFileSync(script, `${JSON.stringify([{ kind: 'throw', chunks: [], message: 'simulated model failure', code: 'E_SIMULATED' }])}\n`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    assert.equal(session.child.exitCode, null, session.dump('listen'))
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'say hi' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(3000)
    // The failed model call must not kill the process; the turn ends with the
    // recorded error and the session stays usable.
    assert.equal(session.child.exitCode, null, `process died on a model error\n${session.dump('error')}`)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl\n${session.dump('error')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"kind":"error"/, `turn did not end in error\n${text.slice(0, 400)}`)
    assert.match(text, /simulated model failure/, `error message not recorded\n${text.slice(0, 400)}`)
    assert.match(text, /E_SIMULATED/, `error code not recorded\n${text.slice(0, 400)}`)
    // The session still answers a follow-up request.
    const again = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'are you alive?' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(again.res.status, 200, again.text)
  } finally {
    await session.stop()
  }
})

test('native dsh web searches file contents via the grep tool (llm-replay)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-replay-grep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fileName = `native-grep-${process.pid}-${Date.now()}.txt`
  writeFileSync(join(process.cwd(), fileName), 'alpha line\nneedle-to-find here\nomega line\n')
  t.after(() => rmSync(join(process.cwd(), fileName), { force: true }))
  const { replayPatch } = writeReplayFixtures(dir)
  const script = join(dir, 'replay-grep.json')
  writeFileSync(script, `${JSON.stringify([
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'g1', name: 'grep', argumentsDelta: JSON.stringify({ pattern: 'needle-to-find', path: fileName }) },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'g1', name: 'grep', arguments: { pattern: 'needle-to-find', path: fileName } } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Found the needle.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Found the needle.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])}
`)
  const bootHome = join(dir, 'home')
  mkdirSync(bootHome, { recursive: true })
  const session = await bootNativeWeb(replayEnv(dir, script, { DSH_HOME: bootHome }), ['--port', '0'], {
    patchFiles: [replayPatch],
  })
  try {
    const created = await postApi(session.url, 'session.create')
    const sessionId = assertRpcOk('session.create', created, session.dump).result.value.sessionId
    const prompted = await postApi(session.url, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'find the needle' }],
      clientTimeZone: 'UTC',
    })
    assert.equal(prompted.res.status, 200, prompted.text)
    await delay(4000)
    const jsonl = listSessionJsonl(bootHome).filter((p) => p.includes(sessionId))
    assert.ok(jsonl.length > 0, `no session.jsonl\n${session.dump('grep')}`)
    const text = readFileSync(jsonl[0], 'utf8')
    assert.match(text, /"type":"tool\/result"/, `grep result not recorded\n${session.dump('grep')}`)
    assert.doesNotMatch(text, /isError":true/, `grep errored\n${session.dump('grep')}`)
    assert.match(text, /needle-to-find here/, `grep result missing the matched line\n${session.dump('grep')}`)
    assert.match(text, /"type":"turn\/end"/, `turn did not end\n${session.dump('grep')}`)
  } finally {
    await session.stop()
  }
})

function countOccurrences(bytes, needle) {
  const buf = Buffer.from(needle, 'utf8')
  let count = 0
  let from = 0
  while (true) {
    const at = bytes.indexOf(buf, from)
    if (at === -1) break
    count++
    from = at + buf.length
  }
  return count
}

function probe(family) {
  assert.ok(existsSync(bin), `native binary missing: ${bin}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-probe-'))
  try {
    const patch = writeInsertPatch(dir, ['@deepseek-ai/dsh-native-probe'])
    const result = spawnSync(bin, ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
      env: nativeEnv({ DSH_HOME: dir, DSH_NATIVE_PROBE: family }),
      encoding: 'utf8',
      timeout: 60000,
    })
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('native sqlite persist-or-query works (storage-sqlite / node:sqlite)', () => {
  const r = probe('sqlite')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /"ok":true/)
  assert.doesNotMatch(r.stdout + r.stderr, /sqlite trap|not supported|no SQLite/)
})

test('native spawn and execFile work', () => {
  for (const family of ['spawn', 'execFile', 'fs-search']) {
    const r = probe(family)
    assert.equal(r.status, 0, `${family}: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /"ok":true/)
    assert.doesNotMatch(r.stdout + r.stderr, /is not available in the scriptc island/)
  }
})

test('native PTY spawn works', () => {
  const r = probe('pty')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /"ok":true/)
  assert.doesNotMatch(r.stdout + r.stderr, /node-pty is not available/)
})

test('native sharp and landlock work', () => {
  const sharp = probe('sharp')
  assert.equal(sharp.status, 0, sharp.stdout + sharp.stderr)
  assert.match(sharp.stdout, /"ok":true/)
  assert.doesNotMatch(sharp.stdout + sharp.stderr, /sharp is not available/)
  const landlock = probe('landlock')
  assert.equal(landlock.status, 0, landlock.stdout + landlock.stderr)
  assert.match(landlock.stdout, /"ok":true/)
})

test('native Worker, watch/HMR, cordis runners, and directory-picker work', () => {
  const worker = probe('worker')
  assert.equal(worker.status, 0, worker.stdout + worker.stderr)
  assert.match(worker.stdout, /"ok":true/)
  assert.match(worker.stdout, /"code":7/)
  assert.match(worker.stdout, /"workflow":1/)
  for (const family of ['watch', 'host-runner', 'client-runner', 'directory-picker']) {
    const r = probe(family)
    assert.equal(r.status, 0, `${family}: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /"ok":true/)
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
