# Agent Note: Separate the TypeScript compiler and analysis API

Status: implemented

English | [中文](2026-10-21-typescript-compiler-and-api.zh.md)

## Problem

TypeScript 7 no longer exports the synchronous compiler API used by Typert and repository source analyzers. Updating the compiler alone leaves those consumers unable to construct programs or inspect syntax nodes.

## Decision

The `typescript` dependency supplies the TypeScript 7 compiler. The explicitly named `typescript-api` alias supplies TypeScript 6.0.3's synchronous analysis library. Source analyzers import that alias; build commands continue invoking `typescript/bin/tsc`. Typert declares the alias as a production dependency because consumers construct analyzers outside this repository.

Compiler entry lookup resolves the exported `typescript/package.json` and constructs the bin URL. It does not resolve the private `typescript/bin/tsc` package subpath.

## Alternatives considered

**Keep the compiler on TypeScript 6.** This prevents using the requested current compiler and leaves build verification on the old toolchain.

**Migrate every analyzer to the TypeScript 7 remote API.** That changes program ownership and synchronous traversal across Typert, documentation extractors, and gates. It is separate work from upgrading the build compiler and requires equivalent extraction evidence.

## Consequences

The compiler and analysis library have independent versions. New syntax accepted by TypeScript 7 can remain unsupported by the TypeScript 6 analyzer; generated-artifact and analyzer tests remain necessary. Remove the alias when all synchronous API consumers migrate together. Compiler-helper fixtures exercise the actual TypeScript 7 command, while Typert Worker tests check analysis and artifact equality.
