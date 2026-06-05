/**
 * App-wide feedback primitives — a replacement for the browser's `alert()` and
 * `confirm()`. A module-level store (not a React context) so it can be called
 * from anywhere, including non-component code like the WebSocket message
 * handler. A single <Toaster/> mounted at the app root subscribes and renders.
 *
 *   import { toast, confirm } from './feedback.js';
 *   toast({ kind: 'error', message: 'Merge failed' });
 *   if (await confirm({ message: 'Delete this session?', danger: true })) { … }
 */

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  kind?: ToastKind;
  /** Optional bold heading above the message. */
  title?: string;
  message: string;
  /** Auto-dismiss after N ms. 0 = sticky (manual close only). Defaults by kind. */
  duration?: number;
}

export interface ToastRecord {
  id: string;
  kind: ToastKind;
  title?: string;
  message: string;
  duration: number;
}

export interface ConfirmInput {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

export interface ConfirmRecord extends ConfirmInput {
  id: string;
  resolve: (ok: boolean) => void;
}

export interface FeedbackState {
  toasts: ToastRecord[];
  confirms: ConfirmRecord[];
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 6000,
};

let state: FeedbackState = { toasts: [], confirms: [] };
const listeners = new Set<() => void>();
let seq = 0;

function nextId(): string {
  seq += 1;
  return `fb-${seq}`;
}

function set(next: FeedbackState): void {
  state = next;
  listeners.forEach(l => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): FeedbackState {
  return state;
}

/** Show a transient toast. Returns its id (for manual dismissal). */
export function toast(input: ToastInput): string {
  const id = nextId();
  const kind = input.kind ?? 'info';
  const rec: ToastRecord = {
    id,
    kind,
    title: input.title,
    message: input.message,
    duration: input.duration ?? DEFAULT_DURATION[kind],
  };
  set({ ...state, toasts: [...state.toasts, rec] });
  return id;
}

export function dismissToast(id: string): void {
  if (!state.toasts.some(t => t.id === id)) return;
  set({ ...state, toasts: state.toasts.filter(t => t.id !== id) });
}

/** Ask the user to confirm an action. Resolves true on confirm, false on
 *  cancel / dismiss. */
export function confirm(input: ConfirmInput): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const id = nextId();
    set({ ...state, confirms: [...state.confirms, { id, ...input, resolve }] });
  });
}

export function resolveConfirm(id: string, ok: boolean): void {
  const rec = state.confirms.find(c => c.id === id);
  if (!rec) return;
  set({ ...state, confirms: state.confirms.filter(c => c.id !== id) });
  rec.resolve(ok);
}

/** Test helper — clears all state and resolves any pending confirms as false. */
export function __resetFeedback(): void {
  state.confirms.forEach(c => c.resolve(false));
  state = { toasts: [], confirms: [] };
  seq = 0;
}
