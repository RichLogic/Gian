/**
 * `LinkAnchor` — THE single anchor component for every link `@gian/chat-ui`
 * renders (react-markdown `a` overrides and linkified plain text alike).
 * Pipeline: classify → policy (what the surface allows) → behavior (what
 * the host can do).
 *
 * Rules:
 * - `unsafe` targets never render as `<a>` — plain text, always.
 * - `_blank` anchors always carry `rel="noreferrer noopener"`.
 * - A missing behavior never produces a dead `<a>` or a swallowed click:
 *   the link renders as an inert span with a tooltip explaining the
 *   unavailability. The one exception is `openWebUrl`, whose documented
 *   fallback is the plain `target="_blank"` anchor.
 */

import { useLinkBehavior, useLinkPolicy } from './LinkBehaviorContext.js';
import { classifyLink, type LinkTarget } from './classify.js';
import { LinkKindIcon } from './link-icons.js';
import { useChatUiT } from '../i18n.js';

export function LinkAnchor(props: {
  node?: { properties?: Record<string, unknown> };
  href?: string;
  children?: React.ReactNode;
}) {
  const behavior = useLinkBehavior();
  const policy = useLinkPolicy();
  const t = useChatUiT();
  const p = props.node?.properties ?? {};
  const fileAbs = typeof p.dataFileAbs === 'string' ? p.dataFileAbs : null;
  const fileLine = p.dataFileLine ? Number(p.dataFileLine) : undefined;
  const target = classifyLink(props.href, { fileAbs, fileLine });
  const display = target.kind === 'unsafe' ? 'text' : policy.display(target);
  const icon = <LinkKindIcon kind={target.kind} />;

  if (display === 'text') return <>{props.children}</>;
  if (display === 'inert') return <InertLink target={target} icon={icon} note={t('links.unavailable')}>{props.children}</InertLink>;

  switch (target.kind) {
    case 'web': {
      const openWebUrl = behavior?.openWebUrl;
      if (openWebUrl) {
        return (
          <a
            href={target.href}
            data-link-kind={target.kind}
            rel="noreferrer noopener"
            onClick={event => {
              event.preventDefault();
              openWebUrl(target.href);
            }}
          >
            {icon}
            {props.children}
          </a>
        );
      }
      return (
        <a href={target.href} data-link-kind={target.kind} target="_blank" rel="noreferrer noopener">
          {icon}
          {props.children}
        </a>
      );
    }
    case 'file': {
      const openFile = behavior?.openFile;
      const abs = target.fileAbs!;
      const label = `${abs}${target.fileLine ? `:${target.fileLine}` : ''}`;
      if (!openFile) {
        return <InertLink target={target} icon={icon} note={t('links.unavailable')} className="file-link file-link-auto">{props.children}</InertLink>;
      }
      const href = behavior?.fileHref?.(abs, target.fileLine);
      return (
        <a
          className="file-link file-link-auto"
          data-link-kind={target.kind}
          href={href}
          title={`Preview ${label}`}
          onClick={event => {
            event.preventDefault();
            // stopPropagation lets these sit inside collapsible card headers
            // without toggling the card on click.
            event.stopPropagation();
            openFile(abs, target.fileLine);
          }}
        >
          {icon}
          {props.children}
        </a>
      );
    }
    case 'relative': {
      const openRelative = behavior?.openRelative;
      if (!openRelative) {
        return <InertLink target={target} icon={icon} note={t('links.unavailable')}>{props.children}</InertLink>;
      }
      return (
        <a
          href={target.href}
          data-link-kind={target.kind}
          onClick={event => {
            event.preventDefault();
            openRelative(target.href);
          }}
        >
          {icon}
          {props.children}
        </a>
      );
    }
    // Editor schemes, other external schemes (mailto:, tel:, …) and in-page
    // fragments navigate through the platform default.
    default:
      return (
        <a href={target.href} data-link-kind={target.kind}>
          {icon}
          {props.children}
        </a>
      );
  }
}

function InertLink({
  target,
  icon,
  note,
  className,
  children,
}: {
  target: LinkTarget;
  icon: React.ReactNode;
  note: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const title = target.href ? `${target.href} — ${note}` : note;
  return (
    <span
      className={className ? `link-inert ${className}` : 'link-inert'}
      data-link-kind={target.kind}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}
