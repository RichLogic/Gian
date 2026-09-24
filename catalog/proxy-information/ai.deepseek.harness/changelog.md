# DeepSeek Harness：版本更新

本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。

本次发布组合快照：Proxy **0.3.2**，Runtime **0.1.5-rc.3**。这是发布目标，不表示当前机器已安装。

## 0.3.2

首次公开发布：2026-09-24T09:39:31Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.2)：2026-09-24T09:39:31Z。
- 对应 CLI：0.1.5-rc.3（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.4（当前归档对应的源码包）。

### 修复

- 适配 DeepSeek Harness 0.1.5-rc.3，内置 Bridge 0.1.4，恢复流式文本与思考输出，并保持握手版本与发布包一致。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.2) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/4740fab7dc3370cc812984519b5e9509bbcad2c0/CHANGELOG.md)

## 0.3.1

首次公开发布：2026-09-17T00:57:06Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.3.1)：2026-09-17T00:57:06Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.3（该公开 tag 的源码包）。
- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.1)：2026-09-20T09:48:24Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.3（当前归档对应的源码包）。

### 变更

- 受管 Runtime 标识采用 deepseek-harness，配合内容寻址目录布局。 [依据](https://github.com/RichLogic/Gian/commit/9683495bfcc8980a3b48886b88d30e24b5f0df9e)
- 准备并校验 gian profile 后再启动 DSH；JavaScript 入口由 Node 启动。 [依据](https://github.com/RichLogic/Gian-Proxies/blob/proxy-dsh-v0.3.1/packages/proxies/dsh-proxy/src/runtime/profile.ts)

### 注意事项

- 2026-09-20 新仓库分发自带 Bridge 0.1.3，并优先使用包内 Bridge。该分发归档与旧仓库同版本按各自摘要识别，不假定字节相同。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.1)

## 0.3.0

首次公开发布：2026-09-16T03:41:20Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.3.0)：2026-09-16T03:41:20Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.3（该公开 tag 的源码包）。

### 新增

- 提供 Proxy-owned runtime.install.plan v1，使受管 Runtime 安装配方随 Proxy 交付。 [依据](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.1.7

首次公开发布：2026-09-15T06:09:34Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.7)：2026-09-15T06:09:34Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.3（该公开 tag 的源码包）。

### 变更

- 发布新的补丁身份供受管安装使用，避免重写既有不可变制品。 [依据](https://github.com/RichLogic/Gian/commit/45b222b7ae789b1f92ae6424090a8b6bd11b6545)

## 0.1.6

首次公开发布：2026-09-13T09:17:12Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.6)：2026-09-13T09:17:12Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.3（该公开 tag 的源码包）。

### 变更

- Manifest 声明的协议范围由 >=2.1 <3.0 调整为 >=2.2 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.5/gian-proxy-dsh-0.1.5-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.6/gian-proxy-dsh-0.1.6-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 3 调整为 Schema 4。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.5/gian-proxy-dsh-0.1.5-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.6/gian-proxy-dsh-0.1.6-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.1.5

首次公开发布：2026-09-02T05:39:38Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.5)：2026-09-02T05:39:38Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.2（该公开 tag 的源码包）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.1.4

首次公开发布：2026-09-01T10:18:41Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.4)：2026-09-01T10:18:41Z。
- 对应 CLI：0.1.1-rc.2（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.1（该公开 tag 的源码包）。

### 变更

- 更新 DSH Provider 路由适配，声明对应 Runtime 0.1.1-rc.2。 [依据](https://github.com/RichLogic/Gian/commit/de9e3b6363968eea35b4969933aa91ec1db17c7d)

## 0.1.3

首次公开发布：2026-08-28T08:43:41Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.3)：2026-08-28T08:43:41Z。
- 对应 CLI：0.1.0-rc.7（Manifest 兼容声明，不是本机状态）。 Bridge：0.1.0（该公开 tag 的源码包）。

### 变更

- Manifest 声明的协议范围由 >=2.0 <3.0 调整为 >=2.1 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.1/gian-proxy-dsh-0.1.1-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.3/gian-proxy-dsh-0.1.3-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 2 调整为 Schema 3。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.1/gian-proxy-dsh-0.1.1-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.3/gian-proxy-dsh-0.1.3-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.1.1

首次公开发布：2026-08-24T09:36:37Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.1)：2026-08-24T09:36:37Z。
- 对应 CLI：0.1.0-rc.7（历史推荐声明，不是本机状态）。 Bridge：0.1.0（该公开 tag 的源码包）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.1.0

首次公开发布：2026-08-23T04:04:31Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.0)：2026-08-23T04:04:31Z。
- 对应 CLI：0.1.0-rc.7（历史推荐声明，不是本机状态）。 Bridge：0.1.0（该公开 tag 的源码包）。

### 新增

- 保留的公开记录中的首次独立 Proxy 发行。 [依据](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.0)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 已撤回版本

0.4.0 已于 2026-09-20 撤回，不进入可用版本列表。仓库拆分不构成统一升级所有 Proxy 版本的理由。
