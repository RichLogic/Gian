/**
 * `@gian/chat-ui` — pure presentational React components for Gian chat
 * surfaces (local Web and Remote Web share this single renderer set).
 *
 * Inputs are presentation DTOs (`types.ts`), timestamps, state, and explicit
 * callbacks. The package never touches a store, router, Host API, file
 * index, absolute-path opener, or Provider runtime — the owning app injects
 * behavior through props and the contexts in `contexts.ts`, and copy through
 * `ChatUiI18nProvider` (English fallback built in).
 *
 * Styles ship separately: import `@gian/chat-ui/styles.css` once in the app
 * (Gian Web: from `src/styles/index.css`). Theme tokens (`--bg`, `--accent`,
 * …) stay the app's responsibility.
 */

export * from './types.js';
export * from './i18n.js';
export * from './contexts.js';
export * from './utils.js';
export * from './identity.js';
export * from './event-feed.js';
export { normalizeGfmTables } from './markdown-tables.js';
export { MarkdownText, FileLink } from './markdown.js';
export { classifyLink, type LinkKind, type LinkTarget } from './links/classify.js';
export {
  transcriptPolicy,
  strictHttpsPolicy,
  plainTextPolicy,
  type LinkPolicy,
  type LinkDisplay,
} from './links/policy.js';
export {
  LinkBehaviorContext,
  LinkPolicyContext,
  useLinkBehavior,
  useLinkPolicy,
  type LinkBehavior,
} from './links/LinkBehaviorContext.js';
export { LinkAnchor } from './links/LinkAnchor.js';
export { LinkifiedText, splitLinkTokens, type LinkTextToken } from './links/linkify-text.js';
export { LinkKindIcon } from './links/link-icons.js';
export { CopyButton } from './copy-button.js';
export * from './items.js';
export { ApprovalLine } from './approval-cards.js';
export * from './event-lines.js';
export { ContextCards } from './context-cards.js';
export {
  ReferencePopover,
  ReferencePopoverHead,
  REFERENCE_ICONS,
  ContextReferencePopover,
  useHoverPreview,
  PREVIEW_HOVER_OPEN_MS,
  PREVIEW_HOVER_CLOSE_MS,
  type ReferenceAnchor,
} from './reference-popover.js';
export {
  InlineReferenceDocument,
  type InlineReferenceAttachment,
} from './inline-reference-document.js';
export * from './transcript.js';
