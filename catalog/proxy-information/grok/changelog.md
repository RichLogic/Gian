# Grok Build：版本更新

本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。

本次发布组合快照：Proxy **0.3.11**，Runtime **1.0.62**。这是发布目标，不表示当前机器已安装。

## 0.3.11

首次公开发布：2026-10-17T18:11:27Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.11)：2026-10-17T18:11:27Z。
- 对应 CLI：1.0.62（Manifest 兼容声明，不是本机状态）。

### 变更

- 将受管 Grok CLI 更新至 1.0.62（已晋升 stable：x.ai/cli、官方 GCS 镜像与 npm @xai-official/grok latest 一致；x.ai 与 GCS 字节完全相同）。新二进制已验证启动标志与 ACP initialize 契约（agentVersion 1.0.62、grokShell、能力形状不变，保留原始握手证据）；1.0.53–1.0.62 的逐版本说明在可访问的官方更新日志中 NOT_OBSERVED（该页最新条目仍为 1.0.52），如实记录而非阻止已晋升的稳定通道。已知限制不变：auto/always_approve 快照下的原生批准卡片现象未验证（需要已认证会话）。线协议范围不变。产物经过托管认证；本次发行未运行真实模型 Turn。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.11) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-grok-v0.3.11/packages/proxies/grok-proxy/README.md)

## 0.3.10

首次公开发布：2026-10-16T18:20:15Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.10)：2026-10-16T18:20:15Z。
- 对应 CLI：1.0.60（Manifest 兼容声明，不是本机状态）。

### 变更

- 将受管 Grok CLI 更新至 1.0.60（已晋升 stable：x.ai/cli、官方 GCS 镜像与 npm @xai-official/grok latest 一致；x.ai 与 GCS 字节完全相同）。新二进制已验证启动标志与 ACP initialize 契约（agentVersion 1.0.60、grokShell、能力形状不变）；1.0.53–1.0.60 的逐版本说明在可访问的官方更新日志中 NOT_OBSERVED（该页最新条目仍为 1.0.52），如实记录而非阻止已晋升的稳定通道。已知限制不变：auto/always_approve 快照下的原生批准卡片现象未验证（需要已认证会话）。线协议范围不变。产物经过托管认证；本次发行未运行真实模型 Turn。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.10) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-grok-v0.3.10/packages/proxies/grok-proxy/README.md)

## 0.3.9

首次公开发布：2026-10-15T10:55:40Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.9)：2026-10-15T10:55:40Z。
- 对应 CLI：1.0.52（Manifest 兼容声明，不是本机状态）。

### 变更

- 将受管 Grok CLI 更新至 1.0.52（x.ai/cli 与官方 GCS 镜像字节完全一致）。新二进制已验证启动标志与 ACP initialize 契约；扩展方法仍按连接惰性确认。已知限制：1.0.46 下复合 Shell 命令在 auto/always_approve 快照下仍弹出原生批准卡片的现象在 1.0.52 上未验证（需要已认证会话），本次不声称修复。线协议范围不变。产物经过托管认证；本次发行未运行真实模型 Turn。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.9) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-grok-v0.3.9/packages/proxies/grok-proxy/README.md)

## 0.3.8

首次公开发布：2026-10-11T05:51:45Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.8)：2026-10-11T05:51:45Z。
- 对应 CLI：1.0.46（Manifest 兼容声明，不是本机状态）。

### 变更

- 受管 Grok CLI 升至 1.0.46；Catalog 探测不再拖慢关闭，失败的清理与空快照会重试，仅探测子进程被强制停止；确认类交互明确声明可省略答案的取消动作。独立包使用公开 Proxy Protocol SDK 1.0.2，线协议范围不变。本次发行未运行真实模型 Turn。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.8) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-grok-v0.3.8/packages/proxies/grok-proxy/README.md)

## 0.3.7

首次公开发布：2026-10-07T07:19:09Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.7)：2026-10-07T07:19:09Z。
- 对应 CLI：1.0.41（Manifest 兼容声明，不是本机状态）。

### 变更

- 修复会话配置与 Turn 配置边界、模型切换、原生事件和交互投影；Question 取消仅按明确声明动作免除必填答案。Fork 只在原生 CLI 确认支持时开放。独立包使用公开 Proxy Protocol SDK 1.0.2，线协议范围不变，受管 Grok CLI 仍为 1.0.41。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.7) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-grok-v0.3.7/packages/proxies/grok-proxy/README.md)

## 0.3.6

首次公开发布：2026-09-25T11:45:02Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.6)：2026-09-25T11:45:02Z。
- 对应 CLI：1.0.41（Manifest 兼容声明，不是本机状态）。

### 修复

- 将受管 Grok Runtime 与 Proxy 发布到同一受信任的 GitHub Release，使已发布 Gian 能通过 Catalog 下载和验证。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.6)

## 0.3.5

首次公开发布：2026-09-25T11:27:45Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.5)：2026-09-25T11:27:45Z。
- 对应 CLI：1.0.41（Manifest 兼容声明，不是本机状态）。

### 新增

- Grok 4.7 真实会话支持本地文件、工具审批、历史回放和结构化事件。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-grok-v0.3.5)

### 变更

- 对 Grok CLI 1.0.41 的 x.ai 扩展按真实方法能力收窄；未注册的 Steer、Rename、Fork、Side Chat 和原生删除不会在 Catalog 中宣告。 [依据](https://github.com/RichLogic/Gian-Proxies/commit/c458424b5030bb93dd7d127fa5d091ec127e6bbd)

### 修复

- 交互响应可在活动 Turn 期间并发处理，避免工具审批阻塞请求循环。 [依据](https://github.com/RichLogic/Gian-Proxies/commit/10d4d7c0b60632c5cd53c8da6661020052f5a177)

## 已撤回版本

无。
