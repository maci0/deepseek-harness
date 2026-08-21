# Native dsh

English | [中文](README.zh.md)

Single-file [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for Linux x86_64. Compiled with [scriptc](https://scriptc.dev/). No Node, no npm install, no glibc.

This repository is the native fork. Branch [`native/all`](https://github.com/maci0/deepseek-harness/tree/native/all) is the product source. For `npx @deepseek-ai/dsh`, use [upstream](https://github.com/deepseek-ai/deepseek-harness).

## Run

Download the latest `dsh-native-*-linux-x64.tar.gz` from [Releases](https://github.com/maci0/deepseek-harness/releases):

```
tar -xzf dsh-native-*-linux-x64.tar.gz
cd dsh-native-*-linux-x64
chmod +x dsh
./dsh --profile web
```

That prints `dsh web: http://127.0.0.1:<port>` and serves the browser UI. With no `--port`, the binary binds a free port so it does not collide with a Node dsh on 3080. Keep `dsh` next to `package.json`.

```
./dsh -V
./dsh --profile web --help
./dsh --profile headless --help
./dsh --profile web --dump-config
./dsh --profile web --no-open --port 0
```

Session data is `$HOME/.dsh-native` unless `DSH_HOME` is set. `DSH_INSTALL` is not required. Put `DEEPSEEK_API_KEY` in the environment, or in `$DSH_HOME/.env`.

## What this is

`dsh` is a musl-static ELF. Every inventoried Cordis plugin is embedded at compile time. Cordis `import(name)` at boot hits that table. You cannot add npm plugins after compile.

Per-plugin directory, native compile status (`embedded` / `embedded-degraded` / `not-embedded`, and `static` vs island fallback), and whether it was tested: [NATIVE-PLUGIN-STATUS.md](packages/test-support/native-embed/NATIVE-PLUGIN-STATUS.md).

## Limits

- Linux x86_64 only
- `koffi` is still a no-op (no `process.dlopen`). sharp admission, node-pty, and landlock use island substitutes (`landlock-run` next to `dsh`)
- Default persistence is JSONL; `node:sqlite` is available when a sqlite plugin is mounted
- `dsh plugin ...` is stubbed
- Island HTTP has no WebSocket upgrade. Event streams use SSE (`GET /api/events.mux`)
- Dynamic package host halves evaluate with `Function`, not `node:vm`. Tight loops are not interrupted

## Source

[`native/all`](https://github.com/maci0/deepseek-harness/tree/native/all) rebases onto [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). `master` on this fork mirrors upstream and is not the native product.

Native patches on this fork:

- [#1](https://github.com/maci0/deepseek-harness/pull/1) CLI / scriptc shims
- [#2](https://github.com/maci0/deepseek-harness/pull/2) JSONL persistence
- [#3](https://github.com/maci0/deepseek-harness/pull/3) host web API
- [#4](https://github.com/maci0/deepseek-harness/pull/4) native-embed plugins

## Rebuild

Releases are how you run it. This branch is the source that `scriptc` compiles. Native checks: `packages/test-support/native-embed/tests/native-binary.test.mjs`. The compiler Makefile and `dist/` live in the sibling compiler workspace, not in this git tree.

## License

Same as DeepSeek Harness ([MIT](LICENSE)). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
