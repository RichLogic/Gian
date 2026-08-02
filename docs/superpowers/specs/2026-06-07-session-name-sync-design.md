# 设计：把 Gian 会话名同步成 Claude / Codex 原生会话名

- 需求 ID：**SESSION-NAME-001**
- 日期：2026-06-07
- 状态：**已实现**（2026-06-07，本 spec 即计划）。代码全落、host 503/503 + cc-proxy 32/32 +
  codex-proxy 73/73 + 5 包 typecheck/build 干净。待真机验 §8（RC/resume 列表是否即时反映）。
- 范围：Claude（结构化 + TTY/Beta）+ Codex（app-server）

---

## 1. 背景与动机

Gian 的每个会话有自己的名字（`sessions.name`，可空，用户手填），改名链路也完整
（`renameSession()` `packages/host/src/session/manager.ts:874` ← WS `session:rename`
`packages/shared/src/web.ts:379`）。但这个名字**只存在 Gian 自己的 DB**，从不下传给底层
Claude / Codex 会话。于是在 **Claude Remote Control / `claude --resume` 列表** 与
**Codex（app / `codex resume`）列表** 里，会话显示的都是各自自动生成的名字，
**远程操控时认不出哪个是哪个**。本设计让"改 Gian 名字"顺带把底层名字也改掉。

### 调研结论（地面验证，非记忆）

| 层面 | 名字载体 | 怎么程序化设 | 验证 |
|---|---|---|---|
| **Gian** | `sessions.name`（可空） | `renameSession()` 已有 | 读代码 |
| **Claude Code** v2.1.168 | JSONL 里一行 `{"type":"custom-title","customTitle":<名>,"sessionId":<uuid>}`（优先于自动 `ai-title`，显示在 prompt box / `/resume` picker） | ① `--name <名>` spawn flag；② 直接往 JSONL 追加该行 | `claude --help`；spike 实测 `-p --name` 写 custom-title；读真实 JSONL 确认整行结构 |
| **Codex** codex-cli 0.132+ | `Thread.name` | app-server RPC **`thread/name/set { threadId, name }`**（返回空，服务端回推 `ThreadNameUpdatedNotification`） | `codex app-server generate-ts` 导出权威协议 |

> **关键设计依据**：`packages/host/src/native/replay.ts` 的 `parseCcLine` 对**非 user/assistant 行
> 一律返回 null**（`:255`）。所以追加一行 `custom-title` meta，Gian 的 JSONL watcher / replay
> **完全忽略**——零事件、零 transcript 行、零 status 翻转。这让"直接写一行"成为最干净的改名方式，
> 而不是起一个真跑模型、还会产生 turn/status/inbox 涟漪的 `claude -p`。

---

## 2. 已确认的需求决策

1. **同步时机**：改名（`renameSession`）+ 创建带名。**不回填**旧会话。
2. **名字格式**：原样用 Gian 名字。Gian 名为空时**不设**底层名字（留给自动名）；也**不主动清除**已设的底层名（已知限制）。
3. **Claude 改名机制 = 直接往会话 JSONL 追加 `custom-title` 行**（立即、免费、零涟漪、结构化/TTY 统一、不分叉对话）。
4. **Claude 创建带名 / 首 turn 前改名 = 首 turn 的 `--name`**：JSONL 在第一个 `claude -p --session-id` 跑之前还不存在，
   所以这两种情况靠首 turn（cc-proxy `--session-id` 分支）/ TTY 首次 spawn 带 `--name` 覆盖。
5. **Codex 改名/创建 = `thread/name/set`**（立即生效，空闲/运行都行，无 junk turn）。
6. **覆盖运行模式**：Claude 结构化 + Claude TTY/Beta + Codex。

---

## 3. 架构与数据流

唯一状态源仍是 host 的 `sessions.name`；proxy 不持久化名字。host 是唯一驱动方，
按 executor + "JSONL 是否已存在" 路由。

### 3.1 Claude — 改名（JSONL 已存在）

- `renameSession()` 落库 + 广播后，对 claude 会话：用 `locate-jsonl` 按 `native_session_id` + cwd
  定位 JSONL；若文件存在 → 追加一行
  `{"type":"custom-title","customTitle":<trim 后的名>,"sessionId":<claudeSessionId>}\n`。
- 立即生效、对结构化和 TTY **统一**（同一个 JSONL 文件）；meta 行不是 turn、无 parentUuid、不分叉，
  与活着的 interactive claude 并存安全（POSIX append 原子；活进程下次读文件 / picker 时才反映，正合需求）。

### 3.2 Claude — 创建带名 / 首 turn 前改名（`--name`）

- cc-proxy `buildClaudeArgs`（`packages/proxies/cc-proxy/src/runtime/claude-mcp-runtime.ts:671`）
  在 **`--session-id` 首 turn 分支**（`!session.hasHadFirstTurn`）且 `displayName` 非空时
  `args.push('--name', displayName)`。host 发首 turn 时读当下 `sessions.name` 传 `displayName`。
- 只在首 turn 带 `--name`，**resume turn 不带**——避免直接写过名字后又被旧 `--name` 覆盖（无 revert 风险）。
- TTY：首次 / 任意 spawn 时按当下 `sessions.name` 加 `--name`（读 fresh，不 revert）。
- 因此 `renameSession()` 对**还没有 JSONL**（首 turn 未跑）的 claude 会话**不做任何事**——
  即将到来的首 turn 的 `--name` 会带上新名。

### 3.3 Codex（app-server，codex-proxy）

- codex-proxy 新增 host-facing 方法 `session.setName` → 内部对 app-server 发 RPC
  `thread/name/set { threadId, name }`。
- host `codex-proxy-client` 暴露 `setName(name)`；`renameSession()` 对 codex 直接调用 —— 立即生效。
- 创建：`thread/start` 不带 name（已确认 `ThreadStartParams` 无 name 字段），host 在 `createSession`
  拿到 `threadId` 后若名字非空，紧跟一次 `setName`。

### 3.4 触发点汇总

| 事件 | Claude（已有 JSONL） | Claude（首 turn 前 / 创建带名） | Codex |
|---|---|---|---|
| **创建带名** | （首 turn 还没跑）→ 见右 | 首 turn `--session-id` 带 `--name` / TTY spawn `--name` | `thread/start` 后 `thread/name/set` |
| **改名** | 追加 `custom-title` 行（立即） | 无操作，由即将到来的首 turn `--name` 覆盖 | `thread/name/set`（立即） |

统一入口：`renameSession()`。create 路径在各自首 turn / createSession 处覆盖。

---

## 4. 组件改动清单（按文件）

### Claude
- `packages/host/src/native/locate-jsonl.ts` — 复用其按 (cwd, claudeSessionId) 定位 JSONL 的能力
  （如需，导出一个返回路径的纯函数）。
- `packages/host/src/session/manager.ts` —
  - 新私有 helper `writeClaudeCustomTitle(claudeSessionId, cwd, name)`：定位 + `appendFile` 一行。
  - `renameSession()`：claude 且 JSONL 存在 → 调上面 helper；codex → `codexProxyClient.setName`；
    claude 但无 JSONL → 跳过。
  - 发首 turn 时把 trim 后的 `sessions.name` 作为 `displayName` 传给 cc-proxy（仅首 turn）。
  - `createSession()`：codex 拿到 threadId 后若名字非空调 `setName`（claude 走首 turn `--name`，此处无需）。
- `packages/proxies/cc-proxy/src/runtime/claude-mcp-runtime.ts` — `buildClaudeArgs` 加 `displayName?`，
  仅首 turn 分支 `--name`。
- `packages/proxies/cc-proxy/src/core/{types,service}.ts` — per-turn 参数加可选 `displayName`，透传 runtime。
- `packages/host/src/proxy/cc-proxy-client.ts`（+ `proxy/types.ts`）— 发首 turn 带 `displayName`。
- `packages/host/src/tty/manager.ts` — claude spawn 参数按 `sessions.name` 加 `--name`。

### Codex
- `packages/proxies/codex-proxy/src/runtime/codex-app-server-client.ts` — 发 `thread/name/set` 的封装。
- `packages/proxies/codex-proxy/src/core/{types,service}.ts` — host-facing `session.setName`，解析 sessionId → threadId。
- `packages/host/src/proxy/codex-proxy-client.ts`（+ `proxy/types.ts`）— 暴露 `setName(name)`。

> `proxy/types.ts` 的 `ProxyClient` 接口：codex 加 `setName(name)`；cc 的 turn 入参加可选 `displayName`。
> 具体形状实现时定，遵循现有 cc/codex client 分工。**不需要** SENTINEL、watcher 过滤、`/rename` 注入。

---

## 5. 错误处理 / 边界

- **空名**：claude 跳过追加 / 首 turn 不带 `--name`；codex 跳过 `thread/name/set`；都不清除已有底层名。
- **名字含换行 / CR / 引号**：
  - `custom-title` 行用 `JSON.stringify` 编码整行——引号/换行/unicode 天然安全；仍 strip 控制字符并限长。
  - `--name`：argv 数组元素（spawn 非 shell），strip 换行 + 限长。
  - Codex `thread/name/set`：JSON 字符串，安全；同样 strip 控制字符 + 限长保持一致。
- **JSONL 不存在**（首 turn 未跑）：改名跳过追加，由首 turn `--name` 覆盖；不创建孤儿文件。
- **native_session_id 为空**（极早期）：跳过；首 turn / createSession 覆盖。
- **并发**：追加 meta 行与活着的 claude（-p turn 或 interactive TTY）并存安全——非 turn、不分叉；
  POSIX append 原子。活进程下次读文件 / picker 时反映。
- **非目标**：本轮只动 claude / codex。

---

## 6. 测试

- **host**：
  - `writeClaudeCustomTitle`：定位到正确 JSONL 并追加格式正确的一行（`JSON.parse` 回读校验 type/customTitle/sessionId）；
    文件不存在时不写（不建孤儿）；空名不写；CR/LF/引号被正确编码。
  - `renameSession` 路由：claude+JSONL 存在 → 追加；claude+无 JSONL → 跳过；codex → `setName`；空名 → 不动底层。
  - cc-proxy-client 发**首** turn 带 trim 后的 `displayName`（resume turn 不带；空名不带）。
  - `createSession`：codex 带名 → 创建后 `setName`；claude 带名 → 首 turn `displayName`。
  - 回归：含 `custom-title` 行的 JSONL 经 replay/watcher **不产生**任何 event/turn（锁定 §1 依据）。
- **cc-proxy 单测**：`buildClaudeArgs` 仅首 turn 分支在有 `displayName` 时出现 `--name`；resume 分支不出现；空名不出现。
- **codex-proxy 单测**：`session.setName` → mock app-server 收到 `thread/name/set { threadId, name }`。
- `docs/quality/traceability.md` 加 **SESSION-NAME-001** 行。

---

## 7. 本轮明确不做

- 回填旧会话；Gian 名清空时反向清除底层名；反向同步（自动名回灌 Gian）。
- Claude **Remote Control 专属命名**（`--remote-control [name]`）：若实测发现 RC 列表读的不是 `custom-title`
  而是 RC 专属名，再单开一轮；本轮押 `custom-title`（`-n/--name` help 明确含 "/resume picker"）。

---

## 8. 待实现阶段确认的实测点

1. 追加 `custom-title` 行后，`claude --resume` picker / Remote Control 列表是否即时反映（决定 §7 那条要不要补）。
2. Codex `thread/name/set` 改名后，`codex resume` / Codex app 列表是否即时反映。
