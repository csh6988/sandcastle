import { useEffect, useState } from "react";
import type { SandcastleBridge } from "../preload/bridge.js";
import {
  EnvelopeCommandSchema,
  type EnvelopeCommand,
  type TestRunView,
} from "../runtime/interface.js";

type TestCaseRevisionCommand = Extract<
  EnvelopeCommand,
  { readonly type: "test.case-revision.register" }
>;
type TestRunCreateCommand = Extract<
  EnvelopeCommand,
  { readonly type: "test.run.create" }
>;

export type ElectronTestFixtureRoute = {
  readonly schemaVersion: 1;
  readonly restoreOnLoad: boolean;
  readonly testRunId: string;
  readonly caseCommandId: string;
  readonly caseCommand: TestCaseRevisionCommand;
  readonly runCommandId: string;
  readonly runCommand: TestRunCreateCommand;
};

type FixtureBridge = Pick<SandcastleBridge, "query" | "execute">;
type FixtureStatus = "idle" | "working" | "ready" | "pass" | "error";

const parseRoute = (value: unknown): ElectronTestFixtureRoute | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const input = value as Record<string, unknown>;
  const caseCommand = EnvelopeCommandSchema.safeParse(input.caseCommand);
  const runCommand = EnvelopeCommandSchema.safeParse(input.runCommand);
  if (
    input.schemaVersion !== 1 ||
    typeof input.restoreOnLoad !== "boolean" ||
    typeof input.testRunId !== "string" ||
    input.testRunId.trim() === "" ||
    typeof input.caseCommandId !== "string" ||
    input.caseCommandId.trim() === "" ||
    typeof input.runCommandId !== "string" ||
    input.runCommandId.trim() === "" ||
    !caseCommand.success ||
    caseCommand.data.type !== "test.case-revision.register" ||
    !runCommand.success ||
    runCommand.data.type !== "test.run.create" ||
    runCommand.data.input.testRunId !== input.testRunId
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    restoreOnLoad: input.restoreOnLoad,
    testRunId: input.testRunId,
    caseCommandId: input.caseCommandId,
    caseCommand: caseCommand.data,
    runCommandId: input.runCommandId,
    runCommand: runCommand.data,
  };
};

export const encodeElectronTestFixtureRoute = (
  route: ElectronTestFixtureRoute,
  base = "http://127.0.0.1/",
): string => {
  const url = new URL(base);
  url.hash = `electron-test-fixture=${encodeURIComponent(JSON.stringify(route))}`;
  return url.toString();
};

export const readElectronTestFixtureRoute = (
  location: Pick<Location, "hash"> | URL,
): ElectronTestFixtureRoute | null => {
  const prefix = "#electron-test-fixture=";
  if (!location.hash.startsWith(prefix)) return null;
  try {
    return parseRoute(
      JSON.parse(decodeURIComponent(location.hash.slice(prefix.length))),
    );
  } catch {
    return null;
  }
};

const unwrap = <Value,>(
  result:
    | { readonly status: "succeeded"; readonly value: Value }
    | {
        readonly status: "rejected";
        readonly error: { readonly message: string };
      },
): Value => {
  if (result.status === "rejected") throw new Error(result.error.message);
  return result.value;
};

export function ElectronTestFixturePage(props: {
  readonly route: ElectronTestFixtureRoute;
  readonly bridge?: FixtureBridge;
}) {
  const bridge = props.bridge ?? window.sandcastle;
  const [status, setStatus] = useState<FixtureStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const inspectAndAcknowledge = async (): Promise<TestRunView> => {
    const result = await bridge.query({
      type: "test-runs.inspect",
      testRunId: props.route.testRunId,
    });
    if (result.viewSyncToken) {
      unwrap(
        await bridge.execute({
          commandId: `${props.route.runCommandId}:view-ack:${result.asOfSequence}:${globalThis.crypto.randomUUID()}`,
          command: {
            type: "ack-runtime-events",
            sequence: result.asOfSequence,
            viewSyncToken: result.viewSyncToken,
          },
        }),
      );
    }
    return result.view;
  };

  const waitForState = async (
    expected: readonly TestRunView["state"][],
  ): Promise<TestRunView> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const view = await inspectAndAcknowledge();
      if (expected.includes(view.state)) return view;
      if (["failed", "blocked", "cancelled", "unknown"].includes(view.state))
        throw new Error(`Test Run reached ${view.state}.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for authoritative Test Run state.");
  };

  useEffect(() => {
    document.title = `Sandcastle T17 Fixture — ${status}`;
  }, [status]);

  useEffect(() => {
    if (!props.route.restoreOnLoad) return;
    let active = true;
    void inspectAndAcknowledge()
      .then((view) => {
        if (!active) return;
        setStatus(view.state === "passed" ? "pass" : "ready");
      })
      .catch(() => {
        if (active) setStatus("idle");
      });
    return () => {
      active = false;
    };
  }, []);

  const advance = async (): Promise<void> => {
    if (status === "working" || status === "pass") return;
    setStatus("working");
    setError(null);
    try {
      if (status === "idle") {
        unwrap(
          await bridge.execute({
            commandId: props.route.caseCommandId,
            command: props.route.caseCommand,
          }),
        );
      }
      unwrap(
        await bridge.execute({
          commandId: props.route.runCommandId,
          command: props.route.runCommand,
        }),
      );
      const view = await waitForState(
        status === "idle" ? ["reconciling", "running", "passed"] : ["passed"],
      );
      setStatus(view.state === "passed" ? "pass" : "ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  };

  const label =
    status === "pass"
      ? "PASS"
      : status === "ready"
        ? "Complete Test Run"
        : status === "working"
          ? "Working…"
          : "Run Test";

  return (
    <main
      className="content"
      data-electron-test-fixture={props.route.testRunId}
    >
      <section className="create-panel" aria-labelledby="fixture-title">
        <span className="eyebrow">Versioned Test Run</span>
        <h1 id="fixture-title">Electron Test Fixture</h1>
        <p>
          This product renderer sends formal Commands and rebuilds from the
          authoritative Test Run Query View.
        </p>
        <button
          autoFocus
          id="run-test"
          type="button"
          disabled={status === "working" || status === "pass"}
          onClick={() => void advance()}
        >
          {label}
        </button>
        <output id="test-status" aria-live="polite">
          {error ?? (status === "pass" ? "PASS" : status)}
        </output>
      </section>
    </main>
  );
}
