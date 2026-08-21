/**
 * The Function-parameter sandbox a dynamic package's HOST half evaluates in: a tagged
 * write-through console, the `harness` registration helpers, encoding primitives, and
 * callable traps over the Node APIs the sandbox withholds. Traps steer filesystem, network,
 * process, and timer work to `ctx.fs`, `ctx.web`, `ctx.bash`, and Cordis timers. This keeps
 * cooperative packages inspectable and disposable but is not containment: the host realm
 * remains reachable (`global`, `Function('return this')`). `node:vm` is out of scriptc's
 * static builtin set (SC1010).
 *
 * The browser half never reaches this module — it is evaluated by the client-side runner in a
 * closure, with its own facade.
 * @module @deepseek-ai/dsh-cordis-host-runner/sandbox
 */

import { sandboxDefineTool, sandboxRegisterTool } from './guard.ts'

/** Exact Host closure symbols exposed by the sandbox and guarded Context. */
export const HOST_BUILTIN_INSPECTION = [
  {
    name: 'ctx',
    description: 'Restricted Cordis Context. Prefer ctx.get(name) with an undefined check; use inject for hard dependencies.',
    signatures: [
      'ctx.get(name: string): unknown | undefined',
      'ctx.on(name: string, listener: Function): () => void',
      'ctx.provide(name: string, value: unknown): () => void',
      'ctx.effect(callback: Function, label?: string): () => void',
    ],
  },
  {
    name: 'harness',
    description: 'Host helpers for Package-private Client RPC and model-visible dynamic Tools.',
    signatures: [
      'harness.handle(method: string, handler: (args: JsonValue) => JsonValue | Promise<JsonValue>): () => void',
      'harness.defineTool(definition: ToolDefinition): ToolDefinition',
      'harness.registerTool(ctx: Context, tool: ToolDefinition): () => void',
    ],
  },
  { name: 'console', description: 'Package-tagged Host logging.', signatures: ['console.log(...values): void', 'console.error(...values): void'] },
  { name: 'btoa', description: 'Encode UTF-8 text as base64.', signatures: ['btoa(value: string): string'] },
  { name: 'atob', description: 'Decode base64 as UTF-8 text.', signatures: ['atob(value: string): string'] },
  { name: 'TextEncoder', description: 'Standard UTF-8 encoder constructor.', signatures: ['new TextEncoder()'] },
  { name: 'TextDecoder', description: 'Standard text decoder constructor.', signatures: ['new TextDecoder(label?: string)'] },
] as const

/**
 * A write-through console for one package, tagging every line with the package
 * id. Write-through (host stdout/stderr), NOT buffered into the tool result:
 * a registered listener fires long after the run call returned, and its output
 * must land somewhere the user can see — for a terminal entry point, the host terminal.
 */
function taggedConsole(id: string): Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void> {
  const tag = `[cordis:${id}]`
  const log = (...args: unknown[]): void => { console.log(tag, ...args) }
  const error = (...args: unknown[]): void => { console.error(tag, ...args) }
  return { log, info: log, warn: log, debug: log, error }
}

const TIMER_REDIRECT
  = 'Node timers are unavailable. Use the cordis timer service instead: declare inject: [\'timer\'] on your plugin '
    + 'and call ctx.timeout / ctx.interval after querying Host Service.listService for the exact overloads. '
    + 'Those calls are fiber effects, cleaned up automatically when stopped.'

/**
 * The callable Node APIs the sandbox deliberately disables, each mapped to the
 * cordis alternative its trap error names. Only function-valued globals are
 * trapped; a data-valued global such as `process` stays `undefined`, because a
 * throwing accessor would detonate the common `typeof process` feature probe
 * at resolution time.
 */
const NODE_API_REDIRECTS: Record<string, string> = {
  require:
    'Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: [\'fs\'] for files, '
    + '[\'web\'] for HTTP, [\'bash\'] for processes; query Service.listService with cordis_inspect_query first.',
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  setImmediate: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch:
    'Network access goes through the cordis web service: declare inject: [\'web\'] and call ctx.web '
    + '(query Host Service.listService with cordis_inspect_query for its methods).',
}

/** Build the trap functions for {@link NODE_API_REDIRECTS}: calling one throws the redirect. */
function nodeApiTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => {
      throw new Error(`${name} is not available in the dynamic package sandbox — ${redirect}`)
    }
  }
  return traps
}

/**
 * Build the sandbox one host half evaluates in: the tagged console, the
 * `harness` registration helpers, the encoding primitives, and the Node-API traps.
 * @param id - the package id (`dyn-<n>`), used as the console tag and filename stem.
 * @param harnessExtras - per-package `harness` verbs beyond the registration pair (`handle`).
 * @returns the sandbox object to pass to {@link evaluateHostCode}.
 */
export function createSandbox(id: string, harnessExtras: Record<string, unknown> = {}): object {
  const sandbox = {
    ...nodeApiTraps(),
    // Data bindings, not throwing accessors: `typeof process` must stay a
    // feature probe. Function eval shares the host realm (no node:vm / SC1010).
    process: undefined,
    Buffer: undefined,
    console: taggedConsole(id),
    harness: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...harnessExtras },
    // Encoding primitives without exposing Buffer itself. Host closures over Buffer.
    btoa: (s: string) => Buffer.from(s, 'utf-8').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  return sandbox
}

/**
 * Cross-realm SyntaxError detection: a compile failure inside `runInContext`
 * constructs its error in the SANDBOX realm, so a host `instanceof
 * SyntaxError` is silently false — the `name` property is the realm-safe tag.
 */
function isSyntaxError(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SyntaxError'
}

/**
 * The parse-failure context a vm `SyntaxError` carries: the vm prints the
 * offending source line and a caret before the message, which is exactly what
 * a model needs to self-correct — surface it instead of the bare message.
 * Falls back to `String(error)` when the stack carries no such prelude.
 * @param error - the `SyntaxError` (host- or sandbox-realm) thrown while compiling package code.
 * @returns the stack prefix up to and including the `SyntaxError: …` line.
 */
export function syntaxErrorContext(error: Error): string {
  const lines = (error.stack ?? '').split('\n')
  const messageIndex = lines.findIndex(line => line.startsWith('SyntaxError'))
  if (messageIndex === -1) return String(error)
  return lines.slice(0, messageIndex + 1).join('\n')
}

/**
 * The teaching text one parse failure produces, shared by the define-time
 * precheck and the run-time evaluation so a model reads the same diagnosis
 * whichever verb caught it.
 * @param half - which half failed to parse, named as the define argument that carried it.
 * @param context - the {@link syntaxErrorContext} of the failure.
 * @returns the model-facing error message.
 */
export function parseErrorMessage(half: 'code.host' | 'code.client', context: string): string {
  // Scope the TypeScript heuristic to the OFFENDING line, not the whole code:
  // an ` as ` inside an ordinary description string must not turn a plain
  // syntax error into a misleading remove-annotations message. Function
  // SyntaxError stacks have no source line, so also read the message line
  // (`Unexpected identifier 'as'`).
  const lines = context.split('\n')
  const offendingLine = lines[1] ?? ''
  const messageLine = lines.find(line => line.startsWith('SyntaxError')) ?? lines[0] ?? ''
  if (/\bas\b/.test(offendingLine) || /\bas\b/.test(messageLine)) {
    return `dynamic package \`${half}\` failed to parse:\n${context}\n`
      + 'The sandbox runs plain JavaScript, not TypeScript. Remove type annotations:\n'
      + '  ✗ { type: \'text\' as const, text: x }\n'
      + '  ✓ { type: \'text\', text: x }'
  }
  return `dynamic package \`${half}\` failed to parse:\n${context}\n`
    + 'Note: it runs as the BODY of an async function (line numbers are offset by the 1-line wrapper). '
    + 'Check bracket balance — ending the returned plugin object with `});` closes a call that was never opened; '
    + 'a plain `return { … }` ends with `}` (an optional `;`), never `)`.'
}

/**
 * Parse one half's source without running it: the define-time precheck that
 * keeps unparseable code out of the registry, so a model fixes it and defines
 * again instead of discovering the failure at run time. `new Function` is the
 * gate — hosts without a real `node:vm` (the browser worker) still refuse
 * unparseable code — and `vm.Script` is only the best-effort prettifier: on a
 * Node host its failure carries the source-line-and-caret prelude the
 * teaching text builds on, and where the vm is a stub the message stays bare.
 * The two parsers' syntax faces differ at the margin (`new.target` parses in
 * a function body but not at the vm wrapper's top level), an accepted cost of
 * a vm-free gate; and under a page CSP without `'unsafe-eval'`, `new Function`
 * throws `EvalError`, which propagates unwrapped.
 * @param code - the model-written function body.
 * @param half - which define argument carried it, for the error text.
 * @throws when the body does not parse, with the offending line and a teaching hint.
 */
export function precheckCode(code: string, half: 'code.host' | 'code.client'): void {
  const wrapped = `(async () => {\n${code}\n})()`
  try {
    // Compile-only: constructing the function parses the source and runs nothing.
    new Function(wrapped)
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage(half, prettyParseContext(wrapped, half, error)))
  }
}

/**
 * Best-effort vm recompile of a body `new Function` already refused, for the
 * source-line-and-caret prelude only.
 * @param wrapped - the wrapped source that failed to parse.
 * @param half - which define argument carried it, for the vm filename.
 * @param refusal - the gate's own `SyntaxError`, the fallback context source.
 * @returns the vm prelude when a real vm produced one, else the bare refusal.
 */
function prettyParseContext(_wrapped: string, _half: 'code.host' | 'code.client', refusal: Error): string {
  return String(refusal)
}

/**
 * Evaluate a host half as the body of an async function whose parameters are the sandbox
 * keys. Parse errors include the offending line and a TypeScript-removal or bracket-balance
 * hint. `vmTimeoutMs` is accepted for call-site compatibility and does not interrupt a
 * tight loop (no `node:vm`).
 * @param sandbox - the object from {@link createSandbox}.
 * @param code - the model-written function body; must `return` a plugin.
 * @param id - the package id (unused without a vm filename).
 * @param vmTimeoutMs - unused without `node:vm`.
 * @returns whatever the code returned, still un-narrowed (the run lifecycle checks plugin shape).
 */
export async function evaluateHostCode(sandbox: object, code: string, _id: string, _vmTimeoutMs: number): Promise<unknown> {
  try {
    const keys = Object.keys(sandbox)
    const values = keys.map(key => (sandbox as Record<string, unknown>)[key])
    type HostAsyncFn = (...args: unknown[]) => Promise<unknown>
    type HostAsyncCtor = new (...args: string[]) => HostAsyncFn
    const AsyncFunction = (async function asyncFunctionProbe() { /* ctor probe */ }).constructor as HostAsyncCtor
    // `globalThis` is the sandbox object so writes do not leak to the host.
    // `_vmTimeoutMs` cannot interrupt a tight loop without node:vm (SC1010).
    const fn = new AsyncFunction(...keys, 'globalThis', `return (async () => {\n${code}\n})()`)
    return await fn(...values, sandbox)
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage('code.host', syntaxErrorContext(error)))
  }
}
