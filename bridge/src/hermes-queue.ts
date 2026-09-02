let chain = Promise.resolve<void>(undefined);

export function runHermesJobSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function resetHermesJobQueueForTests(): void {
  chain = Promise.resolve(undefined);
}
