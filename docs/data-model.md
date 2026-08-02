# 数据模型

> 版本 0.3 · 2026-07-31
>
> SQLite 单文件数据库，路径 `$GIAN_DATA_DIR/gian.db`（默认
> `~/.config/gian/gian.db`）。顺序 migration 是物理 schema 的唯一权威；
> 本文记录当前运行时所有权和核心关系，不复制容易过期的完整 DDL。

## 当前表清单

| 表 | 所有者 | 用途 |
|---|---|---|
| `migrations` | storage | 已执行 migration 文件 |
| `workspaces` | workspace | workspace 名称、根路径、隐藏/置顶/排序等 |
| `sessions` | session | 所有 Web/Task/IM 会话的 canonical 状态 |
| `turns` | session | transcript turn hot cache |
| `events` | session | 归一化 event hot cache |
| `approvals` | approval | 待决和已解决审批 |
| `queue_entries` | queue | session busy 时的 canonical FIFO |
| `tasks` | task | Task/Manager 容器 |
| `task_loops` | task | PM/engineer loop 状态和授权边界 |
| `task_actions` | task | Gian action 幂等执行台账 |
| `config` | storage | 系统和用户配置 |
| `discord_bots` | IM/Discord | Discord bot 配置及选中 session |
| `discord_inbound_events` | IM/Discord | inbound event 去重 |
| `discord_outbox` | IM/Discord | Discord 发送重试状态 |
| `slack_bots` | IM/Slack | Slack bot 配置及选中 session |
| `slack_inbound_events` | IM/Slack | inbound event 去重 |
| `slack_outbox` | IM/Slack | Slack 发送重试状态 |
| `bots` | migration only | 旧版统一 bot 表，仅供一次性平台迁移读取 |

不存在运行时 `tokens` 或 `queue` 表。migration 041 删除了这两个从未承载
产品路径的旧表；登录使用内存 session token，消息队列使用
`queue_entries`。

## Canonical 关系

```text
workspaces 1 ── N sessions 1 ── N turns 1 ── N events
                    │  │             │
                    │  ├── N approvals
                    │  └── N queue_entries
                    │
tasks 1 ── N sessions(type=manager|subtask)
  │                 │
  ├── 0..1 task_loops
  └── N task_actions ── N:1 sessions

discord_bots/slack_bots ── selected_session_id ──▷ sessions
discord_outbox/slack_outbox ── session_id ──────▷ sessions
```

Host 是唯一 session 状态所有者。Discord/Slack 不再维护自己的 coding
session、turn 或 queue；migration 039 已删除这些重复表。平台表只拥有
transport 配置、dedupe 和 outbox。

## `sessions`

`sessions` 是产品的核心记录，主要字段分为：

| 分组 | 字段 |
|---|---|
| identity | `id`, `name`, `type`, `workspace_id`, `task_id`, `parent_session_id` |
| executor | `executor`, `model`, `approval_mode`, `executor_config`, `thinking_effort`, `service_tier` |
| lifecycle | `status`, `archived`, `unread`, `pinned_at`, `active_channel`, timestamps |
| worktree | `worktree_path`, `detected_worktree_path`, `branch`, `base_branch`, `worktree_outcome` |
| native | `native_session_id`, pending fork/native adoption state |
| usage | current context and cumulative conversation counters |
| task | role/summary/completion and Manager/Subtask metadata |

`worktree_path` 是 Gian 创建并拥有的执行 worktree。`detected_worktree_path`
是 agent 在会话中执行 `git worktree add` 后检测到的外部 worktree，只用于
Web 视图自动切换，不改变 executor cwd。

旧数据库仍可能有 `runtime_mode`、`turns` 和 `tty_turn_seq` 兼容列。
ADR-0008 移除了所有 session TTY 与 Job Mode；migration 038 将这些列
归一，应用模型不再读取、写入或暴露它们。

## Transcript cache

`turns` 和 `events` 是可重建的 hot cache：

- proxy 原始通知先由 `event/normalize-{cc,codex,kimi}.ts` 归一化；
- 流式 delta 只在内存/WS 中存在，完成态才持久化；
- cold session 可清空 turn/event cache，但保留 `sessions`；
- Claude/Codex native JSONL 可通过 replay 重建 cache。

因此 `events` 不是第二份 provider 原始日志，也不应存放 platform 私有
payload 作为长期真相。

## Queue 与审批

`queue_entries` 按 `session_id, sort_order` 提供唯一 FIFO。Web、Task、
Discord 和 Slack 都调用同一 QueueManager，不存在 platform queue。

`approvals` 同样由 Host 统一持久化。provider-native option id 可随记录
保存并原样返回 executor；平台 adapter 不重新解释审批策略。

## IM 表

`discord_bots` / `slack_bots` 保存平台连接配置、状态和
`selected_session_id`。凭据由平台 secrets helper 加密。

每个平台的：

- `*_inbound_events` 防止 webhook/socket 重放重复执行；
- `*_outbox` 跟踪 transport 发送与重试，可选引用 canonical session；
- 不保存 Gian turn、queue、model 或 approval 的镜像。

旧 `bots` 表不能在 SQL migration 中提前删除，因为升级旧安装时仍需读取
并迁移加密/明文兼容数据。它不是新写入路径。

## 登录与配置

密码 hash 和用户名保存在 `config`。`gian_session` token 只存在于 Host
内存，Host 重启即失效；这正是当前登录语义，不需要 token 表。

早期 seed 的 Tunnel 配置 key 可能留在旧数据库中，但 Tunnel 功能已移除，
当前 `SystemConfig` 不读取或写入它们。

## 迁移规则

迁移位于 `packages/host/migrations/NNN_*.sql`，按文件名排序且每个文件只
执行一次。需要在事务外切换 SQLite FK 行为的表重建 migration 使用
`-- migration:no-transaction` 标记。

删除代码前必须区分：

1. 当前运行时表；
2. 可重建 cache；
3. 仅用于旧版本升级的 migration source。

第三类看似无调用，仍可能是升级兼容边界，不能只凭静态引用删除。
