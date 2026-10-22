---
description: "Native compilation entry and plugin inventory for maintainers checking scriptc compatibility."
kind: "package-library"
---

# @deepseek-ai/dsh-native-embed

English | [中文](README.zh.md)

## Summary

Inspect which workspace plugins the native build asks scriptc to compile. The entry launches the existing CLI and contains literal imports for the inventoried packages. This private migration package does not yet produce a working executable with scriptc 0.3.6.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

The parent workspace build uses `src/bin.ts`; `src/list-plugins.mjs` discovers package names from source and configuration. Compiler coverage is an admission check. The native tests require a staged installation supplied through `DSH_NATIVE_BIN`; they verify static ELF linkage, the binary digest, compiler and application versions, packaged dependencies and actual CLI behavior. Session checks cover each configured storage encoding, current ZIP exports, preservation of released generations during migration and rejection of mixed encodings. Failed optional imports must report the missing package while the Web application remains available.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals</summary>

The compiler imports the inventory through the existing CLI entry. The discovery script supplies names for build admission; it does not install a runtime module resolver.

</details>

<a id="further-exploration"></a>

## Further Exploration

The [development guide](../../../docs/development.md) describes repository builds and validation requirements.

<a id="model-experience"></a>

## Model Experience

Indirectly, through profiles launched by the CLI; this entry declares no prompts or tools of its own.

#### KV Cache effect

Profile composition owns request tokens and cache prefixes; this package adds no separate request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Literal imports do not implement runtime plugin resolution. Current compilation has unresolved blockers, and legacy native tests and status reports require migration before they can certify the target release.

<a id="dev-note"></a>

### Dev Note

None.
