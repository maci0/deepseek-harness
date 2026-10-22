---
description: "用于原生可执行文件验收测试的私有运行时探针。"
kind: "package-reference"
---

# @deepseek-ai/dsh-native-probe

[English](README.md) | 中文

## 概述

从原生测试组合中执行选定的运行时操作。所选探针报告结果后终止进程。这些旧版探针属于私有测试设施，不能作为当前版本的验证依据。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

原生测试通过 `DSH_NATIVE_PROBE` 选择探针，并在正常 CLI 的 `--patch` 叠加配置中通过文件 URL 加载 `src/index.js`。生产依赖树无需包含这个仅用于测试的包。不要将其添加到用户配置档案：完成路径会退出应用。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>实现细节</summary>

插件在激活时读取选择器，执行单个探针或完整探针列表。每个结果写入标准输出；失败以状态 1 退出，成功激活以状态 0 退出。

</details>

<a id="further-exploration"></a>

## 进一步探索

[开发指南](../../../docs/development.zh.md)介绍仓库构建与验证要求。

<a id="model-experience"></a>

## 模型体验

无，因为这些探针仅执行运行时操作，不组装模型请求。

#### KV 缓存影响

无；探针不添加提供商请求或缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Worker 与 Landlock 探针引用了已移除的包名和 API。将其迁移到当前 PTC 与系统原生扩展接口后，才能用作验收证据。

<a id="dev-note"></a>

### 开发备注

无。
