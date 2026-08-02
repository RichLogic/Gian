# Project state - current snapshot

> Read at the start of every session. Update at the end of every turn.
> Keep only current state; history belongs in `SESSION_LOG.md`.

## Active work item

**2026-08-01 侧栏增强 + 新建会话页重构已实现，未提交（叠加在下面的
release/onboarding 未提交工作之上）。**

- 侧栏 workspace 组行 hover 出现 "+"（以该 workspace 预填打开新建表单）
  和 pin（置顶，pinned 组排在前面，组内保持 sort_order）。
- 侧栏 session 行 hover 出现 pin（`session:pin`，`sessions.pinned_at`，
  组内 pinned 优先）和 archive（接通已有的 `session:archive` 链路）。
- 新建会话页只保留 workspace / agent / name（optional）；agent 选择器
  数据驱动自 `GET /api/agents` 的 ready 状态，为后续插件化铺路；approval
  mode/worktree/first message 字段移除（worktree 创建统一走 Spaces
  new-worktree-dialog；非 Kimi 默认 `approval_mode: 'ask'`）。
- 命名决策：代码继续用 `executor`，UI 文案显示 Agent（用户拍板
  2026-08-01）；executor→agent 的代码层改名等插件 manifest 落地时再做。
- 新迁移：043 `sessions.pinned_at`、044 `workspaces.pinned`。

**2026-08-01 Gian v0.1 release slice + Web UI cleanup + three-step desktop
onboarding are implemented but uncommitted in the current working tree.**

- Electron first-run initialization now uses GitHub OAuth Device Flow with no
  requested scopes. Main owns the exchange and receives the access token;
  renderer/Host receive only the public profile.
- The token is encrypted through Electron/macOS `safeStorage` in the Electron
  profile. Cached profile state supports offline relaunch; Settings → Account
  shows the profile and removes the local credential on sign-out.
- Browser-only development retains the existing Host password boundary.
- Release builds embed the public OAuth Client ID from
  `GIAN_GITHUB_CLIENT_ID`; the tag workflow requires repository variable
  `GIAN_GITHUB_CLIENT_ID`. No client secret or Gian login server is used.
- After GitHub login, Electron now gates the product shell on Agent setup and
  project-directory selection. Codex, Claude Code, and Kimi Code each require
  a usable official CLI plus the matching Gian Proxy. Existing CLI paths are
  detected or can be configured; missing CLIs use vendor installers and
  packaged Proxy artifacts come from `RichLogic/Gian` GitHub Releases.
- `workspace_root` is the selected project parent (default `~/Coding`). Gian
  creates new managed workspaces under `<workspace_root>/workspaces`; adopted
  repositories keep their existing path. Settings can rerun initialization.
- Earlier uncommitted work remains present: self-contained Electron/Host
  release path, Agent CLI/proxy setup, UI dead-code cleanup, full-screen flash
  fix, design-token cleanup, Sessions/Spaces/Settings refinements, and the
  Codex 0.146 experimental capability fix.

## Verification

- 侧栏/建会话页改动（2026-08-01）：Shared/Host/Web typecheck + serial
  build 通过；Host 602/602（含 setPinned、workspace-pin 3 例）；Web
  369/369（含 ses-001 payload 5 例、NewSessionView 组件 5 例、rail 排序
  纯函数 4 例）；e2e 14/14（spec 02 重写表单两例 + 新增组行 "+" 预填、
  行 hover pin/archive 两例）；`pnpm quality:traceability` 163 行通过；
  `git diff --check` 通过。注意：8991/5191 曾被 /tmp 旧 worktree 的残留
  dev 进程占用导致 e2e 误测旧代码，已 kill（30108/30135）后复跑通过。
- Shared, Host, and Web typechecks: passed under Node 22.18.0.
- Serial `pnpm -r build`: passed. A parallel build while dev watchers were
  active raced clean/output directories; stopping watchers and building
  serially passed.
- Host suite: 598/598 passed.
- Web suite: 364/364 passed, including the two new onboarding UI cases.
- Onboarding Host state/path tests: 2/2 passed.
- `pnpm quality:traceability`: passed, 160 rows.
- Desktop suite: 21/21 passed, including no-scope Device Flow, denial,
  encrypted-at-rest credential, and packaged Client ID resolution.
- GitHub login Web tests: 4/4 passed across startup gating and Device Flow UI.
- GianDev real-window smoke passed with the existing GitHub identity: step 2
  displayed all three installed CLIs and development Proxies as ready. Step 3
  was intentionally left for the user to inspect/complete.
- GianDev now receives an explicit `development` identity through
  main→preload and overlays a top-right `DEV` pill on its dynamic favicon/Dock
  icon. Packaged production Gian receives `production` and remains unbadged.
- Desktop typecheck + 21/21 tests and Web typecheck + 366/366 tests passed for
  the dev-icon change; traceability passed at 161 rows and `git diff --check`
  passed. GianDev was restarted on 8991/5191 after the change.
- Unsigned arm64 `.app` packaging passed with a placeholder Client ID, and the
  packaged `Resources/runtime/github-auth.json` contained that value. The final
  recursive build then cleaned the generated `.app`; no placeholder package
  remains.
- `git diff --check`: passed.

## Blocker

No code blocker. Public first-run completion still depends on publishing the
three version-matched Proxy assets in the Gian GitHub Release.

## Next step

1. Publish versioned Proxy assets to a test GitHub Release.
2. Run an empty-profile packaged-App smoke covering real Proxy downloads,
   missing-CLI handling, directory selection, restart, and Settings rerun.
3. Review and commit the current combined release/UI/onboarding work only after user
   confirmation.
