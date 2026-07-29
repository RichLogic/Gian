export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    new: ['idle', 'New'],
    running: ['run', 'Running'],
    pending: ['wait', 'Pending'],
    archived: ['idle', 'Archived'],
    error: ['err', 'Error'],
    done: ['done', 'Done'],
  };
  const m = map[status];
  if (!m) return null;
  return <span className={`pill ${m[0]}`}>{m[1]}</span>;
}
