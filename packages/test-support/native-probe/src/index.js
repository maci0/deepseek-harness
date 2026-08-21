/**
 * Island plugin: when DSH_NATIVE_PROBE is set, exercise a degraded family and exit.
 */
import { writeFileSync, rmSync, watch, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile, spawnSync } from 'node:child_process'

export const name = '@deepseek-ai/dsh-native-probe'

function ok(family, extra) {
  const payload = { ok: true, family }
  if (extra) {
    const keys = Object.keys(extra)
    for (let i = 0; i < keys.length; i++) payload[keys[i]] = extra[keys[i]]
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function fail(family, error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`${JSON.stringify({ ok: false, family, error: message })}\n`)
  process.exit(1)
}

async function probeSqlite() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-sqlite-'))
  const dbPath = join(dir, 't.sqlite')
  try {
    const sqlite = await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath)
    db.exec('CREATE TABLE IF NOT EXISTS probe (v TEXT) STRICT')
    db.prepare('INSERT INTO probe (v) VALUES (?)').run('hello')
    const row = db.prepare('SELECT v FROM probe LIMIT 1').get()
    db.close()
    if (!row || row.v !== 'hello') throw new Error(`unexpected row ${JSON.stringify(row)}`)
    const again = new sqlite.DatabaseSync(dbPath)
    const row2 = again.prepare('SELECT v FROM probe LIMIT 1').get()
    again.close()
    if (!row2 || row2.v !== 'hello') throw new Error('sqlite reopen failed')
    ok('sqlite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function probeSpawn() {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/echo', ['probe-spawn'])
    let out = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.on('error', reject)
    child.on('exit', (status) => {
      if (status !== 0) reject(new Error(`echo exit ${String(status)}`))
      else if (!out.includes('probe-spawn')) reject(new Error(`stdout ${out}`))
      else {
        ok('spawn', { out: out.trim() })
        resolve()
      }
    })
  })
}

function probeExecFile() {
  return new Promise((resolve, reject) => {
    execFile('/bin/echo', ['probe-exec'], (error, stdout) => {
      if (error !== null) reject(error)
      else if (!String(stdout).includes('probe-exec')) reject(new Error(String(stdout)))
      else {
        ok('execFile', { out: String(stdout).trim() })
        resolve()
      }
    })
  })
}

async function probePty() {
  const pty = await import('node-pty')
  await new Promise((resolve, reject) => {
    const term = pty.spawn('/bin/echo', ['probe-pty'], { name: 'dumb', cols: 80, rows: 24 })
    let data = ''
    term.onData((chunk) => { data += chunk })
    term.onExit((ev) => {
      if (ev.exitCode !== 0 && data === '') reject(new Error(`pty exit ${String(ev.exitCode)}`))
      else {
        ok('pty', { data: data.trim(), pid: term.pid })
        resolve()
      }
    })
  })
}

async function probeSharp() {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  const { validateImageFile } = await import('@deepseek-ai/dsh-attachment-local')
  await validateImageFile(
    { data: new Uint8Array(png), mediaType: 'image/png' },
    {
      maxImageBytes: 1000000,
      maxImagePixels: 1000000,
      maxImageDimension: 8192,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4000000,
      mediaTypes: ['image/png'],
    },
    { maxDimension: 2048, maxBytes: 4000000 },
  )
  ok('sharp')
}

async function probeLandlock() {
  const landlock = await import('@deepseek-ai/node-addon-landlock-run')
  const launcher = landlock.launcherPath()
  if (!existsSync(launcher)) throw new Error(`landlock-run missing at ${launcher}`)
  const verdict = landlock.probe(launcher)
  if (verdict === 'unusable') throw new Error(`landlock probe unusable at ${launcher}`)
  ok('landlock', { launcher, verdict })
}

function service(ctx, key) {
  const root = ctx.root !== undefined ? ctx.root : ctx
  const registry = root.registry
  if (registry !== undefined && typeof registry.values === 'function') {
    for (const runtime of registry.values()) {
      const fibers = runtime.fibers
      if (fibers === undefined) continue
      for (const fiber of fibers) {
        const impl = fiber.store !== undefined ? fiber.store[key] : undefined
        if (impl !== undefined && impl.value !== undefined) return impl.value
      }
    }
  }
  const local = ctx.get(key)
  if (local !== undefined) return local
  return undefined
}

async function probeWorker(ctx) {
  if (ctx === undefined) throw new Error('worker probe needs a cordis ctx')
  let runtime = service(ctx, 'codeRuntime')
  if (runtime === undefined) {
    const codeMod = await import('@deepseek-ai/dsh-code-runtime-worker-thread')
    try {
      await ctx.plugin(codeMod.default, {})
    } catch (error) {
      runtime = service(ctx, 'codeRuntime')
      if (runtime === undefined) throw error
    }
    if (runtime === undefined) runtime = service(ctx, 'codeRuntime')
  }
  if (runtime === undefined || typeof runtime.run !== 'function') {
    throw new Error('codeRuntime is not mounted')
  }
  const codeResult = await runtime.run({ program: 'return 7', bindings: [] })
  if (codeResult.error !== undefined) {
    throw new Error(`codeRuntime ${codeResult.error.kind}: ${codeResult.error.message}`)
  }
  if (codeResult.value !== 7) throw new Error(`codeRuntime value ${JSON.stringify(codeResult.value)}`)
  let engine = service(ctx, 'workflowEngine')
  if (engine === undefined) {
    const wfMod = await import('@deepseek-ai/dsh-workflow-worker-thread')
    try {
      await ctx.plugin(wfMod.default, { provider: 'spawn', maxConcurrentAgents: 1 })
    } catch (error) {
      engine = service(ctx, 'workflowEngine')
      if (engine === undefined) throw error
    }
    if (engine === undefined) engine = service(ctx, 'workflowEngine')
  }
  if (engine === undefined || typeof engine.start !== 'function') {
    throw new Error('workflowEngine is not mounted')
  }
  const handle = engine.start({
    script: 'return 1',
    meta: { name: 'native-probe', description: 'worker-thread engine probe' },
    parent: { id: 'native-probe-parent', options: {} },
  })
  try {
    const settled = await handle.result
    if (settled.stopReason !== 'completed') {
      throw new Error(`workflow stopReason ${String(settled.stopReason)} ${JSON.stringify(settled.error)}`)
    }
    if (settled.value !== 1) throw new Error(`workflow value ${JSON.stringify(settled.value)}`)
    ok('worker', { code: 7, workflow: 1 })
  } finally {
    await handle.dispose()
  }
}

function probeWatch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-watch-'))
  const file = join(dir, 'x.txt')
  writeFileSync(file, 'a')
  return new Promise((resolve, reject) => {
    const watcher = watch(dir)
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      watcher.close()
      rmSync(dir, { recursive: true, force: true })
      if (error) reject(error)
      else {
        ok('watch')
        resolve()
      }
    }
    const timer = setTimeout(() => finish(new Error('watch timeout')), 4000)
    watcher.on('change', () => finish())
    watcher.on('error', (err) => finish(err))
    writeFileSync(file, 'b')
    setTimeout(() => { if (!finished) writeFileSync(join(dir, 'y.txt'), 'c') }, 100)
    setTimeout(() => { if (!finished) writeFileSync(file, 'd') }, 250)
  })
}

async function probeHostRunner() {
  const hr = await import('@deepseek-ai/dsh-cordis-host-runner')
  if (hr.HOST_BUILTIN_INSPECTION === undefined) throw new Error('host-runner missing HOST_BUILTIN_INSPECTION')
  const AsyncFunction = (async function asyncFunctionProbe() { /* ctor */ }).constructor
  const fn = new AsyncFunction('return { apply() { return 1 } }')
  const returned = await fn()
  if (typeof returned.apply !== 'function') throw new Error('host Function eval failed')
  ok('host-runner')
}

async function probeClientRunner() {
  const mod = await import('@deepseek-ai/dsh-cordis-client-runner')
  if (typeof mod.apply !== 'function') throw new Error('client-runner has no apply')
  mod.apply()
  const locale = await import('@deepseek-ai/dsh-client-locale')
  if (typeof locale.apply !== 'function') throw new Error('embedded client package has no apply')
  ok('client-runner')
}

async function probeDirectoryPicker() {
  const { pickNativeDirectory } = await import('@deepseek-ai/dsh-host-directory-picker-native')
  const picked = await pickNativeDirectory(new AbortController().signal, {
    platform: 'linux',
    run: async (command, args) => {
      if (command === 'zenity' || command === 'kdialog') {
        const r = spawnSync('/bin/echo', ['/tmp'], { encoding: 'utf8' })
        return { stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
      }
      const r = spawnSync(command, [...args], { encoding: 'utf8' })
      if (r.error) throw r.error
      return { stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
    },
  })
  if (picked !== '/tmp') throw new Error(`picker returned ${String(picked)}`)
  ok('directory-picker', { picked })
}

async function probeFsSearchSpawn() {
  const child = spawn('/bin/echo', ['rg-ok'])
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (status) => {
      if (status === 0) resolve()
      else reject(new Error(`echo exit ${String(status)}`))
    })
  })
  ok('fs-search')
}

const families = {
  sqlite: probeSqlite,
  spawn: probeSpawn,
  execFile: probeExecFile,
  pty: probePty,
  sharp: probeSharp,
  landlock: probeLandlock,
  worker: probeWorker,
  watch: probeWatch,
  'host-runner': probeHostRunner,
  'client-runner': probeClientRunner,
  'directory-picker': probeDirectoryPicker,
  'fs-search': probeFsSearchSpawn,
}

async function runFamily(family, ctx) {
  if (family === 'all') {
    const names = Object.keys(families)
    for (let i = 0; i < names.length; i++) {
      const run = families[names[i]]
      await run(ctx).catch((error) => fail(names[i], error))
    }
    ok('all')
    return
  }
  const run = families[family]
  if (run === undefined) fail(family, new Error(`unknown family ${family}`))
  await run(ctx).catch((error) => fail(family, error))
}

export async function apply(ctx) {
  const family = process.env.DSH_NATIVE_PROBE
  if (family === undefined || family === '') return
  try {
    await runFamily(family, ctx)
    process.exit(0)
  } catch (error) {
    fail(family, error)
  }
}
