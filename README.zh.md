# Native dsh

[English](README.md) | 中文

面向 Linux x86_64 的单文件 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。用 [scriptc](https://scriptc.dev/) 编译。不需要 Node、不需要 npm install、不需要 glibc。

本仓库是 native fork。分支 [`native/all`](https://github.com/maci0/deepseek-harness/tree/native/all) 是产品源码。若要使用 `npx @deepseek-ai/dsh`，请走[上游](https://github.com/deepseek-ai/deepseek-harness)。

## 运行

从 [Releases](https://github.com/maci0/deepseek-harness/releases) 下载最新的 `dsh-native-*-linux-x64.tar.gz`：

```
tar -xzf dsh-native-*-linux-x64.tar.gz
cd dsh-native-*-linux-x64
chmod +x dsh
./dsh --profile web
```

该命令会打印 `dsh web: http://127.0.0.1:<port>` 并提供浏览器 UI。未指定 `--port` 时，二进制会绑定空闲端口，以免与 3080 上的 Node dsh 冲突。请把 `dsh` 和 `package.json` 放在同一目录。

```
./dsh -V
./dsh --profile web --help
./dsh --profile headless --help
./dsh --profile web --dump-config
./dsh --profile web --no-open --port 0
```

会话数据在 `$HOME/.dsh-native`，除非设置了 `DSH_HOME`。不需要 `DSH_INSTALL`。把 `DEEPSEEK_API_KEY` 放进环境变量，或放进 `$DSH_HOME/.env`。

## 这是什么

`dsh` 是 musl-static ELF。每个已编目的 Cordis 插件都在编译期嵌入。启动时 Cordis 的 `import(name)` 命中该表。编译之后不能再添加 npm 插件。

每个插件的目录、native 编译状态（`embedded` / `embedded-degraded` / `not-embedded`，以及 `static` 与 island fallback）以及是否经过测试，见 [NATIVE-PLUGIN-STATUS.md](packages/test-support/native-embed/NATIVE-PLUGIN-STATUS.md)。

## 限制

- 仅 Linux x86_64
- `sharp`、`node-pty`、`koffi` 和 landlock 被 stub（没有 `process.dlopen`）
- `node:sqlite` 在首次真正使用时抛错。默认持久化是 JSONL
- `dsh plugin ...` 被 stub
- Island HTTP 没有 WebSocket upgrade。事件流使用 SSE（Server-Sent Events）（`GET /api/events.mux`）
- 动态包的 host 半边用 `Function` 求值，不用 `node:vm`。忙循环不会被打断

## 源码

[`native/all`](https://github.com/maci0/deepseek-harness/tree/native/all) 变基到 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。本 fork 上的 `master` 镜像上游，不是 native 产品。

本 fork 上的 native 补丁：

- [#1](https://github.com/maci0/deepseek-harness/pull/1) CLI（命令行界面） / scriptc 适配
- [#2](https://github.com/maci0/deepseek-harness/pull/2) JSONL 持久化
- [#3](https://github.com/maci0/deepseek-harness/pull/3) host web API
- [#4](https://github.com/maci0/deepseek-harness/pull/4) native-embed 插件

## 重新编译

运行请用 Releases。本分支是 `scriptc` 编译的源码。Native 检查：`packages/test-support/native-embed/tests/native-binary.test.mjs`。编译用的 Makefile 和 `dist/` 在旁边的编译工作区里，不在本 git 树中。

## 许可证

与 DeepSeek Harness 相同（[MIT](LICENSE)）。第三方声明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
