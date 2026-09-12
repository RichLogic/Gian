/** Strict FIFO for one crypto/transport direction. Failures do not skip later work. */
export function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
