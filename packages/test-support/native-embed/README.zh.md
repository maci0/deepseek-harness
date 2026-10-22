---
description: "原生编译入口与插件清单，供维护者检查 scriptc 兼容性。"
kind: "package-library"
---

# @deepseek-ai/dsh-native-embed

[English](README.md) | 中文

## 概述

检查原生构建要求 scriptc 编译的工作区插件。入口启动现有 CLI，并包含清单中各包的字面量导入。这个私有迁移包尚不能通过 scriptc 0.3.6 生成可工作的可执行文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

父工作区构建使用 `src/bin.ts`；`src/list-plugins.mjs` 从源码和配置发现包名。编译器覆盖率用于检查编译兼容性。原生测试要求通过 `DSH_NATIVE_BIN` 提供暂存安装目录中的可执行文件，并验证 ELF 静态链接、二进制摘要、编译器和应用版本、随包依赖以及实际 CLI 行为。 Session 检查覆盖各自配置的存储编码、当前格式的 ZIP 导出、迁移时保留已发布的不可变代文件，以及拒绝混用编码。可选插件导入失败时必须报告缺失包，同时保持 Web 应用可用。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>实现细节</summary>

编译器通过现有 CLI 入口导入清单中的模块。发现脚本提供用于构建检查的包名；它并不安装运行时模块解析器。

</details>

<a id="further-exploration"></a>

## 进一步探索

[开发指南](../../../docs/development.zh.md)介绍仓库构建与验证要求。

<a id="model-experience"></a>

## 模型体验

通过 CLI 启动的配置档案间接影响模型；此入口本身不声明提示词或工具。

#### KV 缓存影响

配置档案组合负责请求 token 与缓存前缀；本包不添加独立的请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 字面量导入并未实现运行时插件解析。当前编译仍有未解决的问题，旧版原生测试与状态报告必须迁移后才能验证目标版本。

<a id="dev-note"></a>

### 开发备注

无。
