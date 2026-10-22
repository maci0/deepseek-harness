# Agent Note: Align the workspace Node floor with installed tools

Status: implemented

English | [中文](2026-07-06-node-engine-floor.zh.md)

## Problem

The Node 22 branch of the root `engines.node` range is a contract for the installed workspace, not only for the runtime APIs the harness source calls directly. It must be no lower than package `engines.node` declarations for dependencies the workspace installs on that branch; otherwise `pnpm install --engine-strict` fails at an advertised LTS version, and non-strict installs run outside a dependency's supported runtime.

## Decision

The private root declares `engines.node` as `^22.22.2 || ^24.15.0 || >=26.0.0`, matching its npm 12.2.0 development dependency. Contributor builds and primary CI use Node 26.12.0. The compatibility matrix pins the Node 22 and Node 24 tooling floors at 22.22.2 and 24.15.0 and also exercises Node 26. Every compatibility version runs focused source-worker, Zstandard, source-launch, and [jsdom storage](../../archived/testing/2026-07-30-vitest-jsdom-webstorage-ownership.md) smokes without repeating the primary coverage inventory. Published application manifests retain their separate runtime contracts.

Two Node features gate the source runtime:

- **`node:sqlite`** — `packages/storage/storage-sqlite` does a top-level `import { DatabaseSync } from 'node:sqlite'`, and the optional Session-query provider loads it on first search. The module dropped its `--experimental-sqlite` flag requirement at **22.13** (LTS) and **23.4** (Current); before those, importing it throws at load.
- **Native TypeScript type-stripping** — the built-mode `apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts` smoke boots the test-support `.ts` driver under plain `node` (no tsx) and loads the `.ts` test adapter (`cli-mock-llm.ts`). Type-stripping is the default from **22.18** (LTS) and **23.6** (Current); before those it needs `--experimental-strip-types`.

Those source features clear on the 22.x line at **22.18**. The Pi adapter requires at least 22.19, but npm 12 raises the private workspace floor further. The disjoint engine range excludes unsupported Node 23 and Node 25 releases.

`@types/node` uses the current 26.x API. This no longer statically enforces older runtime floors: compatibility tests must catch use of newer APIs on those lines. A typecheck on Node 26 alone does not prove Node 22 or Node 24 runtime compatibility.

## Consequences

- The private workspace engine range covers the installed development tools.
- CI declares the tooling floors directly and uses Node 26.12.0 for primary builds; these configured matrix jobs require their own CI evidence.
- The built-mode smoke needs no version-conditional flag: type-stripping is already the default at each declared floor, so the example-owned TypeScript driver stays a plain `node fixture.ts` path.
- A future dependency or source API that raises the runtime floor must move `engines.node`, the compatibility matrix, and this Agent Note in the same change.

## Alternatives considered

- **Keep the old workspace floors.** npm 12.2.0 does not support Node 22.19 or Node 24.9; advertising those versions for a full workspace install contradicts the installed tool requirements.
- **Pin Node types to 22.x.** This catches newer API use statically but conflicts with the current toolchain requirement. The current types require separate runtime compatibility tests for older supported lines.
- **Use floating compatibility versions.** Floating versions stop exercising the declared minimum as releases advance. The Node 22 and Node 24 jobs retain exact floors.
