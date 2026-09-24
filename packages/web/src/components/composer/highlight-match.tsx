import type { ReactNode } from 'react';

/** Bold the first case-insensitive occurrence of `query` inside `text`.
 *  Shared by the trigger menus (`@` file popover, `/` slash menu). */
export function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <strong>{text.slice(index, index + query.length)}</strong>
      {text.slice(index + query.length)}
    </>
  );
}
