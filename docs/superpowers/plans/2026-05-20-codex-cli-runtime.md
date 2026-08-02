# Codex CLI runtime — implementation plan

> **For agentic workers:** implement task-by-task. Keep each step small,
> run the listed verification before moving on, and do not mix this with the
> later Codex JSONL/notification normalizer work.

**Goal:** Codex sessions get the same session-header `CLI` runtime option that
Claude sessions already have. Switching a Codex session to CLI starts a real
interactive `codex resume <native_session_id>` in a PTY, streams bytes through
the existing `pty:*` WebSocket messages, and preserves history with the current
CHAT/app-server path.

**Spec:** `docs/superpowers/specs/2026-05-20-codex-cli-runtime-design.md`

**S0 result:** Passed on 2026-05-20 with `codex-cli 0.130.0`. A 0-turn
`thread/start` UUID (`019e4541-7ce7-7aa1-9a09-3e626bb4479f`) could be resumed
by `codex resume <uuid>` in a PTY. Existing `codex-proxy-client.test.ts`
confirms host facade routing is keyed by `params.sessionId`; implementation
must keep `params.sessionId = proxySessionId` and carry `gianSessionId`
separately in `tty.*` payloads.

**Out of scope:**
- Codex JSONL/sqlite tailing into unified events.
- cwd `chokidar` FileChanged mirror.
- `/internal/hooks/codex/*`.
- CLI-mode `message:send` paste bridge. This chunk rejects structured sends
  while a session is in CLI mode.
- 0-turn fallback. Direct resume is verified for the current Codex CLI.

---

## File map

**Create:**
- `packages/proxies/codex-proxy/src/runtime/tty-codex-runtime.ts`
- `packages/proxies/codex-proxy/src/core/tty-service.ts`
- `packages/proxies/codex-proxy/test/tty-codex-runtime.test.ts`
- `packages/host/src/tty/codex-manager.ts`
- `packages/host/test/codex-tty-manager.test.ts`
- `packages/host/test/session-switch-runtime.test.ts` if no focused file exists
- `docs/adr/NNNN-codex-cli-runtime.md`

**Modify:**
- `packages/proxies/codex-proxy/package.json`
- `packages/proxies/codex-proxy/src/core/service.ts`
- `packages/proxies/codex-proxy/src/cli/spawn.ts`
- `packages/host/src/proxy/codex-proxy-client.ts`
- `packages/host/src/session/manager.ts`
- `packages/host/src/web/ws-handler.ts`
- `packages/host/src/web/app.ts`
- `packages/web/src/views/CodingView.tsx`
- `packages/host/test/contract-003-proxy-methods.test.ts`
- `packages/host/test/contract-004-notification-parity.test.ts`
- `docs/quality/traceability.md`
- `docs/quality/risk-register.md`
- `docs/ai/STATE.md`
- `docs/ai/SESSION_LOG.md`

---

## Task 1: Codex PTY runtime in codex-proxy

**Files:**
- Modify: `packages/proxies/codex-proxy/package.json`
- Create: `packages/proxies/codex-proxy/src/runtime/tty-codex-runtime.ts`
- Create: `packages/proxies/codex-proxy/test/tty-codex-runtime.test.ts`

- [ ] Add `node-pty` to `dependencies` and add a `postinstall` that reuses
  `../cc-proxy/scripts/fix-node-pty-permissions.cjs`.
- [ ] Write a fake `PtyFactory` test harness before the implementation.
- [ ] Implement `TtyCodexRuntime` with `Map<gianSessionId, TtySession>`,
  1 MiB ring buffer, `spawnSession`, `writeBytes`, `pasteMessage`,
  `resize`, `killSession`, `removeSession`, `snapshotBase64`,
  `isSessionAlive`, and `stop`.
- [ ] Spawn args must be:

```ts
['resume', codexThreadId, '-C', cwd, '--add-dir', cwd, ...(model ? ['-m', model] : [])]
```

- [ ] Emit runtime events with both ids available to the service:
  `output(gianSessionId, proxySessionId, chunk)` and
  `exited(gianSessionId, proxySessionId, code, signal)`.

**Verify:**
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/codex-proxy test -- tty-codex-runtime`

---

## Task 2: TTY JSON-RPC service and codex-proxy CLI wiring

**Files:**
- Create: `packages/proxies/codex-proxy/src/core/tty-service.ts`
- Modify: `packages/proxies/codex-proxy/src/core/service.ts`
- Modify: `packages/proxies/codex-proxy/src/cli/spawn.ts`
- Modify: `packages/host/test/contract-003-proxy-methods.test.ts`
- Modify: `packages/host/test/contract-004-notification-parity.test.ts`

- [ ] Add `TtyCodexService` methods:
  `tty.start`, `tty.input`, `tty.resize`, `tty.replay`, `tty.kill`.
- [ ] `tty.start` params must include
  `{ gianSessionId, proxySessionId, codexThreadId, cwd, cols, rows, model }`.
- [ ] Notifications must be:

```ts
emitEvent('tty.output', { sessionId: proxySessionId, gianSessionId, data })
emitEvent('tty.exited', { sessionId: proxySessionId, gianSessionId, code, signal })
```

- [ ] Wire the service in `spawn.ts` next to the existing structured service.
- [ ] Add `tty.*` to codex-proxy `initializePayload().methods`.
- [ ] Update CONTRACT-003/004 comments and whitelists. Do not leave stale
  "TTY runtime switching pruned" / "out of scope" wording.

**Verify:**
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/codex-proxy test`
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/host exec node --test --import tsx test/contract-003-proxy-methods.test.ts test/contract-004-notification-parity.test.ts`

---

## Task 3: Host codex-proxy client wrappers

**Files:**
- Modify: `packages/host/src/proxy/codex-proxy-client.ts`
- Modify: `packages/host/test/codex-proxy-client.test.ts`

- [ ] Expose the current `proxySessionId` from `CodexProxySessionClient`
  through a narrow getter or internal method. Keep it read-only.
- [ ] Add facade methods:
  `ttyStart`, `ttyInput`, `ttyResize`, `ttyReplay`, `ttyKill`.
- [ ] `ttyStart` should fail clearly if `createSession` has not populated
  `proxySessionId`; callers should normally have run `ensureProxySession`.
- [ ] Extend the fake proxy fixture or add a small fixture branch that emits
  `tty.output` with `{ sessionId: proxySessionId, gianSessionId }`, and assert
  it reaches only the matching facade with `gianSessionId` preserved.

**Verify:**
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/host exec node --test --import tsx test/codex-proxy-client.test.ts`

---

## Task 4: Host CodexTtyManager and runtime switch routing

**Files:**
- Create: `packages/host/src/tty/codex-manager.ts`
- Create/modify: `packages/host/test/codex-tty-manager.test.ts`
- Modify: `packages/host/src/session/manager.ts`
- Modify: `packages/host/test/session-switch-runtime.test.ts`
- Modify: `packages/host/src/web/app.ts`

- [ ] Implement `CodexTtyManager` with `start`, `stop`, `input`, `resize`,
  `replay`, `handleProxyNotification`, and `persistMode`.
- [ ] `start` requires `session.native_session_id`; it calls
  `CodexProxySessionClient.ttyStart` with `gianSessionId`, `proxySessionId`,
  `codexThreadId`, cwd, model, and geometry.
- [ ] `handleProxyNotification` uses `params.gianSessionId` for
  `pty:output` / `event` broadcasts. `params.sessionId` is only the
  proxy-facade routing key.
- [ ] Add `SessionManager.setCodexTtyManager` or constructor injection.
- [ ] `switchRuntime` dispatches by executor:
  Claude -> existing `TtyManager`; Codex -> new `CodexTtyManager`.
- [ ] Add server-side guard for finalized worktree sessions before switching.

**Verify:**
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/host exec node --test --import tsx test/codex-tty-manager.test.ts test/session-switch-runtime.test.ts`

---

## Task 5: WebSocket PTY routing and CLI-mode send guard

**Files:**
- Modify: `packages/host/src/web/ws-handler.ts`
- Modify: `packages/host/src/session/manager.ts`
- Add/modify host tests for `message:send` / queue behavior

- [ ] Add `codexTty?: CodexTtyManager` to `WsHandlerDeps`.
- [ ] For `pty:input`, `pty:resize`, and `pty:replay-request`, look up the
  session and route to `tty` or `codexTty` based on `session.executor`.
- [ ] In `sendMessage`, reject early when `session.runtime_mode === 'tty'`
  before inserting turns/events or pausing watchers.
- [ ] In `sendQueuedNow`, check runtime before `popNext` so queued text is not
  lost if a CLI-mode session rejects structured turns.
- [ ] In `maybeAutoSendNext` / job continuation paths, do not pop or send when
  the session is in CLI mode.

**Verify:**
- Focused host tests for:
  - `message:send` in CLI mode inserts no turn/event and does not call
    `turn.start`.
  - `sendQueuedNow` in CLI mode preserves the queued head.
  - `pty:*` routes to the Codex manager for Codex sessions and the Claude
    manager for Claude sessions.

---

## Task 6: Web UI enablement

**Files:**
- Modify: `packages/web/src/views/CodingView.tsx`
- Add/modify web test if a focused header/runtime-toggle test exists

- [ ] Change `ttySupported` to
  `session.executor === 'claude' || session.executor === 'codex'`.
- [ ] Keep the button label generic (`CLI`).
- [ ] Do not add Codex-specific icons or copy in this chunk.
- [ ] Confirm existing `Terminal` / `makeSessionWire(ws, sessionId)` is reused
  without executor-specific branches.

**Verify:**
- Existing web tests that cover `CodingView` still pass.
- Manual smoke in Task 8 confirms the button is enabled for Codex sessions.

---

## Task 7: Traceability, risk, and ADR

**Files:**
- Modify: `docs/quality/traceability.md`
- Modify: `docs/quality/risk-register.md`
- Create: `docs/adr/NNNN-codex-cli-runtime.md`
- Modify: `docs/ai/STATE.md`
- Modify: `docs/ai/SESSION_LOG.md`

- [ ] Add `CODEX-TTY-001` to traceability. Initial status should stay `GAP`
  unless a future automated harness proves real `codex resume` history
  continuity; fake PTY tests are not enough for `COVERED`.
- [ ] Update R-003 with implementation result.
- [ ] Write ADR: Codex CLI uses `codex resume <native_session_id>`; 0-turn
  direct resume was verified on `codex-cli 0.130.0`; no fallback in this
  chunk; `tty.*` routing uses `sessionId=proxySessionId` plus `gianSessionId`.
- [ ] Update STATE and SESSION_LOG per AGENTS.md.

**Verify:**
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm run quality:traceability`

---

## Task 8: Full verification and manual smoke

**Automated:**
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -r typecheck`
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/codex-proxy test`
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/host test`
- `env PATH=/Users/rich/.nvm/versions/node/v22.18.0/bin:$PATH pnpm -F @gian/web test` focused if full web suite is noisy

**Manual smoke on GianDev ports only (`8991` / `5191`):**
- New Codex session -> click `CLI` -> xterm shows interactive Codex TUI.
- Codex CHAT turn -> switch to CLI -> TUI resumes the same history.
- CLI message -> switch back to Chat -> next Chat turn continues the CLI
  context.
- Refresh browser while in CLI -> replay restores recent output.
- While in CLI, web/IM `message:send` path returns clear error rather than
  starting a structured turn.
- Existing Claude CLI switch still works.
