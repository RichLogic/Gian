export function occupiesCanonicalSequence(
  type: string,
  eventKind?: string,
): boolean {
  if (type === 'state.patch') return true;
  if (type === 'event') return eventKind !== 'transcript.item';
  return false;
}

export function advanceCanonicalSequence(last: number, incoming: number): 'ok' | 'gap' {
  if (last >= 0 && incoming !== last + 1) return 'gap';
  return 'ok';
}
