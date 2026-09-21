# Codex：版本更新

本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。

当前 Catalog 1.7.0 选择：Proxy **0.3.1**，Runtime **0.153.4**。这是发布目标，不表示当前机器已安装。

## 0.3.1

首次公开发布：2026-09-17T00:56:25Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.3.1)：2026-09-17T00:56:25Z。
- 对应 CLI：0.153.4（Manifest 兼容声明，不是本机状态）。
- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.1)：2026-09-20T09:48:19Z。
- 对应 CLI：0.153.4（Manifest 兼容声明，不是本机状态）。

### 变更

- 对齐 Proxy 包、Manifest 与内嵌自检的版本身份；CLI 兼容声明仍为 0.153.4。 [依据](https://github.com/RichLogic/Gian/commit/c9b037a72c881eefa2ec2474a2591b1c142de563)

### 注意事项

- 2026-09-20 从 Gian-Proxies 分发；这是来源/制品记录，不是另一个 Proxy 版本。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.1)

## 0.3.0

首次公开发布：2026-09-16T03:41:37Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.3.0)：2026-09-16T03:41:37Z。
- 对应 CLI：0.153.4（Manifest 兼容声明，不是本机状态）。

### 新增

- 提供 Proxy-owned runtime.install.plan v1，使受管 Runtime 安装配方随 Proxy 交付。 [依据](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.2.16

首次公开发布：2026-09-14T03:54:07Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.16)：2026-09-14T03:54:07Z。
- 对应 CLI：0.153.4（Manifest 兼容声明，不是本机状态）。

### 变更

- 声明并交付支持新模型目录的 Codex CLI 0.153.4，替代前一版的 0.146.0 目标。 [依据](https://github.com/RichLogic/Gian/commit/a30d42a33d7665f2f809841a99d643a0459b63a1)

## 0.2.15

首次公开发布：2026-09-13T09:22:54Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.15)：2026-09-13T09:22:54Z。
- 对应 CLI：0.146.0（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.1 <3.0 调整为 >=2.2 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.12/gian-proxy-codex-0.2.12-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.15/gian-proxy-codex-0.2.15-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 3 调整为 Schema 4。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.12/gian-proxy-codex-0.2.12-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.15/gian-proxy-codex-0.2.15-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.12

首次公开发布：2026-09-02T05:31:19Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.12)：2026-09-02T05:31:19Z。
- 对应 CLI：0.146.0（Manifest 兼容声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.11

首次公开发布：2026-09-01T07:21:48Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.11)：2026-09-01T07:21:48Z。
- 对应 CLI：0.146.0（Manifest 兼容声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.10

首次公开发布：2026-08-28T08:43:40Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.10)：2026-08-28T08:43:40Z。
- 对应 CLI：0.146.0（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.0 <3.0 调整为 >=2.1 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.3/gian-proxy-codex-0.2.3-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.10/gian-proxy-codex-0.2.10-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 2 调整为 Schema 3。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.3/gian-proxy-codex-0.2.3-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.10/gian-proxy-codex-0.2.10-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.3

首次公开发布：2026-08-25T08:08:20Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.3)：2026-08-25T08:08:20Z。
- 对应 CLI：0.146.0（历史推荐声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.2.1

首次公开发布：2026-08-24T09:36:43Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.1)：2026-08-24T09:36:43Z。
- 对应 CLI：0.146.0（历史推荐声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.2.0

首次公开发布：2026-08-23T04:13:01Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.0)：2026-08-23T04:13:01Z。
- 对应 CLI：0.146.0（历史推荐声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=1.0 <2.0 调整为 >=2.0 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.1.0/gian-proxy-codex-0.1.0-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.0/gian-proxy-codex-0.2.0-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.1.0

首次公开发布：2026-08-12T09:07:02Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.1.0)：2026-08-12T09:07:02Z。
- 对应 CLI：未记录（未记录 CLI 版本，不是本机状态）。

### 新增

- 保留的公开记录中的首次独立 Proxy 发行。 [依据](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.1.0)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 此版本公开 Manifest 未记录 CLI 版本，不能反向套用当前 CLI 版本。

## 已撤回版本

0.4.0 已于 2026-09-20 撤回，不进入可用版本列表。仓库拆分不构成统一升级所有 Proxy 版本的理由。
