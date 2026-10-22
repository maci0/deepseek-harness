# Agent Note: 分离 TypeScript 编译器与分析 API

Status: implemented

[English](2026-10-21-typescript-compiler-and-api.md) | 中文

## Problem

TypeScript 7 不再导出 Typert 与仓库源码分析器使用的同步编译器 API。只升级编译器会使这些消费者无法创建程序或检查语法节点。

## Decision

`typescript` 依赖提供 TypeScript 7 编译器。显式命名的 `typescript-api` 别名提供 TypeScript 6.0.3 的同步分析库。源码分析器导入该别名；构建命令继续调用 `typescript/bin/tsc`。Typert 将别名声明为生产依赖，因为消费者会在本仓库之外创建分析器。

编译器入口查找先解析导出的 `typescript/package.json`，再构造 bin URL。它不解析私有的 `typescript/bin/tsc` 包子路径。

## Alternatives considered

**将编译器留在 TypeScript 6。** 这无法满足使用当前编译器的要求，并使构建验证继续依赖旧工具链。

**将所有分析器迁移到 TypeScript 7 远程 API。** 这会改变 Typert、文档提取器和检查脚本中的程序所有权与同步遍历方式。它属于构建编译器升级之外的工作，并且需要等价的提取验证。

## Consequences

编译器与分析库拥有独立版本。TypeScript 7 接受的新语法仍可能不受 TypeScript 6 分析器支持；生成产物与分析器测试仍然必要。当所有同步 API 消费者一同迁移后，移除该别名。编译器辅助脚本的夹具执行实际的 TypeScript 7 命令，而 Typert Worker 测试检查分析结果与产物一致性。
