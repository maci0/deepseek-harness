/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */

/** Maximum grace allowed for the application tree to dispose before process exit. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

/** Process-exit controller shared by normal completion and Unix signal handlers. */
export interface ProcessShutdown {
  /** Start or join graceful disposal before allowing natural completion with `code`. */
  shutdown(code: number): Promise<void>
  /** Start graceful disposal followed by exit, or force exit when shutdown is already running. */
  interrupt(code: number): void
}

/**
 * Create one process-exit controller around an application disposer.
 * Callers supply `complete`: Node records `process.exitCode`, scriptc exits
 * immediately (`process.exitCode = n` is SC1090).
 * @param dispose - Whole-application teardown that resolves at quiescence.
 * @param forceExit - Function that exits the process immediately, replaceable by tests.
 * @param complete - Function that records the natural completion code, replaceable by tests.
 * @param timeoutMs - Grace before forced exit, replaceable by tests.
 * @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
 */
let nodeComplete: ((code: number) => void) | undefined

/**
 * Node `dsh` (`bin.ts`) installs `recordNodeExitCode` here so
 * {@link createProfileShutdown} can record `process.exitCode` without that
 * assignment living in the scriptc compile graph (SC1090).
 */
export function installNodeComplete(complete: (code: number) => void): void {
  nodeComplete = complete
}

/** Test-only: drop a previously installed Node complete callback. */
export function resetNodeComplete(): void {
  nodeComplete = undefined
}

function profileForceExit(code: number): void {
  process.exit(code)
}

function profileComplete(code: number): void {
  if (process.argv[0] === 'scriptc') {
    process.exit(code)
    return
  }
  const installed = nodeComplete
  if (installed !== undefined) {
    installed(code)
    return
  }
  process.exit(code)
}

/**
 * Shutdown factory used by {@link runProfile}. Node records exitCode after
 * `installNodeComplete`; scriptc always `process.exit`s.
 */
export function createProfileShutdown(dispose: () => Promise<void>): ProcessShutdown {
  return createProcessShutdown(dispose, profileForceExit, profileComplete)
}

export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void,
  complete: (code: number) => void,
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let forceExited = false

  const clearExitTimeout = (): void => {
    /* v8 ignore else -- shutdown() arms the timer before any asynchronous exit path can run. */
    if (timeout !== undefined) clearTimeout(timeout)
  }

  const forceExitOnce = (code: number): void => {
    if (forceExited) return
    forceExited = true
    clearExitTimeout()
    forceExit(code)
  }

  const completeOnce = (code: number): void => {
    if (completed || forceExited) return
    completed = true
    clearExitTimeout()
    complete(code)
  }

  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    timeout = setTimeout(() => { forceExitOnce(code) }, timeoutMs)
    // scriptc SC2020: Promise.then with two arguments has no lowering.
    pending = Promise.resolve().then(dispose).then(() => {
      if (forceAfterDispose) forceExitOnce(code)
      else completeOnce(code)
    }).catch(() => { forceExitOnce(code) })
    return pending
  }

  return {
    shutdown(code) {
      return start(code, false)
    },
    interrupt(code) {
      if (pending !== undefined) {
        forceExitOnce(code)
        return
      }
      void start(code, true)
    },
  }
}
