# Chat 原生事件与页面展示契约

## 决策

Gian 不再把 Claude Code、Codex、Kimi Code 的事件统一成一套跨 CLI
事件名。Host 保留 provider、CLI 原生事件名和原始 payload；provider adapter
只附加一个可替换的 `display`，回答“当前页面把它显示成什么”。

一个原生事件可以对应多个展示。例如 Claude 写 plan 文件时，`tool.use`
同时产生文件 Activity 和页面 Plan。没有页面含义的新事件仍然落库和广播，
但不带 `display`，页面忽略它；升级 CLI 后可以据此补映射，不会丢原始证据。

```json
{
  "type": "event",
  "provider": "claude",
  "event": "output.text",
  "data": { "itemId": "msg-1", "text": "done" },
  "display": {
    "type": "message",
    "data": { "itemId": "msg-1", "text": "done", "delta": false }
  }
}
```

`event/data` 属于 CLI；`display` 属于 Gian UI。两者不能混成一套协议。

## 当前 UI 分类

| 页面分类 | `display.type` | 页面位置/表现 |
|---|---|---|
| Message | `message` | assistant 消息气泡 |
| Activity | `activity.reasoning`、`activity.command`、`activity.file-change`、`activity.file-read`、`activity.file-search`、`activity.web-search`、`activity.tool`、两种 auto notice | Transcript 中的过程行、工具卡或 diff |
| Plan | `plan` | Composer 上方持久 Plan 区，不进入普通 transcript |
| Agent | `agent` | transcript 锚点 + Composer 上方持久 Agent 区 |
| Interaction | `interaction.question`、`interaction.approval`、`interaction.resolved` | 问题卡、审批卡及其结果 |
| State | `state.turn-started`、`state.turn-completed`、`state.error` | pending、轮次结束、错误/通知状态 |

所以“Agent / Plan / Question / 普通事件”的理解基本正确；完整页面模型还要把
Message 和 State 单列。Question 属于 Interaction，但有独立卡片。

## 三个 CLI 的对应关系

| UI | Claude Code 原生来源 | Codex 原生来源 | Kimi Code 原生来源 |
|---|---|---|---|
| Message | `output.text` | `output.text.delta` | `acp.sessionUpdate: agent_message_chunk` |
| Activity | `tool.use`、auto notice | reasoning/command delta、`diff.updated` | ACP thought/tool call/update |
| Plan | plan 文件的 `tool.use` 投影 | `output.plan.delta/final` | ACP `plan/plan_update` |
| Agent | `tool.use Agent/Task`、`claude.task` | `codex.agent` | ACP Agent tool lifecycle |
| Question | `approval.requested` + AskUserQuestion 结构 | 当前无独立 question 来源 | 当前走原生 permission options，不伪装成统一 question |
| Approval | `approval.requested/resolved` | `approval.requested/resolved` | `approval.requested/resolved` |
| State | `turn.started/completed/failed`、`runtime.error` | 同名 lifecycle/runtime 通知 | 同名 lifecycle/runtime 通知 |

## 冒烟测试分层

1. Provider fixture → display：离线、零模型费用。固定原生通知，断言原生事件名和
   payload 原样保留、display 分类正确、未知事件不被编造含义。
2. Display → Web：离线、零模型费用。把带 display 的原生 envelope 交给页面
   reducer，断言 Message/Activity/Plan/Agent/Question/State 的实际页面模型。
3. Host DB/WS/replay：离线、零模型费用。断言原生名称落库、display 回放、旧历史
   兼容、JSONL watcher、审批与 turn 状态仍工作。
4. 真 CLI：按版本升级或新接入时运行。用固定 prompt 触发文本、工具、Plan、Agent、
   Question/Approval 和结束状态，再核对收到的原生事件及页面展示。可以选该 CLI
   支持的最便宜模型；它验证的是协议和展示链路，不评价回答质量。Plan/Agent/
   Question 仍可能受模型行为影响，因此真 CLI 层应允许重试，并以离线层作为稳定门禁。

当前自动门禁是前三层；不会在普通测试中调用付费模型。Claude Code 另有版本化
JSONL/proxy fixture；升级任一 CLI 时应先保存新版本原生通知，再更新对应 fixture，
只有确认 display 变化是预期行为后才修改断言。
