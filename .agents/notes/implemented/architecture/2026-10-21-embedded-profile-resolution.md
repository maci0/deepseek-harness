# Agent Note: Share profile routing with the embedded runtime

Status: implemented

English | [中文](2026-10-21-embedded-profile-resolution.zh.md)

## Problem

The native scriptc host runs JavaScript plugins in an embedded engine. It cannot load the addon that exposes Node's private module loader. Returning an empty interception would discard profile package selection and dependency isolation.

## Decision

Profile resolution obtains its CommonJS resolver, ESM default resolver, condition sets, and ESM interception installer from one backend. Node retains its existing private-loader adapter. An embedded runtime supplies these operations through `globalThis[Symbol.for('dsh.module-resolution')]` before importing the launcher.

Both backends use the existing `ResolutionRouter`, including profile mappings, linked packages, scoped lookup, relocation, successor publication, and disposal. The embedded operations must participate in actual import and require resolution; placeholder methods do not satisfy this contract.

`ModuleLoader.importFrom` passes each plugin's configured parent to Node's internal importer or the embedded backend's `importModule`. Module-job introspection remains a separate capability.

## Alternatives considered

Duplicating profile routing in the native runtime would create competing lookup rules. Exposing pretend Node internals would conceal unsupported module jobs and HMR operations. The backend supplies only the resolution and import operations the runtime actually implements.

## Consequences

This interface covers resolution. It does not supply Node module jobs, HMR cache manipulation, native addon compatibility, or worker isolation. The native distribution still requires separate integration and application validation; passing Node routing tests establishes only the Node adapter's behavior.
