#!/usr/bin/env node
/**
 * scriptc compile entry for `dsh`. Island cannot lower `import.meta.url`,
 * JSON.parse Record indexing, or `plugin.ts` (`Object.keys` on island records
 * is SC9001). Node keeps `bin.ts` + `plugin.ts` unchanged.
 * @module @deepseek-ai/dsh/bin-native
 */

/* v8 ignore file -- native-embed compiles this file; Node uses bin.ts. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDshArgs } from './args.ts'

if (process.argv[0] === 'scriptc' && !(process.env.DSH_HOME ?? '').trim()) {
  process.env.DSH_HOME = join(homedir(), '.dsh-native')
}

function readVersion(): string {
  return '0.1.1-rc.4+scriptc.33'
}

const invocation = parseDshArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'profile': {
    const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    process.stderr.write(
      `dsh: native binary does not support \`plugin\` yet (profile=${invocation.profile}, argc=${String(invocation.args.length)})\n`,
    )
    process.exit(1)
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
