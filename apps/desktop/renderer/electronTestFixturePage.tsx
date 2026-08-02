import { useEffect, useState } from "react";
import type { SandcastleBridge } from "../preload/bridge.js";
import {
  EnvelopeCommandSchema,
  type CandidateQualityGateView,
  type DeliveryCandidateView,
  type EnvelopeCommand,
  type TestRunView,
} from "../runtime/interface.js";
import { connectCandidateQualityGates } from "./candidateQualityGateView.js";
import {
  CandidateQualityGatePanel,
  DeliveryCandidatePanel,
} from "./companyPages.js";
import { connectDeliveryCandidate } from "./deliveryCandidateView.js";

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
  readonly candidateInputId?: string;
  readonly candidateId?: string;
  readonly caseCommandId: string;
  readonly caseCommand: TestCaseRevisionCommand;
  readonly runCommandId: string;
  readonly runCommand: TestRunCreateCommand;
  readonly interactionPrompt?: {
    readonly commandId: string;
    readonly sessionId: string;
    readonly participantId: string;
    readonly content: string;
    readonly expectedResponse: string;
  };
};

type FixtureBridge = Pick<SandcastleBridge, "query" | "execute"> &
  Partial<Pick<SandcastleBridge, "openEventStream" | "closeEventStream">>;
type FixtureStatus =
  | "idle"
  | "working"
  | "observed"
  | "ready"
  | "pass"
  | "error";

const parseRoute = (value: unknown): ElectronTestFixtureRoute | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const input = value as Record<string, unknown>;
  const caseCommand = EnvelopeCommandSchema.safeParse(input.caseCommand);
  const runCommand = EnvelopeCommandSchema.safeParse(input.runCommand);
  const interactionPrompt = input.interactionPrompt as
    | Record<string, unknown>
    | undefined;
  const interactionPromptValid =
    interactionPrompt === undefined ||
    (
      [
        "commandId",
        "sessionId",
        "participantId",
        "content",
        "expectedResponse",
      ] as const
    ).every(
      (key) =>
        typeof interactionPrompt[key] === "string" &&
        interactionPrompt[key].trim() !== "",
    );
  if (
    input.schemaVersion !== 1 ||
    typeof input.restoreOnLoad !== "boolean" ||
    typeof input.testRunId !== "string" ||
    input.testRunId.trim() === "" ||
    (input.candidateInputId !== undefined &&
      (typeof input.candidateInputId !== "string" ||
        input.candidateInputId.trim() === "")) ||
    (input.candidateId !== undefined &&
      (typeof input.candidateId !== "string" ||
        input.candidateId.trim() === "")) ||
    typeof input.caseCommandId !== "string" ||
    input.caseCommandId.trim() === "" ||
    typeof input.runCommandId !== "string" ||
    input.runCommandId.trim() === "" ||
    !caseCommand.success ||
    caseCommand.data.type !== "test.case-revision.register" ||
    !runCommand.success ||
    runCommand.data.type !== "test.run.create" ||
    runCommand.data.input.testRunId !== input.testRunId ||
    !interactionPromptValid
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    restoreOnLoad: input.restoreOnLoad,
    testRunId: input.testRunId,
    ...(typeof input.candidateInputId === "string"
      ? { candidateInputId: input.candidateInputId }
      : {}),
    ...(typeof input.candidateId === "string"
      ? { candidateId: input.candidateId }
      : {}),
    caseCommandId: input.caseCommandId,
    caseCommand: caseCommand.data,
    runCommandId: input.runCommandId,
    runCommand: runCommand.data,
    ...(interactionPrompt
      ? {
          interactionPrompt: interactionPrompt as NonNullable<
            ElectronTestFixtureRoute["interactionPrompt"]
          >,
        }
      : {}),
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
  const [candidateView, setCandidateView] =
    useState<CandidateQualityGateView | null>(null);
  const [candidateDiagnostic, setCandidateDiagnostic] = useState<string | null>(
    null,
  );
  const [deliveryCandidateView, setDeliveryCandidateView] =
    useState<DeliveryCandidateView | null>(null);
  const [deliveryCandidateDiagnostic, setDeliveryCandidateDiagnostic] =
    useState<string | null>(null);
  const [deliveryDecisionBusy, setDeliveryDecisionBusy] = useState(false);

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

  const runInteractionPrompt = async (): Promise<void> => {
    const prompt = props.route.interactionPrompt;
    if (!prompt) return;
    const turn = unwrap(
      await bridge.execute({
        commandId: prompt.commandId,
        command: {
          type: "interaction.prompt",
          sessionId: prompt.sessionId,
          participantId: prompt.participantId,
          content: prompt.content,
        },
      }),
    ) as { readonly id: string };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await bridge.query({
        type: "interaction.inspect",
        sessionId: prompt.sessionId,
      });
      const interaction = result.view as {
        readonly turns: readonly {
          readonly id: string;
          readonly status: string;
          readonly outputMessageId: string | null;
        }[];
        readonly messages: readonly {
          readonly id: string;
          readonly content: string;
        }[];
      };
      const current = interaction.turns.find((entry) => entry.id === turn.id);
      if (current?.status === "completed") {
        const output = interaction.messages.find(
          (entry) => entry.id === current.outputMessageId,
        );
        if (output?.content !== prompt.expectedResponse) {
          throw new Error("Interaction Turn response did not match exactly.");
        }
        return;
      }
      if (
        current &&
        ["failed", "cancelled", "interrupted"].includes(current.status)
      ) {
        throw new Error(`Interaction Turn reached ${current.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the Interaction Turn.");
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

  useEffect(() => {
    const candidateInputId = props.route.candidateInputId;
    if (!candidateInputId) return;
    if (!bridge.openEventStream || !bridge.closeEventStream) {
      setCandidateDiagnostic(
        "Candidate Quality Gates unavailable; Runtime Event stream is missing.",
      );
      return;
    }
    let active = true;
    let close: (() => Promise<void>) | undefined;
    setCandidateDiagnostic("Synchronizing Candidate Quality Gates…");
    void connectCandidateQualityGates({
      bridge: {
        query: bridge.query,
        execute: bridge.execute,
        openEventStream: bridge.openEventStream,
        closeEventStream: bridge.closeEventStream,
      },
      candidateInputId,
      onView: (view) => {
        if (active) setCandidateView(view);
      },
      onDiagnostic: (diagnostic) => {
        if (active) setCandidateDiagnostic(diagnostic);
      },
    })
      .then((connection) => {
        close = connection.close;
        if (!active) void connection.close();
      })
      .catch((cause) => {
        if (active) {
          setCandidateDiagnostic(
            `Candidate Quality Gates unavailable; resync required: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      });
    return () => {
      active = false;
      if (close) void close();
    };
  }, [bridge, props.route.candidateInputId]);

  useEffect(() => {
    const candidateId = props.route.candidateId;
    if (!candidateId) return;
    if (!bridge.openEventStream || !bridge.closeEventStream) {
      setDeliveryCandidateDiagnostic(
        "Delivery Candidate unavailable; Runtime Event stream is missing.",
      );
      return;
    }
    let active = true;
    let close: (() => Promise<void>) | undefined;
    setDeliveryCandidateDiagnostic("Synchronizing Delivery Candidate…");
    void connectDeliveryCandidate({
      bridge: {
        query: bridge.query,
        execute: bridge.execute,
        openEventStream: bridge.openEventStream,
        closeEventStream: bridge.closeEventStream,
      },
      candidateId,
      onView: (view) => {
        if (active) setDeliveryCandidateView(view);
      },
      onDiagnostic: (diagnostic) => {
        if (active) setDeliveryCandidateDiagnostic(diagnostic);
      },
    })
      .then((connection) => {
        close = connection.close;
        if (!active) void connection.close();
      })
      .catch((cause) => {
        if (active) {
          setDeliveryCandidateDiagnostic(
            `Delivery Candidate unavailable; resync required: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      });
    return () => {
      active = false;
      if (close) void close();
    };
  }, [bridge, props.route.candidateId]);

  const decideHumanRelease = async (input: {
    readonly decision: "accepted" | "rejected" | "changes-requested";
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
    readonly reworkScope?: "same-boundary" | "boundary-changing";
    readonly childRunId?: string;
    readonly responsibilityKind?:
      | "defect"
      | "work-package"
      | "contract"
      | "test"
      | "gate";
    readonly responsibilityId?: string;
  }): Promise<void> => {
    if (!deliveryCandidateView) return;
    setDeliveryDecisionBusy(true);
    setDeliveryCandidateDiagnostic(null);
    try {
      const result = unwrap(
        await bridge.execute({
          commandId: `${deliveryCandidateView.id}:human-release-command`,
          command: {
            type: "delivery.release.decide",
            decisionId: `${deliveryCandidateView.id}:human-release-decision`,
            candidateId: deliveryCandidateView.id,
            expectedCandidateHash: deliveryCandidateView.manifestHash,
            decision: input.decision,
            reason: input.reason,
            evidenceRefs: [...input.evidenceRefs],
            ...(input.decision === "changes-requested"
              ? {
                  rework: {
                    scope: input.reworkScope ?? "same-boundary",
                    ...(input.reworkScope === "boundary-changing" &&
                    input.childRunId
                      ? { childRunId: input.childRunId }
                      : {}),
                    responsibility: {
                      kind: input.responsibilityKind ?? "unknown",
                      ...(input.responsibilityId
                        ? { id: input.responsibilityId }
                        : {}),
                      summary:
                        input.reworkScope === "boundary-changing"
                          ? "The Product Baseline, Repository, or Pipeline boundary must change."
                          : "The exact frozen responsibility requires same-boundary rework.",
                    },
                  },
                }
              : {}),
          },
        }),
      ) as DeliveryCandidateView;
      setDeliveryCandidateView(result);
    } catch (cause) {
      setDeliveryCandidateDiagnostic(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setDeliveryDecisionBusy(false);
    }
  };

  const recoverHumanRelease = async (input: {
    readonly decisionId: string;
    readonly authorityKind:
      | "work-package-version"
      | "test-rework-run"
      | "candidate-input-recheck";
    readonly authorityId: string;
  }): Promise<void> => {
    if (!deliveryCandidateView) return;
    setDeliveryDecisionBusy(true);
    setDeliveryCandidateDiagnostic(null);
    try {
      const result = unwrap(
        await bridge.execute({
          commandId: `${deliveryCandidateView.id}:human-release-recovery:${input.decisionId}`,
          command: {
            type: "delivery.release.recover",
            candidateId: deliveryCandidateView.id,
            expectedCandidateHash: deliveryCandidateView.manifestHash,
            decisionId: input.decisionId,
            authority: {
              kind: input.authorityKind,
              id: input.authorityId,
            },
          },
        }),
      ) as DeliveryCandidateView;
      setDeliveryCandidateView(result);
    } catch (cause) {
      setDeliveryCandidateDiagnostic(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setDeliveryDecisionBusy(false);
    }
  };

  const decideCriticalRiskEscalation = async (input: {
    readonly decision: "authorize-gate-continuation" | "reject";
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
  }): Promise<void> => {
    if (!candidateView) return;
    setDeliveryDecisionBusy(true);
    setCandidateDiagnostic(null);
    try {
      unwrap(
        await bridge.execute({
          commandId: `${candidateView.candidateInput.id}:critical-escalation-command`,
          command: {
            type: "quality-gate.critical-escalation.decide",
            escalationId: `${candidateView.candidateInput.id}:critical-escalation`,
            candidateInputId: candidateView.candidateInput.id,
            expectedCandidateInputHash:
              candidateView.candidateInput.manifestHash,
            decision: input.decision,
            reason: input.reason,
            evidenceRefs: [...input.evidenceRefs],
          },
        }),
      );
    } catch (cause) {
      setCandidateDiagnostic(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setDeliveryDecisionBusy(false);
    }
  };

  const advance = async (): Promise<void> => {
    if (status === "working" || status === "observed" || status === "pass")
      return;
    setStatus("working");
    setError(null);
    try {
      if (status === "idle" && props.route.interactionPrompt) {
        await runInteractionPrompt();
        setStatus("observed");
        return;
      }
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
      const view = await waitForState(["reconciling", "running", "passed"]);
      setStatus(view.state === "passed" ? "pass" : "ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  };

  const label =
    status === "pass"
      ? "PASS"
      : status === "observed"
        ? "Interaction Observed"
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
          disabled={
            status === "working" || status === "observed" || status === "pass"
          }
          onClick={() => void advance()}
        >
          {label}
        </button>
        <output id="test-status" aria-live="polite">
          {error ?? (status === "pass" ? "PASS" : status)}
        </output>
      </section>
      <CandidateQualityGatePanel
        busy={deliveryDecisionBusy}
        diagnostic={candidateDiagnostic}
        onCriticalEscalation={(input) =>
          void decideCriticalRiskEscalation(input)
        }
        view={candidateView}
      />
      <DeliveryCandidatePanel
        busy={deliveryDecisionBusy}
        diagnostic={deliveryCandidateDiagnostic}
        onDecision={(input) => void decideHumanRelease(input)}
        onRecovery={(input) => void recoverHumanRelease(input)}
        view={deliveryCandidateView}
      />
    </main>
  );
}
