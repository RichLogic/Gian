# Grok Build

## 1. 在 Gian 中做什么

Grok Build Integration 通过官方 Grok CLI 的 ACP stdio 接口运行编码会话。Gian 负责 Session、消息、工具审批和历史展示，Grok Runtime 负责模型调用与原生会话。

## 2. 支持的能力与限制

当前认证组合支持文本、本地文件、图片、工具审批、推理、用量和历史回放。发布版 CLI 1.0.41 的 stdio 接口没有注册 x.ai Steer、Rename、Fork、Side Chat 和原生删除方法，因此这些能力不会出现在界面中。

## 3. 运行原理与进程关系

```text
Gian Host -> Grok Proxy -> grok agent --no-leader stdio -> Grok service
```

Proxy 按 Session 启动 Runtime，并强制 workspace sandbox。不同 Agent 的 HOME 和登录状态保持隔离。

## 4. 安装与依赖

从 Agent Integrations 安装。Gian 根据 signed Catalog 下载 Proxy 0.3.6 和官方 Grok CLI 1.0.41，校验 URL、大小、SHA-256、版本、Manifest 和安装收据后才激活。

## 5. 第一次使用

安装完成后创建 Grok Agent，在该 Agent 的维护终端完成 OAuth。返回 Gian 选择 Grok 4.7 和需要的 reasoning effort，再从小型任务开始验证消息和工具审批。

## 6. HOME 与隔离

Grok 登录、配置、缓存和原生历史位于该 Agent 的托管 HOME。系统已有 `~/.grok` 不会自动复制到 Gian Agent，也不应通过共享 HOME 绕过隔离。

## 7. 反向代理与自定义端点

使用 Grok CLI 官方支持的认证与端点配置。不要把 API Key 写进任务消息、Catalog 或 Proxy 配置，也不要通过修改 Gian Host 地址来替代模型端点配置。

## 8. 操作注意事项

- Runtime 自动更新由 Gian 禁用，升级必须走新的认证 Catalog 组合。
- 工具权限响应必须在活动 Turn 期间及时返回。
- Runtime 返回 Method not found 时，Proxy 必须收窄能力，不能假成功。
- 更新或卸载前结束活动 Turn；关闭 UI 不等于模型或工具进程已经结束。

## 9. 故障排查

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| Catalog 中没有 Grok | Catalog 是否同步到包含 Grok 的新序列 | 重新同步，不使用本地源码冒充安装 |
| 安装失败 | GitHub/x.ai 网络、摘要和安装收据 | 保留旧激活版本，按具体下载或校验错误处理 |
| 认证失败 | 当前 Agent HOME | 在同一 Agent 维护终端重新 OAuth |
| Steer、Rename 或 Fork 不显示 | Runtime 1.0.41 的真实 stdio capability | 使用当前支持的操作，不伪造扩展 |
| 工具一直等待 | 是否存在 interaction.requested | 在 Gian 中完成审批或中断 Turn |
