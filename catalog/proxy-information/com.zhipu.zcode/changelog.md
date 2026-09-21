# ZCode：版本更新

本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。

当前 Catalog 1.7.0 选择：Proxy **0.3.2**，Runtime **0.16.5**。这是发布目标，不表示当前机器已安装。

## 0.3.2

首次公开发布：2026-09-20T09:48:30Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.3.2)：2026-09-20T09:48:30Z。
- 对应 CLI：0.16.5（Manifest 兼容声明，不是本机状态）。

### 修复

- 缺少独立启动所需的内置 Provider 配置时，提前给出明确 readiness 诊断，而不是只暴露循环退出。 [依据](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.3.2/packages/proxies/zcode-proxy/src/runtime/discover.ts)

### 注意事项

- 不代表 ZCode.app 3.12.3 的原生方法与独立 Provider 初始化问题已修复，也不保证恢复缺失模型。 [依据](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.3.2/packages/proxies/zcode-proxy/src/runtime/discover.ts)
- 2026-09-20 从 Gian-Proxies 分发；这是来源/制品记录，不是另一个 Proxy 版本。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.3.2)

## 0.3.1

首次公开发布：2026-09-17T00:57:02Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.3.1)：2026-09-17T00:57:02Z。
- 对应 CLI：0.16.5（Manifest 兼容声明，不是本机状态）。

### 变更

- 恢复官方 Z.ai 标识并同步资源摘要；外部 Runtime 仍要求对应的 App 构建。 [依据](https://github.com/RichLogic/Gian/commit/9683495bfcc8980a3b48886b88d30e24b5f0df9e)

## 0.3.0

首次公开发布：2026-09-16T03:41:28Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.3.0)：2026-09-16T03:41:28Z。
- 对应 CLI：0.16.5（Manifest 兼容声明，不是本机状态）。

### 新增

- 提供 Proxy-owned runtime.install.plan v1，使受管 Runtime 安装配方随 Proxy 交付。 [依据](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.1.2

首次公开发布：2026-09-15T06:07:43Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.2)：2026-09-15T06:07:43Z。
- 对应 CLI：0.16.5（Manifest 兼容声明，不是本机状态）。

### 变更

- 发布新的补丁身份供受管安装使用，避免重写既有不可变制品。 [依据](https://github.com/RichLogic/Gian/commit/45b222b7ae789b1f92ae6424090a8b6bd11b6545)

## 0.1.1

首次公开发布：2026-09-13T09:32:18Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.1)：2026-09-13T09:32:18Z。
- 对应 CLI：0.16.5（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.1 <3.0 调整为 >=2.2 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.0/gian-proxy-zcode-0.1.0-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.1/gian-proxy-zcode-0.1.1-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 3 调整为 Schema 4。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.0/gian-proxy-zcode-0.1.0-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.1/gian-proxy-zcode-0.1.1-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.1.0

首次公开发布：2026-09-01T07:22:19Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.0)：2026-09-01T07:22:19Z。
- 对应 CLI：0.16.5（Manifest 兼容声明，不是本机状态）。

### 新增

- 保留的公开记录中的首次独立 Proxy 发行。 [依据](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.0)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 已撤回版本

0.4.0 已于 2026-09-20 撤回，不进入可用版本列表。仓库拆分不构成统一升级所有 Proxy 版本的理由。
