/**
 * Renders a file path as a clickable link. Clicks route through the host's
 * `LinkBehavior.openFile` callback (e.g. an in-app preview surface). The
 * anchor href comes from `LinkBehavior.fileHref` — the package never
 * synthesizes an absolute-path or editor-scheme URL itself, and without an
 * `openFile` behavior the link renders as an inert span (never a dead `<a>`).
 */

import { useLinkBehavior } from './LinkBehaviorContext.js';

export function FileLink({
  path,
  line,
  className,
  children,
}: {
  path: string;
  line?: number | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  const behavior = useLinkBehavior();
  const openInApp = behavior?.openFile ?? null;
  const cls = `file-link${className ? ` ${className}` : ''}`;
  const label = `${path}${line ? `:${line}` : ''}`;
  if (!openInApp) {
    return (
      <span className={cls} data-link-kind="file" title={label}>
        {children ?? path}
      </span>
    );
  }
  const href = behavior?.fileHref?.(path, line);
  return (
    <a
      className={cls}
      data-link-kind="file"
      href={href}
      title={`Preview ${label}`}
      onClick={event => {
        event.preventDefault();
        // stopPropagation lets these sit inside collapsible card headers
        // without toggling the card on click.
        event.stopPropagation();
        openInApp(path, line);
      }}
    >
      {children ?? path}
    </a>
  );
}
