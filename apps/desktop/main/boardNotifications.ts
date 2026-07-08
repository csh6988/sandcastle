// Subscribe to the board's SSE stream and raise native notifications when a
// task finishes or starts waiting on a human approval gate.

interface StreamTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly stage?: { readonly canApprove?: boolean };
}

interface StreamChange {
  readonly kind: string;
  readonly task?: StreamTask;
}

export interface BoardNotification {
  readonly title: string;
  readonly body: string;
}

/**
 * Decide whether a task change warrants a notification, tracking previous
 * state so a task only notifies on transitions, not on every update.
 */
export const createNotificationFilter = () => {
  const seen = new Map<string, { status: string; canApprove: boolean }>();
  return (change: StreamChange): BoardNotification | null => {
    if (change.kind !== "task-updated" || !change.task) return null;
    const task = change.task;
    const previous = seen.get(task.id);
    const canApprove = task.stage?.canApprove === true;
    seen.set(task.id, { status: task.status, canApprove });
    if (!previous) return null;
    if (task.status !== previous.status && task.status === "succeeded") {
      return { title: "Task succeeded", body: task.title };
    }
    if (task.status !== previous.status && task.status === "failed") {
      return { title: "Task failed", body: task.title };
    }
    if (canApprove && !previous.canApprove) {
      return { title: "Plan awaiting approval", body: task.title };
    }
    return null;
  };
};

/**
 * Minimal SSE client over fetch: watches `event: change` messages from the
 * board stream and invokes the callback per parsed change. Reconnects with a
 * short delay until aborted.
 */
export const watchBoardStream = (args: {
  readonly boardUrl: string;
  readonly signal: AbortSignal;
  readonly onChange: (change: StreamChange) => void;
  readonly onError?: (error: unknown) => void;
}): void => {
  const run = async (): Promise<void> => {
    while (!args.signal.aborted) {
      try {
        const res = await fetch(`${args.boardUrl}/api/stream`, {
          headers: { accept: "text/event-stream" },
          signal: args.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const isChange = /^event: ?change$/m.test(rawEvent);
            const dataLine = rawEvent
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!isChange || !dataLine) continue;
            try {
              args.onChange(
                JSON.parse(dataLine.slice(5).trim()) as StreamChange,
              );
            } catch {
              // ignore malformed frames
            }
          }
        }
      } catch (error) {
        if (args.signal.aborted) return;
        args.onError?.(error);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  void run();
};
