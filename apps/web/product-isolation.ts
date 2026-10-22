/** Vite adapters for recording product chunk, asset, CSS, and worker inputs. */

import type { Plugin, ResolvedConfig } from 'vite'
import { WebProductBundleIsolation } from '../../scripts/web-product-bundle-isolation.ts'

const DEPENDENCY_ANALYSIS_PLUGIN = 'dsh-browser-dependency-analysis'

/**
 * Identify a dependency-disclosure walk that deliberately leaves third-party imports external.
 * @returns Analysis intent that refuses builds which can write output.
 */
export function browserDependencyAnalysis(): Plugin {
  return {
    name: DEPENDENCY_ANALYSIS_PLUGIN,
    apply: 'build',
    configResolved(config) { requireNonWritingAnalysis(config.build.write) },
  }
}

function requireNonWritingAnalysis(write: boolean): void {
  if (write !== false) throw new Error('browser dependency analysis requires build.write: false')
}

function recordTransformInputs(config: ResolvedConfig, inputs: WebProductBundleIsolation): void {
  for (const name of ['vite:css', 'vite:asset-import-meta-url']) {
    const plugins = config.plugins.filter(plugin => plugin.name === name)
    const plugin = plugins[0]
    if (plugins.length !== 1 || plugin?.transform === undefined) {
      throw new Error(`Web product isolation: ${name} input instrumentation is unavailable`)
    }
    const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler
    plugin.transform = {
      ...typeof plugin.transform === 'function' ? {} : plugin.transform,
      handler(code, id, options) {
        inputs.transformStart(id)
        const context = new Proxy(this, {
          get(target, property) {
            if (property === 'addWatchFile') return (file: string): void => {
              inputs.transformDependency(id, file)
              target.addWatchFile(file)
            }
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return transform.call(context, code, id, options)
      },
    }
  }
}

/**
 * Reject experimental inputs reachable from the built default Web page.
 * @param repository - repository root supplying package ownership.
 * @param webRoot - Vite root containing index.html and public assets.
 * @returns Build plugins that preserve Vite's output and fail before publication on a violation.
 */
export function productWebBundleIsolation(repository: string, webRoot: string): Plugin[] {
  const inputs = new WebProductBundleIsolation(repository, webRoot)
  let dependencyAnalysis = false
  return [{
    name: 'dsh-product-web-chunk-inputs',
    apply: 'build',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        if (!dependencyAnalysis) inputs.captureChunks(bundle)
      },
    },
  }, {
    name: 'dsh-product-web-bundle-isolation',
    apply: 'build',
    enforce: 'post',
    config(config) {
      const renderBuiltUrl = config.experimental?.renderBuiltUrl
      const workerPlugins = config.worker?.plugins
      return {
        experimental: {
          renderBuiltUrl(filename, context) {
            inputs.assetReference(filename, context.hostId, context.type)
            return renderBuiltUrl?.(filename, context)
          },
        },
        worker: {
          plugins: () => [...workerPlugins?.() ?? [], {
            name: 'dsh-worker-build-inputs',
            configResolved(config) { recordTransformInputs(config, inputs) },
            generateBundle: {
              order: 'post',
              handler(_options, bundle) { inputs.workerBundle(bundle, [...this.getModuleIds()]) },
            },
          }],
        },
      }
    },
    configResolved(config) {
      dependencyAnalysis = config.plugins.some(plugin => plugin.name === DEPENDENCY_ANALYSIS_PLUGIN)
      if (dependencyAnalysis) {
        requireNonWritingAnalysis(config.build.write)
        return
      }
      recordTransformInputs(config, inputs)
    },
    buildStart() { inputs.reset() },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (!dependencyAnalysis) inputs.verify(bundle, id => this.getModuleInfo(id))
      },
    },
  }]
}
