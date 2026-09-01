# Changelog

This file records user-facing changes in published Gian builds. It is updated
whenever a version is packaged and tagged for release; local test packages are
not listed.

Releases through 0.5.4 are unsigned macOS Apple Silicon beta builds. Signed
and notarized native notifications and automatic updates remain disabled
until Developer ID signing and notarization are available.

## [0.5.4] - 2026-09-01

### Added

- Added ZCode as a production Agent integration, using the Agent runtime from
  ZCode.app with model, Thinking, approval, permission, native-session, and
  replay support. Workspaces run in isolated app-server processes.
- Added persistent manual ordering for sidebar workspaces, Tasks, and
  Sessions.

### Changed

- Published Codex Proxy 0.2.11, Kimi Proxy 0.2.6, and ZCode Proxy 0.1.0.
- Kimi now provides the ACP terminal service used by its native command tools
  and preserves catalog controls and terminal availability across runtime
  invalidation, detach, and reattach.
- Untitled non-Claude Sessions begin native title discovery as soon as the
  first Turn is accepted instead of waiting for a long Turn to finish.

### Fixed

- Codex capacity failures now settle with their real provider error and leave
  the Session recoverable.
- Side Chats preserve their owning panel, tool details, and inline quoted
  context when switching between parent and child conversations.
- ZCode no longer hangs after provider business errors or loses terminal
  events that share native identities. Permission retries remain one card,
  interrupts cancel the actual foreground execution, and provider request
  headers and identifiers stay out of conversation events.

### Known limitations

- The macOS build remains unsigned and supports Apple Silicon only.
- ZCode requires a separately configured ZCode CLI provider account. Gian
  does not import Desktop authorization or modify `~/.zcode`.
- ZCode Proxy 0.1.0 accepts text only; file and image inputs are not exposed.
- Scheduled Automations and Grok are not included in the 0.5.4 product
  surface.

## [0.5.3] - 2026-08-28

### Added

- Composer can attach files, folders, selected transcript text, and Browser
  elements as context cards, and keep those references inline through copy
  and paste.
- Side Chat can be created and titled explicitly, keep its own model,
  Thinking, Fast, and approval settings, and open from a running Codex turn
  without stopping the parent.
- Live turns show a Working / Worked block with the turn's tool rows, and
  approval or question cards use a shared risk-aware layout.
- Settings range controls use minus / value / plus steppers. AI Agents,
  Adopt, and Archive no longer show unused filters or bulk-delete actions.
- Review headers stay pinned while scrolling, and file navigation stays in
  the inspector.
- Codex sessions receive a session-scoped Gian MCP identity and the
  `gian-session` Skill. A Worktree tool can create and bind a view-only
  checkout without changing the Agent working directory.
- New Sessions bind to a verified Agent runtime profile: exact CLI path,
  CLI version, and Proxy version.

### Changed

- Published Claude Proxy 0.2.3, Codex Proxy 0.2.10, Kimi Proxy 0.2.3, and
  DeepSeek Harness Proxy 0.1.3.
- Gian Tool now authenticates Host-listened MCP and authorizes methods by
  role and direct Session ownership.
- Trace folds tool calls into summaries and compresses idle gaps between
  turns.

### Fixed

- Codex no longer fails large-thread resume, reuses interaction identities
  after restart, or loses Fork actions after recovery and reattach.
- Forked sessions get distinct titles, newly created forks open immediately,
  and the per-turn Fork control hides when the Proxy cannot fork.
- The new-session title and first message no longer overlap.
- DeepSeek Harness multi-step turns no longer reuse one content or finalize
  event identity.

### Known limitations

- The macOS build remains unsigned and supports Apple Silicon only.
- Grok is not included in the 0.5.3 product surface.

## [0.5.2] - 2026-08-25

### Added

- Settings now manages user AI Agents (name, color, Proxy, CLI path, and
  defaults) instead of one executor per kind. New sessions and the composer
  list only ready Agents, and each session stays bound to the Agent that
  created it.
- Live turns collect tool, command, and search activity into a 5-line
  Activity box. Clicking it opens the full event feed in the side panel.
- Added Gian Tool v0, a local CLI and MCP control plane for Task, Session,
  and approval operations. Gian sessions do not receive it automatically.
- Side Chat and Session Fork now work on Claude, Codex, and Kimi, not just
  the protocol and UI shell.
- Codex traces render as a semantic timeline instead of a flat tool list.

### Changed

- Published Claude Proxy 0.2.2, Codex Proxy 0.2.3, and Kimi Proxy 0.2.2
  with Side Chat, Fork, and the transcript and approval fixes below.
- Codex catalogs now advertise the Fast service tier where the selected
  model supports it.

### Fixed

- Stopped Claude Code thinking-token heartbeats from flooding the
  transcript and freezing the page.
- Codex MCP tool approvals now send the native accept, session, decline,
  and cancel responses the app-server expects.
- Long completed-turn summaries open the side-panel event feed instead of
  expanding hundreds of rows inline.

### Known limitations

- The macOS build remains unsigned and supports Apple Silicon only.
- Grok is not included in the 0.5.2 product surface.

## [0.5.1] - 2026-08-24

### Fixed

- Settings and new-session now consume Proxy v2 catalogs safely, so Kimi
  models stay visible and thinking is resolved per selected model.
- Restored Codex semantic approval presets in the catalog-backed mode
  control.
- Allowed DeepSeek Harness Task subtask creation and persisted native
  session ids so a second DSH create no longer collides.

### Changed

- Published Codex Proxy 0.2.1, Kimi Proxy 0.2.1, and DeepSeek Harness
  Proxy 0.1.1 with those catalog and DSH session fixes.

### Known limitations

- The macOS build remains unsigned and supports Apple Silicon only.
- Grok is not included in the 0.5.1 product surface.

## [0.5.0] - 2026-08-22

### Added

- Added DeepSeek Harness (DSH) as a managed Agent integration, including its
  Gian profile, Bridge bundle, Proxy, runtime discovery, and installer flow.
- Added Proxy-owned model, effort, permission-mode, and capability catalogs
  through the `gian.proxy/2.0` protocol for Claude Code, Codex, Kimi Code, and
  DeepSeek Harness.
- Added durable Side Chats and session forks where the selected Agent reports
  support for them.
- Added an Execution Trace with step trees, requests, structured interactions,
  and replayed session evidence.

### Changed

- Made Proxy catalogs authoritative for new-session and Settings controls, and
  hardened turn lifecycle, queued-message, replay, and event identity handling.
- Hid Grok from onboarding, Settings, and new-session choices for this release.

### Fixed

- Restored Claude replay, Kimi plan projection, and Codex structured question
  handling across the Proxy 2.0 bridge.
- Fixed DSH activity completion, replay identifiers, error codes, and packaged
  Bridge discovery.
- Fixed the Settings panel layout race that could appear after changing zoom.

### Known limitations

- The macOS build remains unsigned and supports Apple Silicon only.
- Grok is not included in the 0.5.0 product surface.

## [0.4.5] - 2026-08-15

### Added

- Reworked the Settings Appearance and Chat sections: theme, locale, and
  zoom are dropdowns; accent swatches are rounded squares; chat font size
  (12–20 px, default 14) and font family are selectable.
- Made every in-app keyboard shortcut remappable from Settings — command
  palette, steer / send-now, child sessions, unread, approval keys, and the
  global screenshot shortcut — with conflict detection, per-row reset, and
  live rebinding of the screenshot shortcut.
- Added “Check for updates” to the Settings Proxy rows: the newest
  compatible Proxy release can be discovered and installed from Settings.
- Added an optional preference to hide the Gian main window during
  screenshots (kept visible by default so the frozen desktop includes Gian).
- Speeded up screenshots by reusing the warm-up page and parallelizing
  capture preparation.
- New-session page image thumbnails can be zoomed in from the attachment
  chips.

### Fixed

- Restored the action-menu separators and the new-session title divider with
  an inset style after the all-dividers-hidden pass blanked them.
- Long hint and conflict text no longer squeeze the shortcuts keycap column
  in Settings; both now span the row as subdued full-width lines.
- Approval cards for Grok and Kimi no longer render empty. The command being
  approved (or the fallback approval title) is now surfaced as the card body,
  so pending approvals show what they are asking to run.
- Requires Grok Proxy 0.2.1 (released with this build) which fixes Grok
  sessions terminating on protocol turn-id mismatches.

## [0.4.4] - 2026-08-14

### Added

- Aligned the Grok Build integration with Grok Build CLI 1.0.3’s ACP protocol:
  each Gian Grok session now runs its own Proxy and agent process scoped to
  that session’s working directory, with native session list/adopt/delete,
  slash-command filtering, resource-link attachments, and recommended CLI
  version hints.
- Added support for current Grok Build CLI agent flags.

### Fixed

- Fixed the per-task … menu being clipped by the sidebar; it now opens as a
  viewport-clamped popover aligned to its trigger.
- Fixed in-app Browser links always opening a new tab and loading project pages
  at their workspace-relative URLs so parent-relative assets resolve.
- Fixed Files preview for paths outside the current working tree, such as
  session attachments.
- Sped up clipboard screenshot capture.
- Fixed native configuration error messages to use the executor’s proper name
  (for example, “Kimi”) instead of the raw executor id.

## [0.4.3] - 2026-08-13

### Added

- Added signed macOS native notifications for completed turns, pending
  approvals and questions, and terminal errors, including background sessions
  and the red-close/no-window state.
- Added background App update checks and downloads, an Updates settings surface
  that shows the installed version and supports manual checks, and explicit
  restart-to-install behavior using the stable GitHub Releases channel.
- Added fail-closed signed/notarized release configuration and deterministic
  `latest-mac.yml` artifact verification for the DMG and ZIP update assets.

### Changed

- Moved desktop notification delivery from the active renderer transcript to
  an Electron-main subscription over a small privacy-bounded Host attention
  protocol, preventing background sessions from leaking full transcripts.
- Made the 0.4.3 DMG the one-time manual bridge from unsigned 0.4.2 builds;
  automatic updates begin with upgrades from 0.4.3 to later signed releases.
- Made update installation follow Gian's safe shutdown boundary: downloads
  never interrupt work, while an explicit confirmed restart first stops the
  managed Host and CLI processes before arming replacement.

### Known limitations

- Complete Inbox/read-state synchronization, APNs remote push, and notification
  generation after Gian has fully quit remain outside the 0.4.3 scope.

## [0.4.2] - 2026-08-12

### Added

- Added independently versioned Claude, Codex, and Kimi Proxy plugins using
  the `gian.proxy/1` compatibility contract, so compatible Agent integrations
  can update separately from the desktop app.
- Added a composer-first new-session flow with workspace, Agent, model, effort,
  mode, and service-tier selection before the first message is sent.

### Changed

- Upgraded the bundled Host runtime and all source, CI, release, and daemon
  install gates to Node.js 24 LTS.
- Refined Diffs, Git History, worktree identity, queue presentation, and
  inspector controls for denser and more predictable review workflows.
- Improved transcript, session, Provider retry, and multi-window recovery so
  stale progress and failed optimistic state do not survive canonical refreshes.

### Fixed

- Fixed Event Storage v3 migration verification for JSON artifacts that
  contain nested artifact references, so valid transitive links no longer stop
  an otherwise lossless offline migration.
- Fixed Claude OAuth and API terminal errors being projected as successful
  completed replies; Gian now keeps the provider error and ends the turn as
  failed.
- Fixed fresh packaged profiles failing before onboarding when no managed
  Agent Proxy has been installed yet.

## [0.4.1] - 2026-08-09

### Added

- Added a singleton multi-diff inspector that keeps file, history, and
  transcript diffs in one consistent review surface.
- Added stronger release canaries for Codex compatibility and steering, Kimi
  session-store compatibility and lifecycle behavior, and provider attachments.

### Changed

- Refined Git History with compact single-line commits, branch-chain graph
  colors, clearer filters, bounded lanes, and continuous loading.
- Made Plan, Agent, and Diff underbar panels mutually exclusive, with predictable
  toggle, outside-click, and Escape behavior.
- Improved transcript minimap and message navigation behavior across narrow and
  wide chat layouts.

### Fixed

- Stabilized transcript identities, hydration, terminal state, and history
  recovery so provider updates cannot leave duplicate or stale cards behind.
- Preserved color-rendered transcript diffs while reusing pinned detail tabs.
- Hardened Browser view detachment, Agent runtime replacement, Proxy exit
  recovery, watcher restart behavior, and Kimi session-store downgrade safety.

## [0.4.0] - 2026-08-08

### Added

- Added an isolated multi-tab Browser for project HTML and regular web content,
  with separate history per tab and no Node or preload access to page content.
- Added Git History inspection for branches, commits, and changed files directly
  beside the active coding session.
- Redesigned transcripts with compact single-line event rows, turn folding,
  context panels, and richer Sheet detail views.
- Added controlled Event Storage v3 migration tooling to keep durable session
  history responsive as transcripts grow.

### Changed

- Simplified the workbench layout, panel behavior, breadcrumb identity, and
  device-local zoom controls for a more focused coding surface.
- Improved native session recovery, worktree context refresh, queue behavior,
  and changed-file inspection across reconnects and provider restarts.

### Fixed

- Hardened Agent CLI and managed Proxy updates so active runtimes retain their
  leases until process cleanup completes.
- Fixed duplicate Codex recovery callbacks, delayed Proxy bring-up events, and
  several workspace, session-finalization, and file-preview safety boundaries.

### Known limitations

- Event Storage v3 migration remains an explicit maintenance operation; it is
  not an automatic startup compaction or database-size reduction step.

## [0.3.0] - 2026-08-07

### Added

- Added an Unfiled session group so sessions remain accessible after their
  workspace is deleted.
- Added paged transcript history and bounded replacement of mutable event
  snapshots to keep long-running sessions responsive.
- Added deterministic pending and optimistic feedback for user actions, with
  reconciliation after failures, timeouts, or reconnects.

### Changed

- Last-turn file changes now open directly in the Diffs inspector, including
  changes viewed from a workspace's primary checkout.
- Working-tree and branch view selections now persist per session across
  reloads without changing the Agent's execution directory.
- Agent discovery and sidebar data loading now avoid repeated blocking probes
  and unnecessary full-session event subscriptions.

### Fixed

- Fixed relative transcript links that became unresponsive when the linked
  file was created after the transcript first loaded.
- Fixed packaged Workbench Terminal startup when `node-pty` was already loaded
  from the unpacked application directory.
- Fixed workspace deletion being blocked by existing sessions or worktrees;
  surviving sessions now lose only their workspace affiliation.

### Known limitations

- Event-storage v3 artifact offloading and compaction are not activated as an
  automatic startup migration. Existing large databases remain compatible but
  are not physically reduced by this release.

## [0.2.1-hotfix] - 2026-08-06

### Fixed

- Reattached Kimi sessions automatically after an in-place managed Proxy
  update removed the live Proxy connection. Sending a message no longer fails
  with `no proxy for session` while a stale session ID remains cached.

## [0.2.1] - 2026-08-06

### Added

- Added a current-turn change indicator that opens the files changed by the
  latest agent turn.
- Expanded the Changes inspector with Last Turn, working-tree, individual
  commit, and branch comparison sources, including commit and base-branch
  pickers.
- Preserved unsent text and uploaded attachments per session, including across
  session switches and reloads.
- Added attachment previews and inline text editing to queued messages.
- Added provider-driven model, thinking-level, and permission-mode choices for
  Kimi, plus Claude model discovery from the configured
  `availableModels` list.

### Changed

- Improved transcript navigation with user-message minimap markers, previous
  and next controls, and a scroll-to-bottom action.
- Streaming output now follows the bottom only while the reader is already at
  the bottom, so reading earlier transcript content is no longer interrupted.

### Fixed

- Applied configured Kimi model, thinking level, and mode when creating a new
  session.
- Kept the Changes inspector toggle available after the inspector was hidden.

## [0.2.0] - 2026-08-04

### Added

- Added an Archived view in Spaces with Restore and confirmed permanent Delete
  actions for archived sessions.
- Added version-aware managed Proxy status and checksum-verified in-place
  updates when an installed Proxy is older than the Gian release.
- Completing a Task now archives its sessions, and reopening it restores them
  without changing each session's own completion state.

### Changed

- Focused Tasks on grouping sessions rather than autonomous project
  management.
- Simplified search to find active sessions by name.
- Removed the autonomous Task Manager and action loop, automatic AI workspace
  summary writeback, embedded Browser, Sidechat, Discord and Slack bots, dock
  badge, and file or command palette search from the beta product scope.
- Saving a custom Agent CLI path now uses a confirmed desktop relaunch so the
  next session starts with the selected runtime.

### Fixed

- Isolated GianDev launch configuration from inherited production settings.
- Preserved Task archive and restore behavior after removing the autonomous
  manager runtime.

## [0.1.2] - 2026-08-04

### Added

- Added an explicit connected-GitHub first step to onboarding, with Back and
  Continue navigation.
- Allowed onboarding to finish when any one Agent CLI and Proxy pair is ready;
  the other Agents remain optional and can be configured later.

### Changed

- Treated the selected directory as the parent directory for projects. New
  projects are now created directly under it instead of inside an additional
  `workspaces` directory.
- Reduced the directory preview to the Agent worktree convention and removed
  the redundant bulk Agent initialization action.

### Fixed

- Preserved npm and wrapper launcher paths, together with their companion Node
  runtime directories, so packaged Gian can detect and run installed Agent
  CLIs under Finder's minimal environment.

## [0.1.1] - 2026-08-04

### Fixed

- Replaced the unusable GitHub OAuth configuration from 0.1.0.
- Added a release-time GitHub Device Flow check so a build cannot be published
  with a missing or invalid OAuth client ID.

## [0.1.0] - 2026-08-03

### Added

- Shipped the first Gian macOS beta with one desktop interface for Codex,
  Claude Code, and Kimi Code.
- Added structured live transcripts for assistant output, plans, tool calls,
  commands, file changes, approvals, and errors.
- Added multiple concurrent sessions, queued follow-up messages, stop and
  steering controls, Tasks, isolated Git worktrees, Files, Diffs, and a
  workspace terminal.
- Added native session discovery and resume, local SQLite storage, GitHub
  onboarding, official CLI discovery, and versioned Gian Proxy downloads.
- Included the original experimental Task Manager, Sidechat, Browser, and
  Discord or Slack integrations that were later removed from the 0.2 beta
  scope.

### Known Issues

- The published build contained a placeholder GitHub OAuth client ID and could
  not complete first-run login. It was superseded by 0.1.1.

[0.5.4]: https://github.com/RichLogic/Gian/releases/tag/v0.5.4
[0.5.3]: https://github.com/RichLogic/Gian/releases/tag/v0.5.3
[0.5.2]: https://github.com/RichLogic/Gian/releases/tag/v0.5.2
[0.5.1]: https://github.com/RichLogic/Gian/releases/tag/v0.5.1
[0.5.0]: https://github.com/RichLogic/Gian/releases/tag/v0.5.0
[0.2.1-hotfix]: https://github.com/RichLogic/Gian/releases/tag/v0.2.1-hotfix
[0.2.1]: https://github.com/RichLogic/Gian/releases/tag/v0.2.1
[0.2.0]: https://github.com/RichLogic/Gian/releases/tag/v0.2.0
[0.1.2]: https://github.com/RichLogic/Gian/releases/tag/v0.1.2
[0.1.1]: https://github.com/RichLogic/Gian/releases/tag/v0.1.1
[0.1.0]: https://github.com/RichLogic/Gian/releases/tag/v0.1.0
