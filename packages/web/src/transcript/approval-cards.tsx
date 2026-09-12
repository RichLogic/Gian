/**
 * Interaction cards (approval / question / native choice / exit-plan) live in
 * `@gian/chat-ui`; the `ApprovalCard` re-exported here is the web adapter
 * from `./items.tsx` that wires the operation layer's resolving state.
 */
export { Caret, ApprovalLine } from '@gian/chat-ui';
export { ApprovalCard } from './items.js';
