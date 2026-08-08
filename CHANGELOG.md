# Changelog

This file records user-facing changes in published Gian builds. It is updated
whenever a version is packaged and tagged for release; local test packages are
not listed.

All releases below are unsigned macOS Apple Silicon beta builds.

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
