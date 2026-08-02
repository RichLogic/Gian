# Kimi Code ACP 接入与统一 CLI Runtime Manager - 设计方案

**日期：** 2026-07-28
**状态：** Reviewed；Kimi RuntimeManager/proxy/host/web vertical slice 已实现，Phase 0 真机稳定性门与 Phase 4/5 统一迁移仍进行中
**范围：** Gian 的 Claude Code、Codex CLI、Kimi Code CLI 统一二进制管理，
executor 原生配置直通，以及 Kimi Code 的 ACP structured runtime 接入。

---

## 1. 结论

Kimi Code 可以接入 Gian，主路径选择官方 `kimi acp`，不接旧 Python CLI /
Agent SDK，也不通过 TTY 抓屏解析 structured events。

这条路径没有架构级阻塞：

- ACP 是 stdin/stdout 上的 NDJSON JSON-RPC，适合放进 Gian 现有 proxy 层。
- 一个 `kimi acp` 进程可承载多个 Kimi session，拓扑与 Codex
  `app-server` 更接近，不需要每个 Gian session 启一个 Kimi 进程。
- `session/new`、`load`、`resume`、`prompt`、`cancel`、`list`、原生模式 /
  模型 / thinking 配置、工具审批都已具备。
- Kimi Code CLI 和 ACP adapter 均为 MIT 开源，可读源码、固定兼容版本，也可
  向上游补 `session/close`。

当前仍有 5 项必须在生产启用 Kimi 和自动更新前用真实 CLI 锁定。它们是
Phase 0 发布门，不影响先开发可隔离的 adapter、host/web vertical slice 或方案成立：

1. 同一 ACP 进程跨 session 的真实并发行为。
2. session 数量增长时的 RSS 曲线，以及没有 `session/close` 时的资源回收曲线。
3. Kimi 后台任务存在时，什么条件才能安全地做全局 idle shutdown。
4. 用户在外部终端 `kimi login` 后，既有 ACP 进程能否立即读到新凭据；若不能，
   是否只需重启 ACP 进程。
5. Claude / Codex / Kimi 三家的官方无交互下载源和完整性材料能否稳定用于
   managed install。三家禁用自更新的配置入口已找到，Phase 0 只需固化并验证。

统一架构不变，但 rollout 改为增量式，避免为了接 Kimi 先改动当前正常运行的
Claude / Codex 生产路径：

1. 建立 `CliRuntimeManager` kernel 与 Kimi provider，并让 Phase 0 真机 gate
   与可隔离的 contract/vertical-slice 开发并行。
2. Kimi 从第一天就使用 executor 原生配置，不写新的 `ApprovalMode` 映射。
3. 把 Kimi ACP 接到同一 proxy / event / session 框架；通过 Phase 0 和浏览器
   gate 后才生产启用。
4. 再把 Claude / Codex 分批迁到 RuntimeManager 和原生配置；最终仍由 Gian
   统一维护三套 CLI。

这样既不会为了赶 Kimi 新增以后还要拆的 mode 映射和 PATH 技术债，也不会让
一次大范围 Claude / Codex 迁移阻塞 Kimi 的首个可用版本。

---

## 2. 已验证的外部事实

调研基线为 Kimi Code 仓库
`de0ba9d0654273ff6b028a7a561983ebee4e723e`（2026-07-28）。

### 2.1 ACP 能力

当前 `kimi acp`：

| 能力 | 当前状态 | Gian 用法 |
|---|---|---|
| `initialize` | 支持 | 协议协商、agent 版本、capabilities |
| `authenticate` | 支持 | Kimi 实现 `method_id=login`；Gian 有意不调用 |
| `session/new` | 支持 | 新建 Kimi 原生 session |
| `session/load` | 支持 | 首次收养已有 session，并回放历史 |
| `session/resume` | 支持 | Gian 已有 transcript 时重新挂载，不回放历史 |
| `session/prompt` | 支持 | structured turn |
| `session/cancel` | 支持 | Stop |
| `session/list` | 支持 | 后续原生 session 收养 |
| `session/set_config_option` | 支持 | 模型、thinking、mode 原样设置 |
| `session/set_mode` | 支持 | 兼容入口，不作为 Gian 主入口 |
| `session/request_permission` reverse-RPC | 支持 | 工具审批和 AskUserQuestion |
| `session/close` | **不支持** | capability-gated；当前不能逐 session 释放 |
| `logout` | **不支持** | Gian 不接管登录或退出 |
| ACP terminal reverse-RPC | **不支持** | Kimi shell 在本地直接执行 |

`session/load` 会同步回放历史；`session/resume` 不回放。因此 Gian 在“第一次收养”
和“进程重启后的重新挂载”两个场景必须选不同方法，不能都用 `load`。

### 2.2 原生 mode

Kimi ACP 当前直接声明四个 mode：

| 原生 ID | 原生含义 |
|---|---|
| `default` | 手动审批，工具正常运行 |
| `plan` | 只读规划，不执行工具 |
| `auto` | 完全自主，不询问用户 |
| `yolo` | 自动批准工具，但 agent 仍可向用户提问 |

Gian 不把它们映射到 `ask` / `auto` / `full-access`，尤其不能把 `auto` 和
`yolo` 合并。UI、数据库和 proxy 往返的都是这些原生 ID。

### 2.3 进程与 session

ACP 标准允许一条 client-agent connection 管理多个 session。Kimi 当前源码也
明确采用这个形态：

- `AcpServer.sessions: Map<string, AcpSession>`
- `KimiHarness.activeSessions: Map<string, Session>`
- `KimiCore.sessions: Map<string, Session>`

底层 `KimiHarness.closeSession()` 和 `KimiCore.closeSession()` 已存在，并会从
map 删除 session；缺的是 ACP adapter 对外的 `session/close` handler。
connection EOF / 进程信号会调用 `harness.close()`，一次释放该进程里的全部
session。

所以当前准确结论是：

- 不能断言“Kimi 一定内存泄漏”。
- 也不能断言“内部一定会自动淘汰 ACP session”。
- ACP adapter 的三层 session map 当前没有逐 session 删除入口。
- 是否造成显著 RSS 增长，要由真实 workload 测量。

---

## 3. 设计原则

### 3.1 Gian 管 CLI 二进制，不管账号

Gian 负责：

- 安装、校验、选中和回滚 CLI 版本。
- 给所有 proxy / TTY runtime 提供绝对 binary path。
- 定时检查更新，并协调 active process 的平滑换代。
- 展示当前版本、可用版本、最后检查时间和错误。

Gian 不负责：

- OAuth、API key 或 token 的采集和保存。
- 替用户跑交互式登录。
- 修改厂商账号或 provider 配置。

Claude、Codex、Kimi 仍分别使用厂商默认数据目录，例如 `~/.claude`、
`~/.codex`、`~/.kimi-code`。用户在终端登录后，Gian 启动的 managed binary
读取同一份厂商状态。

未登录时，session 创建直接失败并显示可执行的终端命令；不创建半成品 Gian
session，不弹 Gian 自己的登录流程。

### 3.2 Gian 不发明跨 CLI mode

Gian 只提供一套“原生配置描述和存储协议”，不提供一套统一的权限语义。

- 选项 ID、值、标签和说明由 executor adapter 提供。
- proxy 向底层 CLI 传原值，不做跨 provider 对照。
- UI 根据 capability 动态渲染。
- 未知的新值允许 round-trip，不能因为 Gian 的 TypeScript union 旧了就拒绝。

“运行几轮”“是否自动续跑”等 Gian orchestration 设置必须与 CLI permission
mode 分离。不能再用 `approval_mode === 'auto'` 推导 Gian job 是否续跑。

### 3.3 Structured 行为相近，不代表生命周期相同

对用户来说，Kimi ACP 与 `claude -p` 都是“在 Chat UI 里跑 structured
turn”；底层生命周期并不一样：

| Executor | Gian proxy | 底层 structured runtime | 共享范围 |
|---|---|---|---|
| Claude | 每 Gian session 一个 cc-proxy | `claude -p` 子进程按 turn 运行 | 不共享 |
| Codex | 一个 shared codex-proxy | 一个 `codex app-server` | 多 thread |
| Kimi | 一个 shared kimi-proxy | 一个 `kimi acp` | 多 session |

实现不能因为产品形态相似，就把 Kimi 写成每 turn spawn 的 `-p` 模型。

### 3.4 Capability first

所有会随 CLI / ACP 版本变化的行为都以运行时 capability 为准：

- 不硬编码 Kimi 永远没有或永远拥有 `session/close`。
- 不假定 mode 永远只有四个。
- 不假定 config option 只有 `model` / `thinking` / `mode`。
- 不把特定 Kimi 版本的错误文字当协议。

### 3.5 未选择的路线

- **`kimi -p` / one-shot print mode：** 产品形态最像 `claude -p`，但 ACP 是
  Kimi 面向 IDE 的正式 structured surface，已有 session、流式工具、动态配置
  和 reverse permission；主路径不降级成文本 / 单轮协议。
- **直接嵌 Kimi Node SDK：** 会把 Gian 与 Kimi 内部 SDK 版本、初始化和账号
  逻辑绑死，也偏离“由底层 CLI 提供真实行为”的原则。
- **每个 Gian session 一个 `kimi acp`：** 隔离简单，但放大进程和模型 /
  plugin 初始化成本，也没有利用 ACP 的多 session 设计。只有 Phase 0 证明
  shared connection 无法正确并发隔离时才回退到此方案。
- **TTY 抓屏：** 只能得到终端像素 / 文本，无法可靠承载 approval、tool
  lifecycle、config option 和 session id，不考虑。

---

## 4. 总体架构

```text
┌────────────────────────────────── Gian host ──────────────────────────────────┐
│                                                                               │
│  CliRuntimeManager                                                           │
│  ├── ClaudeProvider ── immutable versions / active pointer / update probe     │
│  ├── CodexProvider  ── immutable versions / active pointer / update probe     │
│  └── KimiProvider   ── immutable versions / active pointer / update probe     │
│           │                                                                   │
│           └── RuntimeLease { binaryPath, version, env, release() }             │
│                                                                               │
│  ProxyManager                                                                 │
│  ├── CcProxyClient (per Gian session)                                         │
│  │      └── cc-proxy ─────────────── managed claude                           │
│  ├── CodexProxySessionClient facades                                          │
│  │      └── shared codex-proxy ───── managed codex app-server                 │
│  └── KimiProxySessionClient facades                                           │
│         └── shared kimi-proxy ────── managed kimi acp                         │
│                                                                               │
│  SessionManager ── EventRouter ── normalize-{cc,codex,kimi} ── DB / WS / web  │
└───────────────────────────────────────────────────────────────────────────────┘
```

新增 `kimi-proxy` 而不是在 host 里直接实现 ACP，理由：

- 保持第三方 runtime 崩溃、stdout 污染和依赖与 host 隔离。
- 继续复用 Gian 已有 `ProxyClient` 接口、notification routing 和 contract test
  形态。
- ACP SDK 依赖只落在 `kimi-proxy` 包，不扩大 host dependency surface。
- 未来 Kimi ACP 协议变化只影响 adapter 包。

这里不假设 Codex 已有成熟的 shared-process drain 实现。当前 codex-proxy 只有
lazy start、crash 后 pending request reject 和下次使用时 resume；Kimi 所需的
`idle grace -> draining -> stopped` 是一套新的 shared-runtime lifecycle，
后续再抽给 Codex 复用。

---

## 5. 统一 CLI Runtime Manager

### 5.1 所有权边界

完成迁移后，`CliRuntimeManager` 是唯一允许解析 executor binary 的模块。
proxy、TTY manager、install script 和 capability probe 都不能再各自
`command -v`。迁移期间的边界是：

- 新 Kimi 路径从第一天只接受 RuntimeManager 提供的绝对路径。
- Claude / Codex 保持当前解析逻辑，直到各自 provider 通过安装、回滚和真机
  regression gate；不能在 Kimi 首次接入时顺手切换。
- 每迁完一家，就删除该家的 legacy fallback，不能永久双轨。

建议接口：

```ts
type CliId = 'claude' | 'codex' | 'kimi';

interface CliRuntimeProvider {
  readonly id: CliId;
  inspectInstalled(): Promise<InstalledRuntime[]>;
  resolveLatest(channel: 'stable'): Promise<RuntimeRelease>;
  stage(release: RuntimeRelease, targetDir: string): Promise<StagedRuntime>;
  verify(staged: StagedRuntime): Promise<void>;
  probe(binaryPath: string): Promise<RuntimeProbe>;
  managedEnv(): Readonly<Record<string, string>>;
}

interface RuntimeLease {
  cli: CliId;
  version: string;
  binaryPath: string;
  env: Readonly<Record<string, string>>;
  release(): void;
}
```

provider 层只统一生命周期，不强行统一三个厂商的发行渠道。每个 provider 可以
从官方 native release、npm registry 或其它已验证的官方渠道取包。

### 5.2 文件布局

```text
{GIAN_DATA_DIR}/runtimes/
├── bin/
│   ├── claude -> ../claude/current/bin/claude
│   ├── codex  -> ../codex/current/bin/codex
│   └── kimi   -> ../kimi/current/bin/kimi
├── claude/
│   ├── versions/<version>/...
│   └── current -> versions/<version>
├── codex/
│   ├── versions/<version>/...
│   └── current -> versions/<version>
└── kimi/
    ├── versions/<version>/...
    └── current -> versions/<version>
```

host 启动子进程时先解析 `current` 到真实版本目录，再取得 lease。进程整个生命
周期都使用这个绝对路径；`current` 后续切换不会改变正在运行的进程。

`bin/` 是给用户登录和排障的稳定入口。Gian 根据实际 `GIAN_DATA_DIR` 显示
解析后的绝对命令，例如：

```sh
/resolved/gian-data-dir/runtimes/bin/kimi login
```

但不应静默覆盖用户已有的 `/usr/local/bin/kimi` 或修改 shell profile。

### 5.3 安装与激活

一次更新分为：

1. 在同一文件系统的 staging 目录下载。
2. 校验 registry integrity、官方 checksum 或签名。
3. 解包到 immutable version directory。
4. 运行 `--version` 和 executor-specific structured probe。
5. 原子替换 `current` 指针。
6. 新进程使用新版本；旧 lease 继续使用旧版本。
7. 至少保留一个 last-known-good 版本，且有 lease 的目录永不清理。

下载成功不等于激活成功。以下任一情况都拒绝激活：

- 完整性校验缺失或失败。
- binary 架构 / OS 不匹配。
- structured handshake 缺少 Gian 所需能力。
- stdout protocol probe 出现非协议内容。
- 版本低于 provider adapter 的最低兼容版本。

### 5.4 定时更新

定时任务放在 Gian host 内，不新增独立 cron / launchd job：

- host 启动后延迟检查一次。
- 默认每 24 小时检查，加入每台安装稳定的 jitter，避免同时打发行源。
- 失败指数退避，不影响当前版本运行。
- 支持 Settings 中的 `Check now` / `Update now`。
- stable channel 为默认且首期唯一 channel。

managed invocation 必须禁用厂商自己的后台自更新，避免两个 updater 竞争同一个
binary。当前已找到的入口为：

- Claude：`DISABLE_AUTOUPDATER=1` / `DISABLE_UPDATES=1`，Phase 0 固定首选项。
- Codex：`check_for_update_on_startup=false`；immutable version directory
  仍是防止原地改写的最终边界。
- Kimi：`KIMI_CODE_NO_AUTO_UPDATE=1`。

若某个版本无法可靠禁用 self-update，就必须使用不会被其原地覆盖的只读 /
immutable 安装方式，或拒绝把该发行物激活为 managed runtime。

### 5.5 更新与 shared process

Kimi shared process 启动时持有一个 runtime lease：

- 更新激活不会杀正在执行的 turn。
- 旧 shared process 可以完成现有工作。
- 所有 session quiescent 后，ProxyManager 做 drain + shutdown。
- 下一次请求从新版本重建 shared process，并 resume 原生 session。

不允许“更新任务到点就 SIGKILL shared process”。

首版先在 Kimi 上实现并验证这套 shared-runtime lifecycle。Codex 继续使用当前
lazy restart 语义；迁移到 RuntimeManager 时再复用已经验证过的 drain primitive，
不把 Codex lifecycle 重构塞进 Kimi 的首个 PR。

### 5.6 状态与回滚

SQLite 记录：

- executor、版本、来源、安装路径和 integrity。
- `active` / `staged` / `last-known-good` / `rejected` 状态。
- 最后检查、最后成功、下次检查和最近错误。

文件系统 `current` 指针是 binary 解析的权威；DB 是状态和 UI 索引。启动时若
两者不一致，RuntimeManager 以已校验且实际存在的版本修复 DB，不猜路径。

同一新版本若在 15 分钟窗口内连续 3 次发生 protocol startup failure，可自动
切回 last-known-good；一次完整 handshake 成功即清零该版本的连续失败计数。
auth error、model error、quota error不计入窗口，也不触发 binary rollback。

---

## 6. Executor 原生配置

### 6.1 新的通用形状

通用的是“配置描述协议”，不是“配置含义”：

```ts
type NativeConfigValue = string | boolean | number | null;

interface NativeConfigChoice {
  value: NativeConfigValue;
  label: string;
  description?: string;
}

interface NativeConfigOption {
  id: string;
  name: string;
  category?: string;
  type: 'select' | 'boolean' | 'number' | 'text';
  currentValue: NativeConfigValue;
  choices?: NativeConfigChoice[];
  scope: 'session' | 'turn';
}

interface ExecutorConfigState {
  schemaVersion: 1;
  executor: Executor;
  values: Record<string, NativeConfigValue>;
}
```

`id` 和 `value` 是 opaque 原生值。host 可以存、比较和 round-trip，但不能把
`kimi.mode=yolo` 推导成 `codex.sandbox=danger-full-access`。

option 的来源允许因 executor 不同而不同：

- Kimi 以 ACP `configOptions` / `config_option_update` 为权威，动态发布。
- Claude / Codex 暂无同等动态接口，由各自 adapter 静态发布 CLI 原生选项，
  随 adapter 的最低 / 最高兼容版本维护。
- 静态 adapter 也必须保存并 round-trip 未知值；“静态发布”不等于用
  TypeScript closed union 拒绝新 CLI 值。

### 6.2 Kimi 配置数据流

1. `session/new` / `load` / `resume` 返回 `configOptions`。
2. kimi-proxy 原样转成 `NativeConfigOption[]`。
3. host 保存当前 session 的 exact values。
4. UI 从 options 动态生成 model / thinking / mode 控件。
5. 用户修改后调用 `session/set_config_option`，值原样往返。
6. `config_option_update` 刷新 UI 和 DB。

Kimi mode 在底层并非永久持久化状态。ACP 进程重建后，Gian 用
`session/resume` 返回的 current values 与 session 已保存的 exact values 比较，
再按以下顺序补应用：

1. `model`
2. `thinking`
3. `mode`
4. 其它 option

先 model 后 thinking，是因为可用 thinking levels 可能随 model 改变。

### 6.3 现有 `ApprovalMode` 的迁移

当前 `ApprovalMode = plan | ask | auto | full-access` 同时承担：

- CLI permission / sandbox 映射。
- Composer UI mode。
- multi-turn job 开启条件。
- plan exit ceremony。
- IM mode。

这是本次接入前应拆的技术债。迁移采用渐进方式：

1. 下一可用 migration 添加 `sessions.executor_config_json`。
2. 现有 Claude / Codex rows 只做一次行为保持型 backfill，记录当时实际会传给
   CLI 的原生字段。
3. structured 和 TTY runtime 改读原生配置。
4. Gian job 是否续跑改成独立 orchestration 字段，不再读 permission mode。
5. `approval_mode` 先允许 NULL 并标 deprecated；Kimi row 不写伪造值。
6. web / REST / WS / native adoption 全部迁完后，再删除 shared
   `ApprovalMode` 和数据库列。

IM 当前已隐藏，本方案不为 Kimi 增加 IM 路径；旧 IM 代码在兼容阶段保留，
但不能反过来阻塞 structured runtime 的原生配置改造。

存量 job 的行为保持型迁移规则固定为：

- 仅 `approval_mode='auto' AND turns > 1` 的 session 回填
  `orchestration.autoContinue=true` 和原 `turns` 上限。
- `plan` / `ask` / `full-access` 即使 `turns > 1`，当前也不会自动续跑，回填为
  `autoContinue=false`。
- 新 UI 把 orchestration 放在独立的 job control，不再藏在 permission picker
  里；`oneShotBypass` 等一次性权限状态不能改变 job 设置。

为降低首个 Kimi 版本的回归面，Kimi 可以先写 `executor_config_json`，同时让
Claude / Codex 继续兼容读 legacy 字段。删除 `ApprovalMode` 是明确的后续迁移，
但不再作为 `kimi-proxy` 的阻塞前置。

---

## 7. Kimi Proxy

### 7.1 进程拓扑

```text
host KimiProxyHost
  │ Gian proxy JSON-RPC over stdio
  ▼
shared packages/proxies/kimi-proxy
  │ ACP NDJSON JSON-RPC over stdio
  ▼
managed `kimi acp`
```

host 中每个 Gian session 拿一个 `KimiProxySessionClient` facade；facade 不拥有
进程。`KimiProxyHost` 维护一份 shared child 和 notification routing。

kimi-proxy 内维护：

```text
proxySessionId -> {
  gianSessionId,
  nativeSessionId,
  status,
  activeTurnId,
  configOptions,
  slashCommands
}

nativeSessionId -> proxySessionId
```

ACP notification 只带 Kimi `sessionId`，因此第二个索引是把更新准确投到 Gian
facade 的关键，不能按“当前 active session”猜。

### 7.2 初始化

kimi-proxy 启动 managed `kimi acp` 后：

1. 建立 ACP `ClientSideConnection`。
2. 发送 `initialize`，声明 Gian clientInfo。
3. **不声明** `fsCapabilities`。
4. **不声明** terminal capabilities。
5. 保存 negotiated version、agentInfo、agentCapabilities 和 authMethods。
6. 向 host 返回转换后的 proxy capabilities。

不声明 filesystem reverse-RPC 是有意选择。Kimi 在该情况下使用本地
`LocalKaos` 读写，与直接运行 Kimi CLI 一致；Gian 不在 MVP 中伪装编辑器
buffer，也不叠加第二套文件权限语义。

### 7.3 新建、收养与重挂

| 场景 | ACP 方法 | 是否接收历史 |
|---|---|---|
| 新 Gian / Kimi session | `session/new` | 否 |
| 首次收养已有 Kimi session | `session/load` | 是 |
| host / proxy / ACP 重启 | `session/resume` | 否 |
| 全局 idle 后再次使用 | `session/resume` | 否 |

每次 `session/new` / `load` / `resume` 都显式传当前 Gian session 的 cwd：

- 普通 coding session 使用 workspace path。
- worktree session 使用 `sessions.worktree_path`。
- Task PM / subtask 同样使用各自实际 worktree，不允许退回 host cwd。
- `mcpServers` 首期传空数组，沿用 Kimi 在该 cwd 下加载自身项目配置的行为；
  后续只有 Gian 明确接管 MCP 配置时才改变。

`session/new` 成功返回的 Kimi `sessionId` 写入
`sessions.native_session_id`。若未登录，调用在 DB insert 前失败，保持当前
create 路径“先创建上游原生 session，再写 Gian row”的原子边界。

现有 adopt 路径是“先 insert、首次发消息时 lazy resume”，不能直接照搬。
Kimi adopt 固定为：

1. 生成 Gian session id，但先不写 row。
2. 建 provisional facade，调用 `session/load` 并完成历史 replay。
3. load 成功后，在一个 DB transaction 内写 session row 和 replayed events。
4. DB transaction 失败时删除 provisional routing；当前无 `session/close` 时，
   native session 等下一次全局 safe shutdown 释放。

因此 load 失败不会留下孤儿 Gian row。未来统一 Claude / Codex adopt 时再决定
是否迁到相同原子顺序，不在本期偷改现有行为。

原生 session picker 后续直接用 `session/list`，不以解析
`~/.kimi-code/session_index.jsonl` 为 MVP 前提。

### 7.4 Prompt 输入

| Gian input | ACP prompt block |
|---|---|
| text | `text` |
| local image | 读取文件后转 base64 `image`，保留 MIME |
| selected Kimi skill | 使用 Kimi 动态公布的 `/skill:<name>` 命令 |
| resource / link | 后续能力，MVP 不新增 Gian input type |

每个 Kimi session 同时只允许一个 active prompt。第二个 prompt 返回
`SESSION_BUSY`，由现有 queue 机制处理；不同 Kimi session 可并行，真实并发能力
由 Phase 0 锁定。

### 7.5 Slash commands

Kimi 的 `available_commands_update` 是 session-scoped 动态通知，不适合硬塞进
当前全局 `capabilities.list`。

改造后：

- `ProxyClient` 支持 session-scoped command snapshot。
- kimi-proxy 缓存最新 `available_commands_update`。
- host 收到更新后广播给对应 session。
- UI palette 热更新。
- 兼容的 `slash.list` 只返回该 facade 的最近 snapshot，不是第二份权威数据。

---

## 8. Event 与交互映射

### 8.1 Session updates

新增 `normalize-kimi.ts`，保留 ACP raw payload 供排障，再映射到 Gian unified
events：

| ACP update | Gian event |
|---|---|
| `agent_message_chunk` | `assistant_text` delta |
| thought / reasoning chunk | `reasoning` |
| `plan` | `plan_update` |
| `tool_call` | 按 kind 转 `command_execution` / `file_change` / `file_read` / `file_search` / `web_search`，未知 kind 转新增的 `tool_execution` generic card |
| `tool_call_update` | 更新对应稳定 `itemId` 的状态 / 输出 |
| `config_option_update` | session config snapshot update，不写 transcript |
| `available_commands_update` | session command snapshot update，不写 transcript |

不能只按 tool title 猜类型；优先使用 ACP `kind` 和 structured content。无法无损
归类的工具必须保留为 generic tool event，不能静默丢失。

这也修复一项现有缺口：当前 Claude normalizer 对未知 tool kind 返回空事件，
host 只记 warning，用户看不到该工具。`tool_execution` 应作为统一 taxonomy
能力供所有 executor 使用，而不是 Kimi 私有卡片；迁移时同步删除
`normalize-cc.ts` 中过时的 “legacy raw passthrough” 假设。

### 8.2 Turn lifecycle

- `turn.start` 在 proxy 本地生成 Gian proxy turn id。
- `session/prompt` 开始后发 `turn.started`。
- prompt response 的 `stopReason` 映射为 completed / cancelled / failed。
- `session/cancel` 只取消目标 native session，不影响其它 session。
- 进程退出时，所有 in-flight turn 失败；idle facade 标 stale，下一次调用
  resume。

### 8.3 Permission 与 Question

Kimi 把工具审批和 AskUserQuestion 都放在 reverse
`session/request_permission`，并提供 opaque `optionId`。Gian 必须保留这些
选项，不能压成固定 accept / decline：

```ts
interface NativeApprovalOption {
  optionId: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}
```

现有 `approval_requested` 增加可选 `nativeOptions`，resolve message 增加可选
`nativeOptionId`：

- Claude / Codex 继续走现有 `ApprovalDecision` 兼容路径。
- Kimi UI 直接按 native options 渲染并回传 exact `optionId`。
- kimi-proxy 在原 reverse-RPC promise 上返回选中的 option。
- 未知 / 过期 option 一律拒绝，不猜“最接近”的 Gian decision。

这也能完整承载 Kimi 的 plan review 多选项，以及当前 ACP adapter 对
AskUserQuestion 的单选退化行为。

IM 不接 Kimi approval；本期只保证 web。

---

## 9. Session 与进程生命周期

### 9.1 正常状态机

```text
stopped
  └── first request -> starting -> ready
                                ├── session/new
                                ├── session/load
                                ├── session/resume
                                └── session/prompt

ready
  └── all operations quiescent -> idle grace -> draining -> stopped

ready / starting
  └── unexpected exit -> crashed
                         ├── fail in-flight turns
                         └── next request -> starting -> session/resume
```

“operation quiescent”至少要求：

- 无 active prompt。
- 无 pending permission / question。
- 无 in-progress ACP tool call。
- 无已知 background task。
- 无正在进行的 load replay 或 config mutation。

Phase 0 若无法从 ACP 证明“无 background task”，自动 idle shutdown 默认关闭，
只在 host shutdown、显式 recovery 或版本换代 drain 时关闭进程。不能为了控
RSS 悄悄终止用户后台任务。

### 9.2 当前没有 `session/close`

`ProxyClient.closeSession()` 对 Kimi 的当前语义是：

1. cancel 该 session 的 active turn（如果有）。
2. 删除 Gian / proxy facade routing。
3. 将 native session 标记为 detached。
4. 若 runtime capability 未来声明 close，则调用原生 `session/close`。
5. 否则等待全局安全 shutdown，由 `harness.close()` 一次释放。

删除一个 Gian session 绝不能直接杀 shared Kimi process，因为其它 session
可能正在运行。

“detached”只描述当前 proxy routing，不改变原生 session 的可恢复性。若归档的
Gian session 再次打开，proxy 应对同一 `native_session_id` 调
`session/resume` 并重建 routing；不得因进程 map 中仍有该 id 就新建 session。
Phase 0 必须覆盖 `detach -> resume`（同进程和进程重启后各一次）。

### 9.3 不做固定周期重启

Kimi process 不按“每 N 小时”盲重启。重启只由以下事件触发：

- host 正常关闭。
- shared process crash。
- 所有 session 安全 quiescent 后的 idle shutdown。
- managed binary 更新后的 drain。
- 用户显式 force recover，且没有其它 active session。
- 经过真实 RSS 观测后定义的 soft limit，并且仍满足安全 quiescence。

若一个 Kimi session 卡死、同时另一个 session 正在运行，force recover 先对
目标 session cancel；不能升级成全局 kill。无法恢复时将目标 session 标错并
等待 shared process 可安全 drain。

### 9.4 观测指标

至少记录：

- ACP child PID、版本和 uptime。
- attached / detached / active session 数。
- active prompt、pending permission、in-progress tool 数。
- child RSS / CPU。
- process restart reason。
- resume success / failure。
- protocol error 与 stdout contamination。

没有这些数据前，不设置“看起来合理”的内存阈值。

---

## 10. 错误、登录和恢复

### 10.1 未登录

当 Kimi 返回 ACP `auth_required`：

- proxy 转成稳定错误码 `AUTH_REQUIRED`。
- host 原样终止 create / prompt。
- UI 显示 managed binary 的实际登录命令。
- Gian 不调用 `authenticate`，不保存 token。
- 用户登录后点击 Retry；若同一 ACP 进程仍读不到凭据，先 graceful restart
  Kimi shared process，再 retry 一次。

Retry 不重复插入 Gian session row、turn 或 user message。

### 10.2 Crash

进程 crash 时：

- in-flight turn 进入 error，错误可重试。
- pending approval 关闭，不能留永久 pending 卡片。
- 清空 native-to-proxy live routing。
- DB transcript 不删除。
- 下一次请求启动新 ACP process，用 `session/resume` 重新绑定。

如果 `resume` 返回 session not found，停止自动恢复并提示用户；不能悄悄
`session/new` 生成一条断历史的新 session。

managed Kimi 与用户自己安装的 Kimi 会共用 `~/.kimi-code`。RuntimeManager
激活前除协议 probe 外，还要检查 adapter 支持的 session-store 格式范围；若无法
判断兼容性，至少不得自动降级到比最近写入该目录的版本更老的 managed binary。
格式不兼容是 `DATA_VERSION_INCOMPATIBLE`，不能误报为 session not found。

### 10.3 配置漂移

CLI 升级后，如果已保存 option 不再存在：

- 保留原值用于诊断。
- 不向新 CLI 发送无效值。
- 采用 CLI 当前 default，并向用户显示“原设置已不可用”。
- 不把它映射为另一个 Gian 认为相似的值。

---

## 11. 数据与接口改动

### 11.1 Shared

- `Executor` 增加 `'kimi'`。
- `ProxyCapabilities` 改为带 executor discriminant 的通用结构。
- 增加 `NativeConfigOption` / `ExecutorConfigState`。
- unified event taxonomy 增加可承载未知 ACP tool kind 的 `tool_execution`，保留
  title、kind、structured content、status 和 stable item id。
- approval event / response 增加 opaque native options。
- command snapshot 改为 session-scoped。
- `CreateSessionParams` 用通用 `nativeSessionId` + `resumeMode` 替换
  `claudeSessionId` / `threadId` 专用字段。
- `StartTurnParams` 以 `nativeConfig` 为主，executor-specific 字段在迁移期兼容。

### 11.2 Database

下一可用 migration（当前应为 `033`）：

- `sessions.executor_config_json TEXT NOT NULL DEFAULT '{}'`
- `sessions.approval_mode` 进入 nullable / deprecated 过渡
- CLI runtime version / channel / health tables

本期不增加 `approvals.options_json`。当前 `ApprovalManager` 纯内存，
`approvals` 表没有完整写入 / 恢复链路；pending approval 跨 host restart
恢复应作为所有 executor 共用的独立功能设计，不能把“加一列”伪装成已实现。
Kimi native options 在当前进程内必须 exact round-trip，进程 crash 时按
§10.2 明确结束 pending approval。

`native_session_id` 现有 `(executor, native_session_id)` unique index 可直接
支持 Kimi，无需新增一套 id 列。

### 11.3 Host / Web API

- WS `session:create`、REST native adopt 和 Task PM subtask executor 接受
  `kimi`；不存在通用 REST create-session 路由。
- 新增 session native-config snapshot / update message。
- Settings 新增三个 managed CLI 的 runtime 状态和手动检查动作。
- Kimi 未登录错误使用稳定 code，不在 web 里匹配英文错误文本。
- IM API 无 Kimi 分支。

Task PM 属于本期范围：`default_task_executor` 和 per-subtask executor 最终允许
`kimi`，manager 创建的 Kimi session 必须继承对应 worktree cwd。由于当前 Task
PM 代码正在独立演进，这部分放在 Host 接入阶段单独提交，不与 proxy transport
首批实现混改。

---

## 12. 实施分期

### Phase 0 - 真 CLI spike 和兼容矩阵

**状态：进行中。** 无模型 prompt 的 initialize/capabilities/分页 list/shutdown
已验证；真实并发、资源、登录热加载、crash/replay 和 background task gate 待跑。

目标是把剩余未知变成 fixture 和自动 gate，不写产品 UI。

- 固定 Kimi CLI 版本与 ACP protocol version。
- 记录 initialize / new / prompt / approval / cancel / load / resume /
  list / config option 的脱敏 trace；new / load / resume fixture 必须断言完整
  `cwd` 和 `mcpServers` 参数。
- 验证未登录 -> 外部 login -> retry。
- 验证同 session busy、两个 session 并发。
- kill ACP child，验证 resume 不重复历史。
- 验证同进程和进程重启后的 `detach -> resume`。
- 跑 1 / 10 / 50 个 session 的 RSS 与 idle 曲线。
- 验证 background task 对安全 shutdown 的影响。
- 固定三家 CLI 的官方 release source、integrity 和已经识别出的 self-update
  禁用配置。

**Gate：** 任一核心 flow 只能靠 stdout 文本解析、并发无法隔离，或发行物无法
安全校验时，回到设计评审，不启用 managed update 或生产 Kimi 入口。隔离的
RuntimeManager kernel、ACP transport、fake-server contract tests 和默认关闭的
Host/Web vertical slice 可以与 Phase 0 并行开发。

### Phase 1a - `CliRuntimeManager` kernel + Kimi provider

**状态：部分完成。** Absolute-path resolve/probe/cache/lease、显式 override
失败不 fallback、并发 single-flight 已实现；install/activate/rollback/scheduler
仍属 Phase 4/5。

- 建 provider interface、version store、lease、atomic activate、rollback。
- 实现 Kimi release resolve / integrity / stage / probe / managed env。
- 加 scheduler kernel、single-updater lock 和 focused tests。
- Kimi 只接受 RuntimeManager 的 absolute managed path。
- **不改**现有 Claude / Codex proxy binary resolution 和 `install.sh`。

### Phase 2 - `kimi-proxy` 与原生配置基础

**状态：已实现，待 Phase 0 真实 workload gate。**

- 新 `kimi-proxy` package 与 ACP SDK client。
- shared child 基础生命周期和 per-session facade routing。
- new / load / resume / prompt / cancel / config / commands。
- reverse permission exact option round-trip。
- fake ACP server contract tests + Phase 0 recorded fixtures。
- 增加通用 native config types；Kimi 不写 legacy `approval_mode`。

### Phase 3 - Host 与 Web Kimi vertical slice

**状态：代码与 unit/integration tests 已实现，待 8991/5191 浏览器和真实 CLI e2e。**

- `Executor='kimi'` 的 WS create、REST adopt、delete 和 retry。
- `normalize-kimi.ts`。
- 动态 model / thinking / mode / slash UI。
- auth-required 错误和 managed login command。
- Kimi session list / load 收养。
- Task PM / subtask executor 加 Kimi，并保证 worktree cwd 透传。
- 不接 Kimi TTY，不接 IM。

### Phase 4 - Claude / Codex 统一迁移

- 补 Claude / Codex RuntimeManager provider 和 static native options。
- 分 executor 把 proxy / TTY runtime 切到 managed absolute path；每家有独立
  regression gate 和回退开关。
- install script 最终不再依赖 launchd PATH 找三家 CLI。
- backfill Claude / Codex 当前实际 native config。
- 把 Gian job orchestration 从 approval mode 中拆出，按 §6.3 保持存量行为。
- 保留旧字段兼容读，停止新写伪 mode，最后删除 `ApprovalMode`。

这是跨 shared / host / web 的高风险阶段，应拆成独立提交，不与 Kimi event
normalizer 混在一个 diff。

### Phase 5 - Shared lifecycle、稳定性与发布

- shared process idle / drain / update handoff。
- 首先在 Kimi 验证，再把通用 primitive 接给 Codex；不假设 Codex 现状已有。
- RSS、restart reason、resume 指标。
- capability-gated `session/close`。
- 若上游仍未实现 close，提交 Kimi Code PR；Gian 保持对旧版本兼容。
- 8991 / 5191 真机回归和版本升级 / 回滚演练。

---

## 13. 验收标准

### CLI 管理

- 所有已支持的 structured / TTY runtime 都使用 RuntimeManager 返回的绝对路径。
- Settings 能看到 installed、active、available、last checked 和错误。
- 定时检查失败不影响当前 session。
- 更新时 active turn 不被杀；新进程使用新版本；可回滚。
- vendor self-updater 不会改写 Gian managed version directory。

### Kimi 登录

- 未登录 create 在 DB insert 前以 `AUTH_REQUIRED` 失败。
- UI 给出真实 managed binary 登录命令。
- 用户在终端登录后 Retry 成功。
- Gian 数据库、日志和 web payload 不出现 token。

### 原生配置

- Kimi UI 直接显示 ACP 返回的 `default` / `plan` / `auto` / `yolo`。
- `auto` 与 `yolo` 不合并，不映射 `full-access`。
- 未知新增 mode / config option 可显示和 round-trip。
- ACP 重启后 exact session config 可重应用。
- Claude / Codex structured runtime 不再依赖 Gian `ApprovalMode` 映射。

### Session 与事件

- 两个 Kimi session 可同时运行且事件不串线。
- 同 session 第二个 prompt 得到 `SESSION_BUSY`。
- Stop 只取消目标 session。
- crash 后 resume 不重复 transcript。
- detach 后重新打开同一 Gian session 仍 resume 同一个 native session。
- 删除 idle Gian session 不影响其它 Kimi session。
- 文本、reasoning、plan、shell、file change、approval、question、image
  至少各有一条 contract / fixture 覆盖。

### 生命周期

- 当前 Kimi ACP 无 close capability 时，不伪造逐 session close 成功。
- 不存在固定周期盲重启。
- 有 background task 时不会触发自动 idle shutdown。
- 50-session smoke 的 RSS 数据被记录；是否设 soft limit 由数据决定。
- Phase 2 contract tests 自动断言 resume 后不重复 transcript。

### 范围

- Kimi IM 不可选。
- Kimi TTY 不可选。
- Gian 不提供 Kimi 登录表单。
- 不接 legacy Python Kimi CLI / SDK。
- Task PM 可以显式选择 Kimi，且 subtask 使用自己的 worktree cwd。

---

## 14. 主要风险

| 风险 | 应对 |
|---|---|
| ACP adapter 当前无 `session/close` | capability gate、全局安全 drain、RSS telemetry、向上游补 handler |
| background task 让 idle 判断不可靠 | Phase 0 实测；不能证明 quiescent 时默认不自动 shutdown |
| CLI 自动更新引入供应链或协议回归 | 官方 integrity、immutable versions、probe、lease、last-known-good rollback |
| 原生配置改造触及现有 Composer / IM / job | 单独 Phase 4；一次性 backfill 保行为；Kimi 不写 legacy mode |
| ACP 或 option schema 随版本变化 | negotiated capabilities、opaque IDs、fixture matrix、最低兼容版本 |
| shared process 单点 crash | in-flight 明确失败、idle session resume、绝不静默 new session |
| managed 与用户自装 Kimi 共用数据目录导致版本 skew | session-store compatibility gate、禁止不明兼容性的自动降级、稳定错误码 |
| 首批 RuntimeManager 改坏现有 Claude / Codex | Phase 1a 只新增 Kimi provider；现有两家在独立 regression gate 后逐个迁移 |

---

## 15. 预计文件面

**新增：**

- `packages/proxies/kimi-proxy/`
- `packages/host/src/proxy/kimi-proxy-client.ts`
- `packages/host/src/event/normalize-kimi.ts`
- `packages/host/src/runtime/manager.ts`
- `packages/host/src/runtime/kimi-provider.ts`
- `packages/host/src/runtime/cli-update-scheduler.ts`
- `packages/host/src/runtime/providers/{claude,codex,kimi}.ts`
- 对应 proxy / host / web tests
- 下一可用 DB migration

**主要修改：**

- `packages/shared/src/model.ts`
- `packages/shared/src/proxy.ts`
- `packages/shared/src/events.ts`
- `packages/shared/src/web.ts`
- `packages/host/src/proxy/types.ts`
- `packages/host/src/proxy/manager.ts`
- `packages/host/src/session/manager.ts`
- `packages/host/src/approval/manager.ts`
- `packages/host/src/index.ts`
- `packages/host/src/web/app.ts`
- `packages/host/src/web/ws-handler.ts`
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/components/SettingsBody.tsx`
- `packages/web/src/views/CodingView.tsx`
- web 中现有约 30 处 inline `'claude' | 'codex'` union，迁移为 shared
  `Executor` 或明确的 feature-scoped subset
- Task PM 的 `default_task_executor` / subtask executor 校验
- `scripts/install.sh`

当前工作树同时包含 Task PM / Composer / Desktop / image 等未提交改动。Kimi
vertical slice 已在这些改动之上完成；后续继续逐文件核对局部 diff，不回退或
重写无关工作。Phase 4 的 Claude/Codex 跨层迁移仍应独立实施和回归。

---

## 16. 参考

- [ACP Architecture](https://agentclientprotocol.com/get-started/architecture)
- [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP Transports](https://agentclientprotocol.com/protocol/v1/transports)
- [Kimi Code `kimi acp`](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Kimi Code command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
- [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- [Kimi Code MIT License](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE)
- [openai/codex](https://github.com/openai/codex)
