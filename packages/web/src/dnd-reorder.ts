/**
 * Sidebar drag reorder (2026-08-29) — a small shared HTML5-drag controller
 * for the ordered rail lists (Tasks rail tasks/subtasks, Sessions rail
 * workspaces/sessions, Settings > Workspaces rows). No drag library: the
 * desktop shell is the only supported surface, so the native drag events are
 * enough.
 *
 * One controller instance per LIST. A row's drag never escapes its own list:
 * another list's controller has no in-flight drag, so its rows neither
 * highlight nor accept the drop (their `dragover` never preventDefaults).
 *
 * Views render the controller's indicator classes (`dnd-before` /
 * `dnd-after` draw the insertion line, `dnd-dragging` dims the dragged row;
 * see styles/dnd.css) and translate the drop into a new id order with
 * `moveById`, which they dispatch through the operation layer.
 */
import { useState } from 'react';
import type { DragEvent } from 'react';

export type DropPlace = 'before' | 'after';

/** Per-row props/class fragments produced by a `useDragReorder` controller. */
export interface RowDragProps {
  draggable: true;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
}

export interface DragReorderController {
  /** Props for one draggable row in the list. */
  rowProps(id: string): RowDragProps;
  /** Indicator classes for one row: `dnd-dragging` while it is dragged,
   *  `dnd-before`/`dnd-after` on the hovered drop target. */
  rowClass(id: string): string;
  /** True while a row of this list is being dragged. */
  dragging: boolean;
}

/**
 * A drag controller for one ordered list. `onReorder` receives the drop as
 * (dragged id, target row id, insertion side); the view computes the new id
 * order (`moveById`) and dispatches the matching reorder operation.
 */
export function useDragReorder(
  onReorder: (dragId: string, targetId: string, place: DropPlace) => void,
): DragReorderController {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; place: DropPlace } | null>(null);

  function reset() {
    setDragId(null);
    setOver(null);
  }

  return {
    dragging: dragId !== null,
    rowClass(id: string): string {
      if (dragId === id) return ' dnd-dragging';
      if (over?.id === id) return over.place === 'before' ? ' dnd-before' : ' dnd-after';
      return '';
    },
    rowProps(id: string): RowDragProps {
      return {
        draggable: true,
        onDragStart: event => {
          // Interactive children (buttons, the inline rename input) keep
          // their own press semantics and never start a list drag.
          if ((event.target as HTMLElement).closest('button, input, textarea, a, [contenteditable]')) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          // Firefox requires a setData payload to start a drag at all.
          event.dataTransfer.setData('text/plain', id);
          setDragId(id);
        },
        onDragOver: event => {
          if (dragId === null || dragId === id) return;
          // preventDefault marks this row as a valid drop target.
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const place: DropPlace = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          setOver(previous =>
            previous && previous.id === id && previous.place === place ? previous : { id, place });
        },
        onDrop: event => {
          if (dragId === null) return;
          event.preventDefault();
          if (over && over.id !== dragId) onReorder(dragId, over.id, over.place);
          reset();
        },
        onDragEnd: () => reset(),
      };
    },
  };
}

/**
 * The id order after dropping `dragId` before/after `targetId`. Returns the
 * input array untouched when the drop is a no-op (unknown ids, or the row
 * dropped back onto its own current position), so callers can skip the
 * dispatch by reference equality.
 */
export function moveById(
  ids: readonly string[],
  dragId: string,
  targetId: string,
  place: DropPlace,
): string[] {
  const from = ids.indexOf(dragId);
  if (from < 0 || !ids.includes(targetId) || dragId === targetId) return ids as string[];
  const next = ids.filter(id => id !== dragId);
  const target = next.indexOf(targetId);
  const insertAt = place === 'before' ? target : target + 1;
  if (insertAt === from) return ids as string[];
  next.splice(insertAt, 0, dragId);
  return next;
}
