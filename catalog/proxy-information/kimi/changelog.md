# Kimi Code：版本更新

本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。

本次发布组合快照：Proxy **0.4.4**，Runtime **2.1.1**。这是发布目标，不表示当前机器已安装。

## 0.4.4

首次公开发布：2026-09-30T08:50:47Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.4)：2026-09-30T08:50:47Z。
- 对应 CLI：2.1.1（Manifest 兼容声明，不是本机状态）。

### 变更

- 按原生 step 分开投影助手文本和思考，工具结果保持命令、文件和搜索呈现；修复复用 durable seq 的 volatile 帧与 Usage 事件身份。已完成 Turn 后的空闲会话支持 Fork 和 Sidechat，指定 Turn 的 Fork 仍不可用。本版不改变 Proxy 线协议，也不改变 Kimi Code 2.1.1 Runtime。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.4) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.4/packages/proxies/kimi-proxy/README.md)

## 0.4.3

首次公开发布：2026-09-28T15:28:15Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.3)：2026-09-28T15:28:15Z。
- 对应 CLI：2.1.1（Manifest 兼容声明，不是本机状态）。

### 变更

- 模型目录未变时保留已经返回的 Catalog revision，因此切换模型可以刷新可用的 reasoning，而不再拒绝仍然有效的 revision；底层模型目录变化时必须重新调用 catalog.list。本版不改变 Proxy 线协议，也不改变 Kimi Code 2.1.1 Runtime。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.3) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.3/packages/proxies/kimi-proxy/README.md)

## 0.4.2

首次公开发布：2026-09-27T03:23:17Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.2)：2026-09-27T03:23:17Z。
- 对应 CLI：2.1.1（Manifest 兼容声明，不是本机状态）。

### 变更

- 以 0.4.2 重新签发：能力面与 0.4.1 完全一致（Kimi Code 2.1.1 本地 Server API），仅更新版本标识，无功能变更。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.2) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.2/packages/proxies/kimi-proxy/README.md)

## 0.4.1

首次公开发布：2026-09-26T12:48:07Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.1)：2026-09-26T12:48:07Z。
- 对应 CLI：2.1.1（Manifest 兼容声明，不是本机状态）。

### 变更

- 改用 Kimi Code 2.1.1 本地 Server API，支持原生会话管理、Steer、结构化交互及计划和 Diff 事件；不再使用 ACP 子进程。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.1) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.1/packages/proxies/kimi-proxy/README.md)

## 0.3.3

首次公开发布：2026-09-24T09:39:35Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.3)：2026-09-24T09:39:35Z。
- 对应 CLI：2.1.0（Manifest 兼容声明，不是本机状态）。

### 修复

- 适配 Kimi Code 2.1.0，修复模型切换后的 thinking 选项和历史轮次身份；不再宣告上游未支持的原生重命名。 [依据1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.3) [依据2](https://github.com/RichLogic/Gian-Proxies/blob/4740fab7dc3370cc812984519b5e9509bbcad2c0/CHANGELOG.md)

## 0.3.2

首次公开发布：2026-09-20T09:48:27Z（UTC）。

- [RichLogic/Gian-Proxies 分发](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.2)：2026-09-20T09:48:27Z。
- 对应 CLI：0.41.0、2.0.0（Manifest 兼容声明，不是本机状态）。

### 变更

- 不再以旧 session-store 版本下限直接阻断会话；恢复失败必须保持可解释状态，不声称所有旧历史都兼容。 [依据](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.3.2/packages/proxies/kimi-proxy/src/runtime/session-store.ts)

### 修复

- 为 Session 级 ACP 请求增加有界等待，并处理失效的原生 attach 绑定。 [依据](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.3.2/packages/proxies/kimi-proxy/src/runtime/kimi-acp-client.ts)
- 不把遗留 role 字段带入新的 Turn 配置选项。 [依据](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.3.2/packages/proxies/kimi-proxy/src/protocol/v2-adapter.ts)

### 注意事项

- Manifest 声明 0.41.0、2.0.0；Catalog 1.7.0 实际选择 2.0.0。兼容声明不等于当前安装版本。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/catalog-v1.7.0)
- 2026-09-20 从 Gian-Proxies 分发；这是来源/制品记录，不是另一个 Proxy 版本。 [依据](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.2)

## 0.3.1

首次公开发布：2026-09-17T00:56:47Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.3.1)：2026-09-17T00:56:47Z。
- 对应 CLI：0.41.0（Manifest 兼容声明，不是本机状态）。

### 修复

- 修正 CLI 0.41 用量读取与上下文计量路径，避免只依赖旧 /status 文本。 [依据](https://github.com/RichLogic/Gian/commit/9683495bfcc8980a3b48886b88d30e24b5f0df9e)

## 0.3.0

首次公开发布：2026-09-16T03:41:22Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.3.0)：2026-09-16T03:41:22Z。
- 对应 CLI：0.41.0（Manifest 兼容声明，不是本机状态）。

### 新增

- 提供 Proxy-owned runtime.install.plan v1，使受管 Runtime 安装配方随 Proxy 交付。 [依据](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.2.10

首次公开发布：2026-09-13T09:24:28Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.10)：2026-09-13T09:24:28Z。
- 对应 CLI：0.41.0（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.1 <3.0 调整为 >=2.2 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.7/gian-proxy-kimi-0.2.7-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.10/gian-proxy-kimi-0.2.10-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 3 调整为 Schema 4。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.7/gian-proxy-kimi-0.2.7-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.10/gian-proxy-kimi-0.2.10-darwin-arm64.tar.gz.manifest.json)

### 修复

- 在终端退出后继续排空最后的输出，避免丢失尾部内容。 [依据](https://github.com/RichLogic/Gian/commit/2e76e40342846c977c23bae74246ee4bba78a37c)

## 0.2.7

首次公开发布：2026-09-02T05:32:33Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.7)：2026-09-02T05:32:33Z。
- 对应 CLI：0.38.0（Manifest 兼容声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.6

首次公开发布：2026-09-01T07:22:30Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.6)：2026-09-01T07:22:30Z。
- 对应 CLI：0.38.0（Manifest 兼容声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.3

首次公开发布：2026-08-28T08:43:44Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.3)：2026-08-28T08:43:44Z。
- 对应 CLI：0.31.1（Manifest 兼容声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=2.0 <3.0 调整为 >=2.1 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.2/gian-proxy-kimi-0.2.2-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.3/gian-proxy-kimi-0.2.3-darwin-arm64.tar.gz.manifest.json)
- Manifest 从 Schema 2 调整为 Schema 3。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.2/gian-proxy-kimi-0.2.2-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.3/gian-proxy-kimi-0.2.3-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。

## 0.2.2

首次公开发布：2026-08-25T08:08:32Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.2)：2026-08-25T08:08:32Z。
- 对应 CLI：0.31.1（历史推荐声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.2.1

首次公开发布：2026-08-24T09:36:37Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.1)：2026-08-24T09:36:37Z。
- 对应 CLI：0.31.1（历史推荐声明，不是本机状态）。

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.2.0

首次公开发布：2026-08-23T04:12:30Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.0)：2026-08-23T04:12:30Z。
- 对应 CLI：0.31.1（历史推荐声明，不是本机状态）。

### 变更

- Manifest 声明的协议范围由 >=1.0 <2.0 调整为 >=2.0 <3.0。 [依据1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.1.0/gian-proxy-kimi-0.1.0-darwin-arm64.tar.gz.manifest.json) [依据2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.0/gian-proxy-kimi-0.2.0-darwin-arm64.tar.gz.manifest.json)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 该历史 Runtime 值来自 recommendedCliVersion，只能显示为推荐声明，不代表完整组合认证。

## 0.1.0

首次公开发布：2026-08-12T09:07:10Z（UTC）。

- [RichLogic/Gian 分发](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.1.0)：2026-08-12T09:07:10Z。
- 对应 CLI：未记录（未记录 CLI 版本，不是本机状态）。

### 新增

- 保留的公开记录中的首次独立 Proxy 发行。 [依据](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.1.0)

### 历史证据边界

- 原 Release 未提供可独立归因的完整用户变更说明；本记录只列已证实的发行/Manifest 事实，不把整仓库 compare 内容当作此 Proxy 的新增或修复。
- 此版本公开 Manifest 未记录 CLI 版本，不能反向套用当前 CLI 版本。

## 已撤回版本

- 0.4.0：2026-09-20 已撤回，不可安装。[依据](https://github.com/RichLogic/Gian-Proxies/blob/51dc9e3ac2aa8a1430abf353b898de2e0df6f1d2/CHANGELOG.md)
