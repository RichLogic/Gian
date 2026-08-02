# Implementation plan — Gian Task（PM / Engineer / Individual + action 协议 + LLM loop）

> 配套设计:`gian-task-pm-engineer.md`（**Accepted**）。本文件只讲**怎么落地**:切片、关键文件、验证点、依赖。
> 原则:每个 slice **可独立验证、对现网行为零/小风险**;先 structured(`claude -p`)跑通逻辑,TTY 省钱放最后。
> 纪律:dev 在 `main`、改 host 要重建+重启 **8991**(`GIAN_PORT=8991 GIAN_DATA_DIR=$HOME/.config/gian-dev`)、**绝不碰 8990/5190**。每 slice 跑 `pnpm -r typecheck` + 相关单测;碰 traceability 的更新 `docs/quality/traceability.md`。

---

## 切片总览（按依赖 + 风险递增）

| Slice | 内容 | 风险 | 现网影响 |
|---|---|---|---|
| **0 基座** | DB 表 + shared 类型 + action parser 纯函数 + 单测 | 无（纯加法 + 纯函数） | 0 |
| **1 上下文引擎** | `.ai/` 分片布局 + 懒生成视图 + gian-task skill 文件 + RoleInjector（先 INDIVIDUAL） | 低（动 `.ai/` 脚手架,需 back-compat） | 仅新 session 的 `.ai/` 形态 |
| **2 action 执行** | parser 接进 turn 终态 → dedup/授权/执行 `create_subtask`·`submit_step`;staged confirm/reject;summarizer 写 summary 切走 | 中（新 turn-完成逻辑 + summarizer cutover） | manager/subtask 行为 |
| **3 唤醒 + loop** | submit_step→唤醒 PM;loop 引擎(task_loops 状态机/轮数/出口);message_subtask 状态机(queued+drain) | 高（编排 + 唤醒） | task loop 行为 |
| **4 TTY + 省钱** | host-owned TTY automation channel;engineer 切 TTY;移除 codex-TTY | 最高（PTY/live） | runtime 切换 |

> Slice 0–3 全在 structured 上跑通;Slice 4 才引入 TTY（依赖 runtime-modes B 档成熟度）。**故现在即可开工,不卡 TTY。**

---

## Slice 0 — 基座（本次开始）

**目标**:把 §4A.A 的数据结构 + 解析逻辑做成**孤立、可单测**的件,不接任何 live 路径。

1. **migration `028_task_loops_actions.sql`**（加法）:
   - `task_loops`:`{id PK, task_id, status('active'|'paused'|'done'), allowed_methods, allowed_workspaces, allowed_executors, round, max_rounds, current_step, current_step_session_id, expected_role, created_at, updated_at}`（数组字段存 JSON TEXT）。
   - `task_actions`:`{action_id PK, task_id, session_id, host_turn_id, source_turn_key, method, payload_hash, payload(JSON), status('parsed'|'validated'|'staged'|'queued'|'authorized'|'executing'|'done'|'failed'|'rejected'), result(JSON), error, created_at, updated_at}`。
2. **shared 类型**（`packages/shared/src/`，types-only）:`Role`('individual'|'engineer'|'pm')、`GianActionMethod`、`GianAction`（method+params 判别联合）、`CreateSubtaskParams`/`MessageSubtaskParams`/`SubmitStepParams`、`TaskLoop`、`TaskAction`、`ActionStatus`。
3. **action parser 纯函数**（`packages/shared/src/` 或 host util，无副作用）:
   - 输入 final assistant text → 输出 `{ ok, action?, reason? }`。
   - **尾部规则**:仅当"去尾空白后正好以一个完整 `<<gian:action>>…<</gian:action>>` 结尾"才接受;块后有非空白 → reject('not-trailing')。
   - 忽略代码围栏内的块;JSON 校验 + method/params 校验。
   - `computeActionId(session_id, source_turn_key, payload_hash)`。
4. **单测**:parser（尾部命中 / 块后有正文 / 围栏内忽略 / 多块取尾 / 坏 JSON / 缺字段）、computeActionId 稳定性。

**验证**:临时 db 应用 028（表/列对）;`pnpm -F @gian/shared typecheck` 0;parser 单测全绿。**无需起 daemon。**

**关键文件**:`packages/host/migrations/028_*.sql`、`packages/shared/src/{model.ts 或新 action.ts}`、parser + `*.test.ts`。

---

## Slice 1 — 上下文引擎（INDIVIDUAL 先行）

1. **分片布局**:扩 `workspace/ai-scaffold.ts` → `.ai/sessions/<id>.{state,report?}.md`、`.ai/log/<id>.log.md`;保留旧 `.ai/{STATE,HANDOFF,MEMORY,SESSION_LOG}.md` 可读（back-compat）。
2. **懒生成视图**:`STATE.view.md` 由 host 在 **读时按需 + dirty 标记**（或 turn 边界）生成,非每次写。MEMORY = canonical 单文件,atomic write + `.ai/.history` 备份。
3. **gian-task skill**:`individual.md`/`engineer.md`/`pm.md`/`SKILL.md`（内容已在草稿）。**落点决策**:作为 **host 内置模板**,由 RoleInjector 注入/指向,而非散落进各 workspace 的 `.claude/skills`（避免污染用户 repo;双装 .claude+.agents 是分发形态,运行时靠 host 注入）。
4. **RoleInjector**（先 INDIVIDUAL）:structured = prepend ROLE 头到首条;claude TTY = SessionStart hook 的 additionalContext（settings 已加载）。

**验证**:8991 起一个普通 coding 会话 → 注入 `ROLE: INDIVIDUAL` → orient 读 ws 视图 → 收尾写自己 state 分片 → 懒生成视图刷新。

---

## Slice 2 — action 执行

1. **接 parser 到 turn 终态**（structured 先）:Claude = 完整 assistant text;Codex = `turn_completed.assistantText`（`service.ts:1188`）。
2. **dedup + 授权 + 执行**:查 `task_actions`(action_id 终态→跳过) → `task_loops` 授权(method↔role 硬门 + allowed_* + round) → 执行。
3. **handlers**:`create_subtask`（复用现 subtask 创建链路）;`submit_step`（写 `sessions.summary`，**同时停掉旧 summarizer 的 summary 写**，避免竞争）。
4. **staged 路径**:`POST /api/tasks/:id/actions/:id/{confirm,reject}` + web 轻量确认 chip（取代旧卡片）。

**验证**:PM 会话发 `<<gian:action>>` → host 建 subtask;replay 不重复建;staged confirm 生效。

---

## Slice 3 — 唤醒 + loop

1. **完成唤醒**:`submit_step` → 经 `onEvent` 唤醒 PM（structured = sendMessage 合成一轮）。digest = submit_step 的 verdict/headline/points（不带 transcript）。
2. **loop 引擎**:`task_loops` 状态机（round/max_rounds/current_step/出口三条:通过停 / 上限问"再来一轮" / blocked 暂停）。
3. **message_subtask 状态机**:idle 投递 / active·approval→`queued`+drain（订阅目标 turn.completed）/ blocked 暂停 / 终态 failed。复用 `QueueList`。

**验证**:structured 上跑通一个 dev-loop（code→review→fix→clean），轮数受 host 兜底。

---

## Slice 4 — TTY automation + 省钱

1. **host-owned TTY automation channel**:`automatedInput(sessionId,text,{reason})` — 取 lock + 确认 idle（Stop、无 pending Q）才 paste;否则排队/暂停;落 synthetic turn;失败退避。
2. **engineer 切 TTY**（claude 吃订阅）;RoleInjector/唤醒走 TTY 路径。
3. **移除 codex-TTY**。

**验证**:claude engineer 在 TTY 下跑完整 loop。**依赖 runtime-modes B 档成熟度。**

---

## 落地后回写（AGENTS.md 协议）

- ADR:角色模型、横纵上下文、action 协议(非 MCP)、loop-controller。
- `docs/ai/MEMORY.md`:三角色、横纵分片规则、action 协议、runtime 跑道。
- `docs/quality/traceability.md`:每 slice 的需求↔代码↔测试。
- proposal 已 Accepted;本 plan 随 slice 进展更新「当前 slice / 验证结果」。

## 当前进度

- **Slice 0:完成**（2026-07-01）。落地件:
  - `packages/host/migrations/028_task_loops_actions.sql` — `task_loops` + `task_actions`（各 13 列、数组 JSON TEXT、FK CASCADE/SET NULL、`action_id` PK 幂等）。经 `openDatabase` 全链临时库验证:schema / 默认值 / FK 级联 / PK dedup 全对。
  - `packages/shared/src/action.ts` — types-only（`Role` / `GianAction` 判别联合 + 三 method params / `TaskLoop` / `TaskAction` / `ActionStatus` / `GIAN_ACTION_OPEN|CLOSE`），已挂 `index.ts`，对 web 打包安全（无 node 依赖）。
  - `packages/host/src/task/action-parser.ts` — 纯函数 `parseGianAction`（尾部规则 + 围栏规则 + 逐 method 校验/归一化）、`computePayloadHash`、`computeActionId`（NUL 分隔、确定性）。
  - `packages/host/test/task-action-parser.test.ts` — 18/18 绿。
  - 验证:`pnpm -F @gian/shared build` + shared/host `typecheck` 干净;parser 单测 18/18;migration 临时库 smoke 全过。**未起 daemon,零现网风险。**
  - traceability:新增 `ACTION-PROTO-001`（COVERED）、`ACTION-DB-001`（GAP,待 storage 断言）。
- **Slice 1:完成**（2026-07-01,上下文引擎 INDIVIDUAL 先行）。落地件:
  - `packages/host/src/task/skill-templates.ts` — 4 个角色 playbook（`SKILL/individual/engineer/pm.md`）作 TS 常量（`tsc`-only build 带进 dist,无 copy 步）。
  - `packages/host/src/workspace/ai-scaffold.ts` — 扩分片布局:新建 `.ai/sessions|log|gian-task/`、materialize playbooks 到 `.ai/gian-task/`（Gian-owned,每次 re-write）、gitignore 派生路径（`sessions/`·`log/`·`.history/`·`STATE.view.md`·`gian-task/`;`MEMORY`/旧单文件仍可提交）、更新 pointer。旧 `STATE/HANDOFF/MEMORY/SESSION_LOG.md` 保留（back-compat）。`.history` 不预建（懒建,保住 P4 abandon 语义）。
  - `packages/host/src/workspace/ai-views.ts`（新）— host 懒生成 `STATE.view.md`:`regenerateStateView`（合并 `sessions/*.state.md`,atomic write）+ `regenerateStateViewIfDirty`（mtime read-on-dirty）。
  - `packages/host/src/task/role-injector.ts`（新）— `roleForSessionType`（coding→individual/subtask→engineer/manager→pm）+ `buildRoleHeader`/`buildFirstTurnRolePrefix`（ROLE 头三变体,§4.8 ①）。shared 加 `GIAN_ROLE_OPEN/CLOSE` + `stripGianRolePrefix`。
  - `packages/host/src/session/manager.ts` — `sendMessage` 接 RoleInjector,**env `GIAN_TASK_ROLES=1` 门控（默认关）**:开则 coding 会话每轮 refresh `STATE.view`、首轮 prepend ROLE 头（structured prepend-first-message 路;同 manager 注入模式,含 items 处理）。新增私有 `getWorkspacePath`。
  - 验:5 包 typecheck 干净;**host 578/578**、**web 355/355**;新单测 ai-scaffold 4 / ai-views 4 / role-injector 5 + storage 加 028 schema 断言。**默认关 → 零现网变化。**
  - traceability:加 `AI-SCAFFOLD-001`/`AI-VIEW-001`/`ROLE-INJECT-001`;`ACTION-DB-001` 因新增 storage 断言 **GAP→COVERED**。
- **未落地（Slice 1 遗留,归 Slice 2-4）**:TTY 的 SessionStart-hook additionalContext 注入（Slice 4）；ENGINEER/PM 的 live spawn+brief 注入（Slice 2-3）；web strip `stripGianRolePrefix` 显示接线（feature 上线时）；RoleInjector 去 env 门控转正。
- **Slice 2:完成**（2026-07-01,action 执行,env `GIAN_TASK_ROLES` 门控）。落地件:
  - `packages/host/src/task/task-store.ts`（新）— `task_loops`/`task_actions` DB 层:insert/get/updateAction、getActiveLoop/insert/updateLoop、`isTerminalStatus`、JSON 数组列 (反)序列化。
  - `packages/host/src/task/action-authorize.ts`（新,纯）— method↔role 硬门（create/message=pm、submit_step=engineer,违者 rejected）+ submit_step anti-spoof（current_step_session_id）+ loop 边界（allowed_methods/executors/workspaces + round budget,空 allowlist=不限）→ execute/staged/rejected。
  - `packages/host/src/task/action-executor.ts`（新）— `handle`（幂等:computeActionId → getAction 终态跳过 → insert → resolve ws → authorize → execute/stage/reject）、`confirmStaged`/`rejectStaged`;deps 注入（resolveWorkspaceId/createSubtask/messageSubtask/writeStepSummary/onStepSubmitted）便于单测。
  - `manager.ts`:`completeTurn` 末尾 env 门控 fire-and-forget `processActionForTurn`（`finalAssistantTextForTurn` 从 events 重建 turn 终态文本 → parseGianAction → executor）;deps 实现 `createSubtaskFromAction`（createSession subtask + 投递 brief）、`deliverToSubtask`、`writeStepSummary`（M5:submit_step 写 `sessions.summary`）、`resolveWorkspaceId`(name|path→id,⑧);public `confirmTaskAction`/`rejectTaskAction`。
  - REST（`app.ts`）:`POST/GET /api/tasks/:id/loop`、`GET /api/tasks/:id/actions`、`POST /api/tasks/:id/actions/:actionId/{confirm,reject}`。
- **Slice 3:完成**（2026-07-01,唤醒+loop）。`task/loop-engine.ts`（新,纯 `advanceLoop`:blocked→pause / pass→done / changes→continue(round++) / 上限→ask-continue）;`handleStepSubmitted`（advanceLoop + updateLoop）+ `wakePmForStep`（找 manager session,digest=verdict/headline/points 非 transcript,structured→sendMessage / TTY→automatedInput）;`deliverToSubtask` 状态机（per-task 隔离 / terminal→failed / TTY→automatedInput / busy→queue+现有 drain / idle→sendMessage）;`startLoop`/`getTaskLoop`/`listTaskActions`。
- **Slice 4:核心完成，破坏性尾巴留后**（2026-07-01）。`SessionManager.automatedInput(sessionId,text,{reason})`（§4A.B host-owned automation channel:always enqueue → idle〔status≠running/pending 且无 pending-Q〕则 pop+paste,busy→queue〔靠现有 Stop-hook `drainTtyQueue`〕,off-TTY→unsupported,paste 失败 re-queue）+ `TtyManager.hasPendingQuestion`;`deliverToSubtask`/`wakePmForStep` 的 TTY 分支改走它。**未做（留 review 后 / daemon 依赖）**:codex-TTY 移除（破坏性）、engineer 默认切 TTY 的 runtime 决策、live PTY 真机验证。
- **验**:5 包 typecheck 干净;**host 602/602**;新单测 action-authorize 10 / loop-engine 5 / action-executor 6 / automated-input 4（+ Slice 0/1 的 41）。**未起 daemon,零现网风险（env 默认关）。**
- **其它遗留**:staged chip 的 web UI + WS 广播（REST 已备,未加 WS type 以避 CONTRACT-001/002 churn）、PM 的 §4.8 ROLE:PM+task-digest 头迁移（仍用旧 `buildManagerPrompt`）、RoleInjector 去 env 门控转正、parse 失败回注 nudge、真 LLM 唤醒的 token 成本验证。
- **Codex review 第一轮已回 + 全修**（2026-07-01,7 findings,**host 606/606**）:①action 去重状态分级(executing→failed / parsed·authorized 崩溃恢复)、②create_subtask 后指 loop `current_step_session_id`(anti-spoof)、③Claude TTY Stop hook 透传 `last_assistant_message`→`handleTtyTurnComplete` 接 parser、④message_subtask queued 不悬空 + `automatedInput` 不抢 FIFO、⑤structured PM 忙→enqueue wake、⑥web `stripGianRolePrefix`+`stripGianActionBlocks`(reconcile+管家渲染)、⑦confirm/reject 校验 task 归属。新单测 crash-recovery×2 / loop-pointing / backlog / TTY-parse。
- **Codex review 第二轮已回 + 全修**（2026-07-01,5 findings,**host 608/608**）:①TTY 幂等键→host per-turn ordinal(`ttyTurnSeq`,`turnKey=sessionId:seq`)、②Codex final-only(`turn.completed.summary.assistantText` 直传,删 delta 兜底)、③message_subtask 投 unsupported TTY→failed、④create_subtask await brief(失败不推进 loop)、⑤web store 层剥 role/action(覆盖普通/子任务渲染,gated 防拆块)。
- **Codex review 第三轮已回 + 全修**（2026-07-01,4 findings,**host 609/609**）:①崩溃 durability——executor `recordParsed`(同步落行)/`driveRecorded`(异步执行)/`resume` + `resumePendingTaskActions` 启动重扫、②TTY 幂等键持久化(migration 030 `tty_turn_seq`)、③`drainTtyQueue` 失败 requeue、④web notifications/inbox strip action。
- **性价比判断**:三轮 findings 7→5→4、severity 递减,剩下全是 env 门控下的崩溃窗/重启边界/次要面。**再来一轮静态 review 的 ROI 已低**;更值的下一步是**真机 8991 跑一个 dev-loop**(env `GIAN_TASK_ROLES=1`,会花 token),真机暴露的问题比第 4 轮 review 更实。
- **下一步 = 真机 8991 验** → 去门控 + 接 web chip + 收 Slice 4 尾巴（codex-TTY 移除、engineer 默认切 TTY、IM strip）。
