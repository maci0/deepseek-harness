/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Absolute path of this dsh installation's package.json.
 * scriptc SC2020: `import.meta.url` has no lowering. Prefer `$DSH_INSTALL`,
 * then `package.json` next to the executable (the dist layout), then the
 * workspace clone used when running `notes/dsh` from this tree.
 */
export const INSTALL_ANCHOR: string = (() => {
  const fromEnv = process.env.DSH_INSTALL
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const starts: string[] = []
  if (process.argv.length > 1 && process.argv[1] !== undefined && process.argv[1] !== '') {
    let slot = process.argv[1]
    try { slot = realpathSync(slot) } catch { /* keep unresolved */ }
    starts.push(dirname(slot))
  }
  starts.push(process.cwd())
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        try {
          if (readFileSync(candidate, 'utf8').includes('@deepseek-ai/dsh')) return candidate
        } catch { /* keep walking */ }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  let bin = process.argv.length > 1 && process.argv[1] !== undefined ? process.argv[1] : '.'
  try { bin = realpathSync(bin) } catch { /* keep */ }
  return join(dirname(bin), 'package.json')
})()

/** Shipped agent-preset root: beside this app's own config. */
const SHIPPED_PRESET_ROOT = join(dirname(INSTALL_ANCHOR), 'config', 'agent-presets')

/**
 * Native default 3080 collides with a running Node dsh. On the island web
 * profile, an unspecified --port becomes 0 so the OS picks a free port.
 * Headless has no --port flag; leave its argv alone.
 */
function nativeWebListenArgs(profile: string, args: readonly string[]): readonly string[] {
  if (process.argv[0] !== 'scriptc') return args
  if (profile !== 'web') return args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port' || (typeof arg === 'string' && arg.startsWith('--port='))) return args
  }
  return args.concat(['--port', '0'])
}

/**
 * The native binary's process.argv[0] is "scriptc". An existing ~/.dsh from
 * Node may mix uncompressed .jsonl and .jsonl.zstd session logs; either
 * compression mode then refuses to boot. Default to ~/.dsh-native unless
 * the user set DSH_HOME.
 */
function pinNativeHome(): void {
  if ((process.env.DSH_HOME ?? '').trim() !== '') return
  const a0 = process.argv[0]
  if (a0 !== 'scriptc' && a0 !== 'dsh' && !(typeof a0 === 'string' && a0.endsWith('/dsh'))) return
  process.env.DSH_HOME = join(homedir(), '.dsh-native')
}

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProfileShutdown, installNodeComplete, type ProcessShutdown } from './process-shutdown-core.ts'

export { installNodeComplete }

const NAME = 'dsh'

/** FiberState.ACTIVE — cordis is an island package, so the const enum is inlined. */
const FIBER_ACTIVE = 2

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  pinNativeHome()
  const home = resolveDshHome()
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, home, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
  /** ids present in the composed tree (bundles + user layers + overlays). */
  rowIds: Record<string, boolean>
  /** Config of the `agent-presets` row, if that row is in the tree. */
  agentPresetsConfig: Record<string, unknown> | undefined
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  // scriptc SC1090: array spread arguments do not compile; concat does.
  return composed.bundlePatches.concat(
    composed.profile.patches,
    composed.homePatches,
    composed.overlays,
  )
}

/** JSON-shaped clone of island patch rows. structuredClone cannot clone them. */
type PatchJson = string | number | boolean | PatchJson[] | { [key: string]: PatchJson }

function clonePatchList(patches: PatchOptions[]): PatchOptions[] {
  const text = JSON.stringify(patches)
  const cloned = JSON.parse(text) as PatchJson[]
  return cloned as unknown as PatchOptions[]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
): ComposedProfile {
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  // scriptc island Array.flatMap over yaml-loaded overlay lists can nest the
  // patch rows, so Include never sees `insert`. Concat matches dump-config.
  let overlays: PatchOptions[] = []
  for (const file of patchFiles) {
    overlays = overlays.concat(loadOverlayPatches(NAME, resolve(file)))
  }
  let bundlePatches: PatchOptions[] = []
  for (const layer of profile.layers) {
    bundlePatches = bundlePatches.concat(layer.patches)
  }
  // scriptc SC1090: Map values may not be function-bearing records, and
  // `typeof` on a statically-typed field is fenced. Index ids as booleans.
  const rowIds: Record<string, boolean> = {}
  let agentPresetsConfig: Record<string, unknown> | undefined
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    const id = row.id
    if (id === '') continue
    rowIds[id] = true
    if (id === 'agent-presets' && row.config !== undefined && row.config !== null && typeof row.config === 'object') {
      agentPresetsConfig = row.config as Record<string, unknown>
    }
  }
  const composedOverlays = overlays.concat()
  // The SHIPPED root is the part of the roster only this app can resolve: it
  // sits beside this app's own config, in both the source and built layouts.
  // The writable root the roster appends is `dsh-agent-presets`' own, so a
  // launcher that never reaches this patch still finds a person's presets.
  if (rowIds['agent-presets'] === true) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(
    process.env.DSH_TELEMETRY_DISABLED,
    rowIds[TELEMETRY_ROW_ID] === true,
  )
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rowIds, agentPresetsConfig }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FIBER_ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  pinNativeHome()
  const composed = composeProfile(options.profile, options.patchFiles)
  const app: { current?: Context } = {}
  const shutdown = createProfileShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  // scriptc SC2020: passing the `process` object into island code has no
  // lowering. The island default is the process shim; skip the local release.
  installFailLoud(NAME)

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH
  // user files are re-read per generation (the HMR watcher hands us only the
  // changed file's patches, which one of the reads duplicates — fresh reads
  // keep the two watchers from stitching in each other's stale copy).
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree BY REFERENCE and later id-targeted patches mutate those
  // objects in place. Reusing one parsed patch object across applications
  // would bake a user override into the bundle's in-memory insert row, so
  // removing the override could never revert the row to the bundle default.
  const composeLive = (): PatchOptions[] => clonePatchList(
    composed.bundlePatches.concat(
      loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
      loadOptionalPatches(NAME, homePatchPath()) ?? [],
      composed.overlays,
    ),
  )
  // Cloned for the same insert-aliasing reason as composeLive: the boot
  // application must not mutate the objects later reloads recompose from.
  let ctx: Context
  try {
    ctx = await boot(NAME, rootConfig, clonePatchList(allPatches(composed)), (hostCtx) => {
      app.current = hostCtx
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: nativeWebListenArgs(options.profile, options.args),
        exit: code => void shutdown.shutdown(code),
      })
    })
  } catch (error) {
    process.stderr.write(`dsh: boot failed: ${String(error)}\n`)
    process.exit(1)
  }
  app.current = ctx
  const nativeIsland = process.argv[0] === 'scriptc'
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  if (!nativeIsland
    && !signalShutdown.signal.aborted
    && ctx.fiber.state === FIBER_ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        compose: composeLive,
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  // scriptc island.import of a module with top-level await treats the
  // fulfilled module namespace as an uncaught [object] once the entry
  // promise settles. Long-lived web stays on this promise until a signal
  // or cmdline exit calls process.exit.
  if (ctx.get('webServer') !== undefined) {
    await new Promise<void>(() => {})
  }
  return { ctx, shutdown }
}
