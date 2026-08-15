# Changelog

This file records user-facing changes in published Gian builds. It is updated
whenever a version is packaged and tagged for release; local test packages are
not listed.

Releases through 0.4.5 are unsigned macOS Apple Silicon beta builds. Signed
and notarized native notifications and automatic updates remain disabled
until Developer ID signing and notarization are available.

## [0.4.5] - 2026-08-15

### Fixed

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

[0.2.1-hotfix]: https://github.com/RichLogic/Gian/releases/tag/v0.2.1-hotfix
[0.2.1]: https://github.com/RichLogic/Gian/releases/tag/v0.2.1
[0.2.0]: https://github.com/RichLogic/Gian/releases/tag/v0.2.0
[0.1.2]: https://github.com/RichLogic/Gian/releases/tag/v0.1.2
[0.1.1]: https://github.com/RichLogic/Gian/releases/tag/v0.1.1
[0.1.0]: https://github.com/RichLogic/Gian/releases/tag/v0.1.0
