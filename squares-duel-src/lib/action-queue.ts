// Keep claims and Commit in input order without blocking the next selection.
export function createActionQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(action: () => Promise<T>): Promise<T> {
      const result = tail.then(action);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
