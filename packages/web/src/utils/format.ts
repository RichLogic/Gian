export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}
