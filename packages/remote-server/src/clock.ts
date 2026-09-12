export type Clock = () => number;

export function systemClock(): number {
  return Date.now();
}
