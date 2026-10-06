# ZCode

## 1. 在 Gian 中做什么

ZCode Integration 将 ZCode CLI 的编码会话、模型配置和活动事件接入 Gian。0.4.2 使用随 Proxy 发布并校验的 ZCode CLI 0.16.9，不再依赖 ZCode.app 内嵌 Runtime，也不读取桌面进程的私有凭据。

## 2. 支持的能力与限制

支持会话创建与恢复、历史重放、模型和配置快照、工具活动、权限交互、附件、重命名、分叉、当前轮次引导（Steer）、子 Agent 活动和按会话注入 Gian MCP。具体选项以实际 Runtime 返回的目录为准。原生历史删除不受支持；普通关闭只是解除 Gian 的会话关联。真实 Provider 请求还需要单独验收，安装成功不等于模型请求已成功。

## 3. 运行原理与进程关系

```text
Gian Host → ZCode Proxy → 按工作区隔离的 ZCode CLI 0.16.9 Runtime → Provider
```

内层使用 ZCode Protocol 的结构化 stdio 通信，外层使用 Gian Proxy 协议。共享 Proxy 可以为不同工作区管理独立的 Runtime。Gian 关闭会话采用 detach 语义，不删除原生历史。

## 4. 安装与依赖

从 Gian 的官方 Catalog 安装 ZCode Integration。Gian 校验并准备 Proxy 及其固定版本的 CLI Runtime；不需要预装 ZCode.app，也不从桌面应用提取 Runtime。不要手填任意可执行文件路径来绕过版本与摘要校验。

## 5. 第一次使用

1. 在 Gian 中安装并准备 ZCode Integration，确认 Proxy 0.4.2 和 CLI 0.16.9 校验成功。
2. 使用随安装提供的 `zcode login` 或 ZCode TUI 完成官方 Provider 配置。
3. 在 Agent 中选择模型和工作区，先进行小范围文本任务；附件和其他能力按实际模型及 Provider 支持情况使用。

本说明不代表当前机器已经完成真实模型请求验收。

## 6. HOME 与隔离

ZCode CLI 的用户配置通常位于 `~/.zcode/v2/provider_config.json`；旧版 `~/.zcode/cli/config.json` 可由 CLI 导入。Runtime 应使用 Agent 选定的非空 HOME，多个 HOME 的账号与配置不能混用。不要复制 Token 或清空原生历史作为排障步骤。

## 7. 反向代理与自定义端点

仅使用 ZCode 官方 Provider 配置支持的端点及认证方式。Gian Proxy、ZCode Provider 配置与模型反向代理是不同层；端点配置不能修复 Runtime 版本或协议不兼容。

## 8. 操作注意事项

- 固定版本及摘要是兼容边界；升级需要新的发布与验证。
- 模型列表以 Runtime 实际快照为准，空列表不应靠解析配置文件伪造。
- 关闭、取消与原生删除是不同操作；不要为排障删除会话数据。
- 真实 Provider 调用可能产生费用，按需单独执行验收。

## 9. 故障排查

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| Runtime 未能启动 | 安装摘要、CLI 版本、工作区路径 | 重新准备官方发布并保留诊断 |
| 没有模型 | 官方 Provider 登录与配置 | 在所选 HOME 下运行 `zcode login` 或 TUI |
| 登录后仍无配置 | Agent HOME 是否与登录时一致 | 在正确 HOME 下完成登录 |
| 附件或分叉失败 | 当前模型、Runtime 返回的能力与错误 | 不将未返回的能力视为已实现 |
| 关闭后担心历史丢失 | 是否仅为 Gian detach | 使用官方 CLI 核对，不额外执行删除 |
