/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */

import {
  createProcessShutdown as createProcessShutdownCore,
  PROCESS_SHUTDOWN_TIMEOUT_MS,
  type ProcessShutdown,
} from './process-shutdown-core.ts'

export { PROCESS_SHUTDOWN_TIMEOUT_MS, type ProcessShutdown }

/**
 * Create one process-exit controller around an application disposer.
 * Node defaults record `process.exitCode` and drain; tests inject fakes.
 * The native compile graph imports {@link createProcessShutdown} from
 * `process-shutdown-core.ts` instead: `process.exitCode = n` is SC1090.
 * @param dispose - Whole-application teardown that resolves at quiescence.
 * @param forceExit - Function that exits the process immediately, replaceable by tests.
 * @param complete - Function that records the natural completion code, replaceable by tests.
 * @param timeoutMs - Grace before forced exit, replaceable by tests.
 * @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => { process.exit(code) },
  complete: (code: number) => void = (code) => {
    if (process.argv[0] === 'scriptc') process.exit(code)
    else process.exitCode = code
  },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  return createProcessShutdownCore(dispose, forceExit, complete, timeoutMs)
}
