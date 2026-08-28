import {
  MAX_PASTED_TEXT_BYTES,
  type PastedTextContextItem,
} from '@gian/shared';

export interface TranscriptTextSelection {
  text: string;
  sourceId: string;
  sourceKind: 'user' | 'assistant';
  turn: number;
}

export function selectedTextByteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function createSelectedTextContextItem(
  selection: TranscriptTextSelection,
  id: string = crypto.randomUUID(),
): PastedTextContextItem | null {
  if (selection.text.trim().length === 0) return null;
  const byteSize = selectedTextByteSize(selection.text);
  if (byteSize > MAX_PASTED_TEXT_BYTES) return null;
  return {
    type: 'pastedText',
    id,
    text: selection.text,
    lineCount: selection.text.split(/\r\n|\r|\n/).length,
    byteSize,
    origin: 'selection',
  };
}

export function mintSelectionSideChatId(id: string = crypto.randomUUID()): string {
  return `sc_${id}`;
}
