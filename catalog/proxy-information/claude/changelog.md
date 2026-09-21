# Claude Code：版本更新

本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。

当前 Catalog 1.7.0 选择：Proxy **0.3.1**，Runtime **2.1.159**。这是发布目标，不表示当前机器已安装。

## 0.3.1

首次公开发布：2026-09-17T00:56:19Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.3.1)：2026-09-17T00:56:19Z。
- 对应 CLI：2.1.159（Manifest 兼容声明，不是本机状态）。
- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.1)：2026-09-20T09:48:17Z。
- 对应 CLI：2.1.159（Manifest 兼容声明，不是本机状态）。

### 变更

- 对齐 Proxy 包、Manifest 与内嵌自检的版本身份；CLI 兼容声明仍为 2.1.159。 [依据](https://github.com/RichLogic/Gian/commit/c9b037a72c881eefa2ec2474a2591b1c142de563)

### 注意事项

- 2026-09-20 从 Gian-Proxies 分发；这是来源/制品记录，不是另一个 Proxy 版本。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.1)

## 0.3.0

首次公开发布：2026-09-16T03:41:14Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.3.0)：2026-09-16T03:41:14Z。
- 对应 CLI：2.1.159（Manifest 兼容声明，不是本机状态）。

### 新增

- 提供 Proxy-owned runtime.install.plan v1，使受管 Runtime 安装配方随 Proxy 交付。 [依据](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.2.5

首次公开发布：2026-09-15T06:09:32Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.5)：2026-09-15T06:09:32Z。
- 对应 CLI：2.1.159（Manifest 兼容声明，不是本机状态）。

### 变更

- 发布新的补丁身份供受管安装使用，避免重写既有不可变制品。 [依据](https://github.com/RichLogic/Gian/commit/45b222b7ae789b1f92ae6424090a8b6bd11b6545)

## 0.2.4

首次公开发布：2026-09-13T09:17:22Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.4)：2026-09-13T09:17:22Z。
- 对应 CLI：2.1.159（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.1 <3.0 调整为 >=2.2 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 3 调整为 Schema 4。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.3

首次公开发布：2026-08-28T08:43:43Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.3)：2026-08-28T08:43:43Z。
- 对应 CLI：2.1.159（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.0 <3.0 调整为 >=2.1 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.2/gian-proxy-claude-0.2.2-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 2 调整为 Schema 3。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.2/gian-proxy-claude-0.2.2-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.2

首次公开发布：2026-08-25T08:08:22Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.2)：2026-08-25T08:08:22Z。
- 对应 CLI：2.1.159（历史推荐声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.2.0

首次公开发布：2026-08-23T04:13:08Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.0)：2026-08-23T04:13:08Z。
- 对应 CLI：2.1.159（历史推荐声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=1.0 <2.0 调整为 >=2.0 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.1.1/gian-proxy-claude-0.1.1-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.0/gian-proxy-claude-0.2.0-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.1.1

首次公开发布：2026-08-14T14:12:59Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.1.1)：2026-08-14T14:12:59Z。
- 对应 CLI：2.1.159（历史推荐声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.1.0

首次公开发布：2026-08-12T09:07:19Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.1.0)：2026-08-12T09:07:19Z。
- 对应 CLI：未记录（未记录 CLI 版本，不是本机状态）。

### 新增

- 保留的公开记录中的首次独立 Proxy 发行。 [依据](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.1.0)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 此版本公开 Manifest 未记录 CLI 版本，不能反向套用当前 CLI 版本。

## 已撤回版本

0.4.0 已于 2026-09-20 撤回，不进入可用版本列表。仓库拆分不构成统一升级所有 Proxy 版本的理由。
