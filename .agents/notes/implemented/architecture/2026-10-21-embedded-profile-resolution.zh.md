# Agent Note: 与嵌入式运行时共享配置路由

Status: implemented

[English](2026-10-21-embedded-profile-resolution.md) | 中文

## 问题

原生 scriptc 宿主通过嵌入式引擎运行 JavaScript 插件。它无法加载暴露 Node 私有模块加载器的原生扩展。返回空拦截器会丢失配置包选择和依赖隔离。

## 决策

配置解析从同一个后端获取 CommonJS 解析器、ESM 默认解析器、条件集合及 ESM 拦截安装器。Node 保留现有私有加载器适配器。嵌入式运行时在导入启动器前，通过 `globalThis[Symbol.for('dsh.module-resolution')]` 提供这些操作。

两个后端都使用现有 `ResolutionRouter`，包括配置映射、链接包、作用域查找、路径重定位、后继配置发布和释放。嵌入式操作必须参与真实的 import 和 require 解析；占位方法不符合此约定。

`ModuleLoader.importFrom` 将每个插件的配置父路径传给 Node 内部导入器，或嵌入式后端的 `importModule`。模块任务检查仍是独立能力。

## 考虑过的替代方案

在原生运行时中复制配置路由会产生相互竞争的查找规则。提供伪装的 Node 内部接口会掩盖不受支持的模块任务和 HMR 操作。后端只提供运行时实际实现的解析和导入操作。

## 影响

此接口只负责解析。它不提供 Node 模块任务、HMR 缓存操作、原生扩展兼容性或 Worker 隔离。原生发行版仍需单独集成并进行应用验证；Node 路由测试通过只证明 Node 适配器的行为。
