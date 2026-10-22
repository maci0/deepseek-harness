# Agent Note: 使工作区 Node 下限与已安装工具保持一致

Status: implemented

[English](2026-07-06-node-engine-floor.md) | 中文

## 问题

根 `engines.node` 范围中的 Node 22 分支是对安装后工作区的约定，而不仅仅是 harness 源码直接调用的运行时 API 的约定。它不得低于工作区在该分支上安装的依赖包所声明的 `engines.node`；否则 `pnpm install --engine-strict` 会在一个已宣传的 LTS 版本上失败，而非严格模式下的安装结果则会在依赖所支持的运行时范围之外运行。

## 决策

私有根包将 `engines.node` 声明为 `^22.22.2 || ^24.15.0 || >=26.0.0`，与 npm 12.2.0 开发依赖保持一致。贡献者构建和主要 CI 使用 Node 26.12.0。兼容性矩阵将 Node 22 和 Node 24 的工具下限固定为 22.22.2 和 24.15.0，并验证 Node 26。每个兼容版本均运行 source-worker、Zstandard、source-launch 和 [jsdom 存储](../../archived/testing/2026-07-30-vitest-jsdom-webstorage-ownership.md) 专项冒烟测试，不重复主要覆盖率任务。已发布应用的清单保留各自的运行时约定。

两个 Node 特性决定了源码运行时的门槛：

- **`node:sqlite`**：`packages/storage/storage-sqlite` 在顶层执行 `import { DatabaseSync } from 'node:sqlite'`，可选 Session-query provider 则在首次搜索时加载它。该模块在 **22.13**（LTS）和 **23.4**（Current）取消了 `--experimental-sqlite` 标志要求；在此之前，导入它会在加载时抛出异常。
- **原生 TypeScript 类型剥离**——构建模式的 `apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts` 冒烟测试使用纯 `node`（无 tsx）启动 test-support 的 `.ts` driver，并加载 `.ts` 测试适配器（`cli-mock-llm.ts`）。类型剥离从 **22.18**（LTS）和 **23.6**（Current）起成为默认行为；更早版本需要 `--experimental-strip-types`。

这些源码特性在 22.x 线上于 **22.18** 全部就绪。Pi 适配器至少需要 22.19，但 npm 12 进一步提高了私有工作区的下限。不相交的引擎范围排除了不受支持的 Node 23 和 Node 25 发布线。

`@types/node` 使用当前 26.x API。这不再静态约束较旧的运行时下限：兼容性测试必须检测这些发布线上使用较新 API 的问题。仅在 Node 26 上通过类型检查，不能证明 Node 22 或 Node 24 的运行时兼容性。

## 后果

- 私有工作区引擎范围涵盖已安装的开发工具。
- CI 直接声明工具下限，并使用 Node 26.12.0 进行主要构建；这些已配置的矩阵任务需要各自的 CI 验证证据。
- 构建模式冒烟测试无需版本条件标志：每个声明的下限版本均已默认启用类型剥离，因此示例自有的 TypeScript driver 保持使用纯 `node fixture.ts` 路径。
- 未来若依赖或源码 API 提高运行时下限，必须在同一变更中同步调整 `engines.node`、兼容性矩阵和本 Agent Note。

## 曾考虑的替代方案

- **保留旧的工作区下限。** npm 12.2.0 不支持 Node 22.19 或 Node 24.9；将这些版本宣传为完整工作区安装的支持版本，与已安装工具的要求相矛盾。
- **将 Node 类型固定在 22.x。** 这能静态检测较新 API 的使用，但与当前工具链要求冲突。使用当前类型时，必须单独测试较旧受支持发布线的运行时兼容性。
- **使用浮动的兼容版本。** 随着发布推进，浮动版本会停止验证声明的最低版本。Node 22 和 Node 24 任务保留精确下限。
