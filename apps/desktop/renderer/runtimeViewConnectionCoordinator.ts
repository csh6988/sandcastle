export interface ClosableRuntimeViewConnection {
  readonly close: () => Promise<void>;
}

export interface RuntimeViewConnectionRequest<
  Connection extends ClosableRuntimeViewConnection,
> {
  readonly done: Promise<Connection | null>;
  readonly cancel: () => void;
}

export const createRuntimeViewConnectionCoordinator = <
  Connection extends ClosableRuntimeViewConnection,
>() => {
  let epoch = 0;
  let queue = Promise.resolve();
  let active: Connection | null = null;

  const enqueue = <Value>(task: () => Promise<Value>): Promise<Value> => {
    const scheduled = queue.then(task);
    queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };

  const replace = (
    create: (isCurrent: () => boolean) => Promise<Connection>,
  ): RuntimeViewConnectionRequest<Connection> => {
    const requestEpoch = ++epoch;
    let owned: Connection | null = null;
    const isCurrent = (): boolean => requestEpoch === epoch;
    const done = enqueue(async () => {
      const previous = active;
      active = null;
      if (previous) await previous.close();
      if (!isCurrent()) return null;
      const connection = await create(isCurrent);
      owned = connection;
      if (!isCurrent()) {
        await connection.close();
        return null;
      }
      active = connection;
      return connection;
    });
    return {
      done,
      cancel: () => {
        if (isCurrent()) epoch += 1;
        void enqueue(async () => {
          if (active !== owned || !owned) return;
          active = null;
          await owned.close();
        });
      },
    };
  };

  const clear = (): Promise<void> => {
    epoch += 1;
    return enqueue(async () => {
      const previous = active;
      active = null;
      if (previous) await previous.close();
    });
  };

  return {
    replace,
    clear,
    current: (): Connection | null => active,
  };
};
