import { act } from '@testing-library/react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
} from 'lexical';

/** jsdom cannot perform native contenteditable editing. Drive the same Lexical
 *  update used by the editor's imperative insertion path instead. */
export function typeInlineComposer(element: HTMLElement, text: string): void {
  const editor = (element as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) throw new Error('expected a Lexical editor root');
  element.focus();
  act(() => {
    editor.update(() => {
      const last = $getRoot().getLastChild();
      const paragraph = $isElementNode(last) ? last : $createParagraphNode();
      if (!$isElementNode(last)) $getRoot().append(paragraph);
      paragraph.append($createTextNode(text));
    }, { discrete: true });
  });
}
