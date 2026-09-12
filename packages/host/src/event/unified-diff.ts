import type { FileChangeSummary } from '@gian/shared';

/** Parse the file-level facts Gian needs from a unified diff snapshot. */
export function parseUnifiedDiffSummary(text: string): FileChangeSummary[] {
  const chunks = text.split(/^diff --git .*$/m).map(chunk => chunk.trim()).filter(Boolean);
  if (chunks.length === 0 && text.trim()) chunks.push(text.trim());

  return chunks.map(chunk => {
    const lines = chunk.split('\n');
    let path = '';
    let isNew = false;
    let isDelete = false;
    let added = 0;
    let removed = 0;

    for (const line of lines) {
      if (line.startsWith('+++ b/')) path = line.slice(6);
      else if (line.startsWith('+++ /dev/null')) isDelete = true;
      else if (line.startsWith('--- /dev/null')) isNew = true;
      else if (!path && line.startsWith('--- a/')) path = line.slice(6);
      else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }

    return {
      path: path || '(unknown)',
      kind: isDelete ? 'delete' : isNew ? 'create' : 'update',
      added,
      removed,
    };
  });
}
