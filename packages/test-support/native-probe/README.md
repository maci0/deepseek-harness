---
description: "Private runtime probes for native executable acceptance tests."
kind: "package-reference"
---

# @deepseek-ai/dsh-native-probe

English | [中文](README.zh.md)

## Summary

Exercise selected runtime operations from a native test composition. A selected probe reports its result and terminates the process. These legacy probes are private test infrastructure and are not current-release verification.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

The native tests select a probe through `DSH_NATIVE_PROBE` and load `src/index.js` by file URL in a normal CLI `--patch` overlay. This test-only package is not required in the production dependency tree. Do not add it to a user profile: its completion path exits the application.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals</summary>

The plugin reads its selector during activation and dispatches to one probe or the complete family list. Each result goes to standard output; failures exit with status 1 and successful activation exits with status 0.

</details>

<a id="further-exploration"></a>

## Further Exploration

The [development guide](../../../docs/development.md) describes repository builds and validation requirements.

<a id="model-experience"></a>

## Model Experience

None, as these probes exercise runtime operations without assembling model requests.

#### KV Cache effect

None; probes add no provider request or cache prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The worker and Landlock probes reference retired package names and APIs. Migrate them to the current PTC and system-addon interfaces before using them as acceptance evidence.

<a id="dev-note"></a>

### Dev Note

None.
