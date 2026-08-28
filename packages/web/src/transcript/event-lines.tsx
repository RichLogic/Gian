import type { MouseEvent, Ref } from 'react';
import { useT } from '../i18n/index.js';
import type { AgentSpawnItem, TranscriptItem } from '../types.js';
import { measureToolDetail, RunningMeta, TRow } from './items.js';
import { ApprovalLine } from './approval-cards.js';

/**
 * Shared one-line event rendering for the event box (transcript) and the
 * event feed (panel 2): same verb / subject / status grammar as the full
 * transcript rows. The box renders lines bare (the whole box is the click
 * target); the feed passes `expand` so each row expands its detail IN
 * PLACE (`.trow-detail` below the row) — no navigation, no extra layer.
 *
 * `eventDetailText` builds the best-effort full text for a row: the
 * structured payload when one exists (tool input/output, command output,
 * reasoning trace, search matches, agent prompt+result), otherwise a
 * formatted JSON dump of the raw item — a row must NEVER be a dead end.
 * `null` only for a resolved approval: its line already IS the full
 * record, so it stays static.
 */

/** Formatted raw-item dump — the detail floor for rows whose producer did
 *  not attach a structured payload (e.g. synthetic `Codex event:` tools). */
function fallbackJson(item: TranscriptItem): string {
  return JSON.stringify(item, null, 2);
}

function agentDetailText(item: AgentSpawnItem): string {  let prompt = '';
  for (const key of ['prompt', 'description', 'task', 'message']) {
    const value = item.input?.[key];
    if (typeof value === 'string' && value.trim()) {
      prompt = value.trim();
      break;
    }
  }
  const parts = [
    item.description,
    `status: ${item.status}`,
    item.agentType ? `role: ${item.agentType}` : '',
    item.model ? `model: ${item.model}` : '',
    prompt ? `\nprompt:\n${prompt}` : '',
    item.output ? `\nresult:\n${item.output}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

export function eventDetailText(item: TranscriptItem): string | null {
  switch (item.kind) {
    case 'tool':
      return measureToolDetail(item.summary, item.output).text || fallbackJson(item);
    case 'command': {
      const output = item.stdout + (item.stderr ? `\n${item.stderr}` : '');
      return output
        ? `$ ${item.command}${item.cwd ? `  —  ${item.cwd}` : ''}\n\n${output}`
        : fallbackJson(item);
    }
    case 'diff': {
      const text = item.files.map(f => {
        const hunks = f.hunks.map(h =>
          [h.header, ...h.lines.map(l =>
            `${l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}${l.text}`,
          )].join('\n'),
        ).join('\n');
        return `${f.path}  +${f.add} −${f.del}${hunks ? `\n${hunks}` : ''}`;
      }).join('\n\n');
      return text || fallbackJson(item);
    }
    case 'reasoning':
      return item.text || fallbackJson(item);
    case 'file-search':
      return item.matches?.length ? item.matches.join('\n') : fallbackJson(item);
    case 'file-read':
    case 'web-search':
    case 'auto-notice':
    case 'compaction':
      return fallbackJson(item);
    case 'agent-spawn':
      return agentDetailText(item);
    case 'approval':
      // A resolved approval line already IS the full summary — no detail.
      return null;
    default:
      return null;
  }
}

export interface EventLineExpand {
  open: boolean;
  toggle: (e: MouseEvent<HTMLElement>) => void;
}

/** One compact line per event. `expand` turns the line into an expandable
 *  row (caret + toggle); without it the line is inert (event box).
 *  `onRowClick` (mutually exclusive with `expand`) makes the line clickable
 *  but never expandable — the turn work block uses it to jump into the
 *  anchored panel-2 event feed. `rowRef` exposes the `.trow` element (the
 *  feed needs it for the anchor scroll + flash). */
export function EventLine({
  item,
  expand,
  onRowClick,
  rowRef,
  turnCompleted = false,
}: {
  item: TranscriptItem;
  expand?: EventLineExpand;
  onRowClick?: () => void;
  rowRef?: Ref<HTMLDivElement>;
  /** Terminal-turn rendering: a stale `running` status must not tick a live
   *  timer (same rule as the full cards' `turnCompleted`). */
  turnCompleted?: boolean;
}) {
  const t = useT();
  const behavior = expand
    ? { expandable: true, open: expand.open, onToggle: expand.toggle, rowRef }
    : { onRowClick, rowRef };
  switch (item.kind) {
    case 'tool': {
      const running = !turnCompleted && (item.status === 'running' || item.status === 'pending');
      return (
        <TRow
          verb={t('transcript.tool')}
          subject={item.name}
          subjectTitle={item.name}
          meta={
            running ? <RunningMeta since={item.ts} />
            : item.status === 'error' ? <span className="err">error</span>
            : undefined
          }
          {...behavior}
        />
      );
    }
    case 'command': {
      const running = !turnCompleted && item.status === 'running';
      return (
        <TRow
          verb={t('transcript.command.run')}
          subject={item.command}
          subjectTitle={item.cwd ? `${item.command} — ${item.cwd}` : item.command}
          meta={
            running ? <RunningMeta since={item.ts} />
            : (
              <>
                {item.status === 'error' && <span className="err">error</span>}
                {item.exitCode !== undefined && <span>exit {item.exitCode}</span>}
              </>
            )
          }
          {...behavior}
        />
      );
    }
    case 'diff': {
      const add = item.files.reduce((s, f) => s + f.add, 0);
      const del = item.files.reduce((s, f) => s + f.del, 0);
      const subject = item.files.length === 1
        ? item.files[0]!.path
        : `${t('transcript.diff.changedFiles')} ${item.files.length}`;
      return (
        <TRow
          verb={t('transcript.diff.edit')}
          subject={subject}
          subjectTitle={subject}
          meta={
            <>
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
            </>
          }
          {...behavior}
        />
      );
    }
    case 'file-read': {
      const lineRange = item.startLine !== undefined
        ? ` :${item.startLine}${item.endLine !== undefined ? `–${item.endLine}` : ''}`
        : '';
      const label = `${item.path}${lineRange}`;
      return (
        <TRow
          verb={t('transcript.file.read')}
          subject={label}
          subjectTitle={label}
          {...behavior}
        />
      );
    }
    case 'file-search': {
      const verb = item.searchKind === 'glob' ? t('transcript.file.glob') : t('transcript.file.grep');
      const count = item.matchCount ?? item.matches?.length;
      return (
        <TRow
          verb={verb}
          subject={item.pattern}
          subjectDim
          subjectTitle={item.pattern}
          meta={count !== undefined
            ? <span>{count} {t(count === 1 ? 'transcript.file.match' : 'transcript.file.matches')}</span>
            : undefined}
          {...behavior}
        />
      );
    }
    case 'web-search':
      return (
        <TRow
          verb={t('transcript.web.search')}
          subject={item.query}
          subjectDim
          subjectTitle={item.query}
          meta={item.resultCount !== undefined
            ? <span>{item.resultCount} {t('transcript.web.results')}</span>
            : undefined}
          {...behavior}
        />
      );
    case 'reasoning': {
      const label = item.variant === 'summary'
        ? t('transcript.reasoning.summary')
        : t('transcript.reasoning.full');
      const preview = item.text.split('\n', 1)[0] ?? '';
      return (
        <TRow
          verb={label}
          subject={preview}
          subjectDim
          subjectTitle={preview}
          dataAttrs={{ 'data-variant': item.variant }}
          {...behavior}
        />
      );
    }
    case 'agent-spawn': {
      const running = !turnCompleted && item.status === 'running';
      return (
        <TRow
          verb={t('transcript.agent')}
          subject={item.description}
          subjectTitle={item.description}
          meta={
            running ? <RunningMeta since={item.ts} />
            : item.status === 'error' ? <span className="err">error</span>
            : undefined
          }
          {...behavior}
        />
      );
    }
    case 'auto-notice': {
      if (item.variant === 'notice') {
        return (
          <TRow
            verb={item.title || 'Notice'}
            subject={item.message}
            subjectTitle={item.message}
            subjectDim={item.severity === 'info'}
            meta={item.code ? <span>{item.code}</span> : undefined}
            {...behavior}
          />
        );
      }
      if (item.variant === 'circuit-breaker') {
        // Never collected (error-level notices stay inline) — guarded by
        // isTurnWorkItem; kept so the switch stays total over variants.
        return null;
      }
      return (
        <TRow
          verb={t('transcript.auto.block')}
          subject={
            <>
              {item.action || t('transcript.auto.action')}
              {item.reason && <span className="dim-reason">{item.reason}</span>}
            </>
          }
          subjectTitle={item.action}
          meta={<span>{item.consecutive}/3 · {item.total} {t('transcript.auto.total')}</span>}
          {...behavior}
        />
      );
    }
    case 'compaction': {
      const k = (n: number) => `${Math.round(n / 1000)}k`;
      const subject = item.beforeTokens !== undefined && item.afterTokens !== undefined
        ? `${t('transcript.compact.subject')} · ${k(item.beforeTokens)} → ${k(item.afterTokens)}`
        : t('transcript.compact.subject');
      return (
        <TRow
          verb={t('transcript.compact.verb')}
          subject={subject}
          subjectDim
          {...behavior}
        />
      );
    }
    case 'approval':
      // Resolved interactions join the tail as the same one-line summary
      // the turnsum fold uses — already the full record, never expandable.
      return <ApprovalLine item={item} />;
    default:
      return null;
  }
}
