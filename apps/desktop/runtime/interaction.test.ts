import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createModelOnlyInteractionExecutionAdapter } from "./adapters/interactionExecutionAdapter.js";
import type { ModelOnlyInteractionExecutionAdapter } from "./adapters/interactionExecutionAdapter.js";
import {
  MODEL_ONLY_CONTEXT_SCHEMA_HASH,
  type ExecutionEventSink,
} from "./execution/contract.js";
import { openCompanyDatabase, type CompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-interaction-"));

const createConsultation = (database: CompanyDatabase) => {
  const project = database.catalog.createProject({
    name: "Checkout",
    goal: "Ship checkout",
  });
  const session = database.interaction.createSession({
    projectId: project.id,
    mode: "consultation",
  });
  const human = database.interaction.addParticipant({
    sessionId: session.id,
    participantType: "human",
    participantRef: "user-local",
    role: "requester",
  });
  database.interaction.addParticipant({
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: "product-planner-member",
    role: "consulted-member",
  });
  return { project, session, human };
};

const promptEnvelope = (
  sessionId: string,
  participantId: string,
  commandId: string,
) => ({
  schemaVersion: 1 as const,
  commandId,
  actor: {
    type: "human" as const,
    id: "user-local",
    authenticatedBy: "local-session" as const,
  },
  command: {
    type: "interaction.prompt" as const,
    sessionId,
    participantId,
    content: "What is the main risk?",
  },
});

describe("Runtime Interaction", () => {
  it("keeps one Turn reconciling when targeted cancellation is unknown", async () => {
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter: ModelOnlyInteractionExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: false,
        enforceNoSideEffects: {
          mechanism: "model-only",
          mechanismVersion: "1",
          policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
        },
      },
      execute: async (_request, _sink, signal) => {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("local worker aborted");
      },
      cancel: async () => "unknown",
      reconcile: async () => ({ status: "unknown", evidenceRefs: [] }),
    };
    const database = openCompanyDatabase(tempCompanyDir(), {
      interactionExecutionAdapter: adapter,
    });
    try {
      const { session, human } = createConsultation(database);
      const accepted = database.commandRegistry.execute(
        promptEnvelope(session.id, human.id, "prompt:cancel-one"),
      );
      assert.equal(accepted.status, "succeeded");
      if (accepted.status !== "succeeded") assert.fail("Prompt was rejected.");
      const turnExecution = database.interaction.executeTurn(accepted.value.id);
      await executing;

      const cancelled = await database.interaction.cancelInteractionTurn(
        accepted.value.id,
      );

      assert.equal(cancelled.status, "reconciling");
      assert.equal(
        cancelled.failureCode,
        "TURN_CANCELLATION_RECONCILIATION_REQUIRED",
      );
      await turnExecution;
    } finally {
      database.close();
    }
  });

  it("cancels an ACP-owned Turn only after the Adapter records a terminal cancelled Fact", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellationRequested = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const adapter: ModelOnlyInteractionExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: false,
        enforceNoSideEffects: {
          mechanism: "model-only",
          mechanismVersion: "1",
          policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
        },
      },
      execute: async (request, sink) => {
        notifyStarted();
        await cancellationRequested;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-cancelled",
          ordinal: 1,
          kind: "cancelled",
          schemaVersion: 1,
          payload: { code: "MODEL_CANCELLED" },
          evidenceRefs: [],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "cancelled",
          evidenceRefs: [],
        };
      },
      cancel: async () => {
        releaseCancellation();
        return "cancelled";
      },
    };
    const database = openCompanyDatabase(tempCompanyDir(), {
      interactionExecutionAdapter: adapter,
    });
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      const client = database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "human",
        participantRef: "editor-1",
        role: "requester",
      });
      database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: "product-planner-member",
        role: "assistant",
      });
      const prompt = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "acp:editor-1:prompt:prompt-1",
        actor: {
          type: "acp-client",
          id: "editor-1",
          authenticatedBy: "acp-connection",
        },
        consumerId: "acp:editor-1",
        command: {
          type: "interaction.prompt",
          sessionId: session.id,
          participantId: client.id,
          content: "Wait for cancellation.",
        },
      });
      assert.equal(prompt.status, "succeeded");
      if (prompt.status !== "succeeded") assert.fail("Prompt should succeed.");
      const executing = database.interaction.executeTurn(prompt.value.id);
      await started;

      const cancellationEnvelope = {
        schemaVersion: 1 as const,
        commandId: `acp:editor-1:cancel:${prompt.value.id}`,
        actor: {
          type: "acp-client" as const,
          id: "editor-1",
          authenticatedBy: "acp-connection" as const,
        },
        consumerId: "acp:editor-1",
        command: {
          type: "interaction.turn.cancel" as const,
          sessionId: session.id,
          turnId: prompt.value.id,
        },
      };
      const requested = database.commandRegistry.execute(cancellationEnvelope);
      assert.equal(requested.status, "succeeded");
      assert.equal(
        database.interaction.inspectTurn(prompt.value.id).status,
        "reconciling",
      );

      const cancelled = await database.interaction.cancelTurn(prompt.value.id);
      await executing;
      assert.equal(cancelled.status, "cancelled");
      assert.equal(
        database.interaction.inspectSession(session.id).session.status,
        "active",
      );
      const replayed = database.commandRegistry.execute(cancellationEnvelope);
      assert.equal(replayed.status, "succeeded");
      if (replayed.status !== "succeeded") {
        assert.fail("Cancellation replay should succeed.");
      }
      assert.equal(replayed.value.status, "cancelled");
      assert.equal(
        database.events
          .readAfter(0, 100)
          .some(
            (event) =>
              event.type === "interaction.turn.cancelled" &&
              event.interactionTurnId === prompt.value.id,
          ),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("executes one replay-safe model-only consultation Turn through fenced Execution Facts", async () => {
    let receivedContext:
      | Parameters<
          Parameters<
            typeof createModelOnlyInteractionExecutionAdapter
          >[0]["complete"]
        >[0]["context"]
      | undefined;
    const database = openCompanyDatabase(tempCompanyDir(), {
      interactionExecutionAdapter: createModelOnlyInteractionExecutionAdapter({
        complete: async (input) => {
          receivedContext = input.context;
          return {
            providerExecutionRef: "provider-turn-1",
            response: "Keep the first release narrow.",
            usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
          };
        },
      }),
    });
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: 0,
        name: "Checkout",
        goal: "Ship checkout",
        sharedContext: "Preserve payments; api_key=super-secret",
        repositoryReferences: ["/private/repositories/checkout"],
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      const human = database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      });
      database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: "product-planner-member",
        role: "consulted-member",
      });
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "prompt:checkout-risk",
        actor: {
          type: "human" as const,
          id: "user-local",
          authenticatedBy: "local-session" as const,
        },
        consumerId: "interaction-test",
        command: {
          type: "interaction.prompt" as const,
          sessionId: session.id,
          participantId: human.id,
          content: "Should we use token=prompt-secret in the first release?",
        },
      };

      const accepted = database.commandRegistry.execute(envelope);
      const replayed = database.commandRegistry.execute(envelope);
      assert.equal(accepted.status, "succeeded");
      assert.equal(replayed.status, "succeeded");
      if (accepted.status !== "succeeded" || replayed.status !== "succeeded") {
        assert.fail("Prompt Command should be accepted.");
      }
      assert.equal(replayed.value.id, accepted.value.id);
      assert.equal(
        accepted.value.executionOperationKey,
        `interaction-turn:${accepted.value.id}`,
      );
      assert.equal(accepted.value.status, "queued");

      await database.interaction.executeTurn(accepted.value.id);

      const inspected = database.interaction.inspectSession(session.id);
      const turn = inspected.turns[0];
      assert.equal(turn?.id, accepted.value.id);
      assert.equal(turn?.status, "completed");
      assert.equal(turn?.executionEpoch, 1);
      assert.match(turn?.fenceToken ?? "", /^interaction-fence:/);
      assert.equal(turn?.contextHash.length, 64);
      assert.equal(turn?.contextSchemaHash.length, 64);
      assert.match(
        receivedContext?.project.sharedContext ?? "",
        /\[REDACTED\]/,
      );
      assert.doesNotMatch(
        receivedContext?.project.sharedContext ?? "",
        /super-secret/,
      );
      assert.match(receivedContext?.prompt ?? "", /\[REDACTED\]/);
      assert.doesNotMatch(receivedContext?.prompt ?? "", /prompt-secret/);
      assert.equal(
        "repositoryReferences" in (receivedContext?.project ?? {}),
        false,
      );
      assert.equal(
        inspected.messages.filter(
          (message) => message.participantId === human.id,
        ).length,
        1,
      );
      assert.equal(
        inspected.messages.some(
          (message) => message.content === "Keep the first release narrow.",
        ),
        true,
      );

      const execution = database.interaction.inspectTurnExecution(
        accepted.value.id,
      );
      assert.equal(execution.target.kind, "interaction-turn");
      assert.equal(execution.leases[0]?.leaseKind, "execution");
      assert.deepEqual(
        execution.facts.map((fact) => fact.kind),
        ["provider-started", "message", "usage", "completed"],
      );
      assert.equal(database.pipelineRuntime.listRuns().length, 0);
      assert.equal(
        database.artifactRegistry.listVersions(project.id).length,
        0,
      );
      assert.equal(inspected.permissions.length, 0);
      assert.deepEqual(
        database.events
          .readAfter(0, 100)
          .filter((event) => event.interactionTurnId === accepted.value.id)
          .map((event) => event.type),
        [
          "interaction.turn.started",
          "message.delta",
          "usage.recorded",
          "interaction.turn.completed",
        ],
      );
    } finally {
      database.close();
    }
  });

  it("rejects consultation when the Adapter cannot prove model-only isolation", () => {
    const unsafeAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: false,
        enforceNoSideEffects: false,
      },
      execute: async () => {
        assert.fail("Unsafe Adapter must not execute.");
      },
      cancel: async () => "not-found" as const,
    } as unknown as ModelOnlyInteractionExecutionAdapter;
    const database = openCompanyDatabase(tempCompanyDir(), {
      interactionExecutionAdapter: unsafeAdapter,
    });
    try {
      const { session, human } = createConsultation(database);
      const result = database.commandRegistry.execute(
        promptEnvelope(session.id, human.id, "prompt:unsafe-adapter"),
      );
      assert.deepEqual(result, {
        status: "rejected",
        error: {
          code: "CONSULTATION_ISOLATION_REQUIRED",
          message:
            "Consultation requires a trusted model-only Execution Adapter.",
        },
        effectIds: [],
      });
      assert.equal(
        database.interaction.inspectSession(session.id).turns.length,
        0,
      );
    } finally {
      database.close();
    }
  });

  it("rejects effect-bearing Facts and records no Run, Artifact, or Permission effect", async () => {
    const forbiddenAdapter: ModelOnlyInteractionExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: false,
        enforceNoSideEffects: {
          mechanism: "model-only",
          mechanismVersion: "1",
          policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
        },
      },
      execute: async (request, sink) => {
        await sink.record({
          adapterSchemaVersion: 1,
          factId: "tool-call",
          ordinal: 1,
          kind: "tool-call",
          schemaVersion: 1,
          payload: { tool: "shell" },
          evidenceRefs: [],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: "unreachable",
          status: "failed",
          evidenceRefs: [],
        };
      },
      cancel: async () => "not-found",
    };
    const database = openCompanyDatabase(tempCompanyDir(), {
      interactionExecutionAdapter: forbiddenAdapter,
    });
    try {
      const { project, session, human } = createConsultation(database);
      const result = database.commandRegistry.execute(
        promptEnvelope(session.id, human.id, "prompt:forbidden-fact"),
      );
      assert.equal(result.status, "succeeded");
      if (result.status !== "succeeded")
        assert.fail("Prompt should be accepted.");
      const turn = await database.interaction.executeTurn(result.value.id);
      assert.equal(turn.status, "failed");
      assert.equal(turn.failureCode, "EXECUTION_ADAPTER_PROTOCOL");
      assert.deepEqual(
        database.interaction.inspectTurnExecution(turn.id).facts,
        [],
      );
      assert.equal(database.pipelineRuntime.listRuns().length, 0);
      assert.equal(
        database.artifactRegistry.listVersions(project.id).length,
        0,
      );
      assert.equal(
        database.interaction.inspectSession(session.id).permissions.length,
        0,
      );
    } finally {
      database.close();
    }
  });

  it("replays the same Turn as reconciling after a Runtime crash and blocks replacement work", () => {
    const companyDir = tempCompanyDir();
    const adapter = createModelOnlyInteractionExecutionAdapter({
      complete: async () => ({
        providerExecutionRef: "provider-turn",
        response: "response",
      }),
    });
    const first = openCompanyDatabase(companyDir, {
      interactionExecutionAdapter: adapter,
    });
    const { session, human } = createConsultation(first);
    const envelope = promptEnvelope(
      session.id,
      human.id,
      "prompt:crash-replay",
    );
    const accepted = first.commandRegistry.execute(envelope);
    assert.equal(accepted.status, "succeeded");
    if (accepted.status !== "succeeded")
      assert.fail("Prompt should be accepted.");
    const turnId = accepted.value.id;
    const databasePath = first.path;
    first.close();

    const crashed = new DatabaseSync(databasePath);
    crashed
      .prepare(
        `UPDATE interaction_turns
            SET status = 'running', started_at = created_at
          WHERE id = ?`,
      )
      .run(turnId);
    crashed.close();

    const restarted = openCompanyDatabase(companyDir, {
      interactionExecutionAdapter: adapter,
    });
    try {
      const turn = restarted.interaction.inspectTurn(turnId);
      assert.equal(turn.status, "reconciling");
      assert.equal(turn.failureCode, "RUNTIME_RESTART");
      const replay = restarted.commandRegistry.execute(envelope);
      assert.equal(replay.status, "succeeded");
      if (replay.status !== "succeeded") assert.fail("Replay should succeed.");
      assert.equal(replay.value.id, turnId);
      assert.equal(replay.value.status, "reconciling");
      const replacement = restarted.commandRegistry.execute(
        promptEnvelope(session.id, human.id, "prompt:replacement"),
      );
      assert.equal(replacement.status, "rejected");
      if (replacement.status !== "rejected")
        assert.fail("Replacement should be rejected.");
      assert.equal(replacement.error.code, "INTERACTION_TURN_IN_PROGRESS");
    } finally {
      restarted.close();
    }
  });

  it("reconciles a crashed standalone Turn through an accepted not-started Fact", async () => {
    const companyDir = tempCompanyDir();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const adapter: ModelOnlyInteractionExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: false,
        enforceNoSideEffects: {
          mechanism: "model-only",
          mechanismVersion: "1",
          policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
        },
      },
      execute: async (request, sink) => {
        notifyStarted();
        await executionReleased;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "late-completed",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: {},
          evidenceRefs: [],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded",
          evidenceRefs: [],
        };
      },
      cancel: async () => "unknown",
      reconcile: async (_input, sink: ExecutionEventSink) => {
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-not-started",
          ordinal: 1,
          kind: "not-started",
          schemaVersion: 1,
          payload: { providerReceipt: "provider-receipt:turn-not-started" },
          evidenceRefs: ["provider-receipt:turn-not-started"],
        });
        return {
          status: "not-started",
          terminalExecutionFactId: receipt.executionFactId,
          evidenceRefs: ["provider-receipt:turn-not-started"],
        };
      },
      reattach: async () => {
        throw new Error("not supported");
      },
    };
    const first = openCompanyDatabase(companyDir, {
      interactionExecutionAdapter: adapter,
    });
    const { session, human } = createConsultation(first);
    const envelope = promptEnvelope(
      session.id,
      human.id,
      "prompt:formal-crash-reconcile",
    );
    const accepted = first.commandRegistry.execute(envelope);
    assert.equal(accepted.status, "succeeded");
    if (accepted.status !== "succeeded") assert.fail("Prompt should succeed.");
    const executing = first.interaction.executeTurn(accepted.value.id);
    await started;

    const restarted = openCompanyDatabase(companyDir, {
      interactionExecutionAdapter: adapter,
    });
    try {
      assert.equal(
        restarted.interaction.inspectTurn(accepted.value.id).status,
        "reconciling",
      );
      assert.equal(await restarted.interaction.reconcilePendingTurns(), 1);
      const interrupted = restarted.interaction.inspectTurn(accepted.value.id);
      assert.equal(interrupted.status, "interrupted");
      assert.deepEqual(
        restarted.interaction
          .inspectTurnExecution(accepted.value.id)
          .leases.map((lease) => [lease.leaseKind, lease.executionEpoch]),
        [
          ["execution", 1],
          ["reconciliation", 2],
        ],
      );
      const replacement = restarted.commandRegistry.execute(
        promptEnvelope(session.id, human.id, "prompt:after-interrupted"),
      );
      assert.equal(replacement.status, "succeeded");
    } finally {
      releaseExecution();
      await executing;
      restarted.close();
      first.close();
    }
  });

  it("reattaches a proven running standalone Turn under a new execution fence", async () => {
    const companyDir = tempCompanyDir();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseOriginalExecution!: () => void;
    const originalExecutionReleased = new Promise<void>((resolve) => {
      releaseOriginalExecution = resolve;
    });
    let reattachedOperationKey = "";
    const adapter: ModelOnlyInteractionExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: true,
        strongExecutionFence: true,
        enforceNoSideEffects: {
          mechanism: "model-only",
          mechanismVersion: "1",
          policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
        },
      },
      execute: async (request, sink) => {
        notifyStarted();
        await originalExecutionReleased;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "late-original-completion",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: {},
          evidenceRefs: [],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded",
          evidenceRefs: [],
        };
      },
      cancel: async () => "unknown",
      reconcile: async () => ({
        status: "running",
        providerExecutionRef: "provider-turn:running",
      }),
      reattach: async (request, providerExecutionRef, sink) => {
        assert.equal(providerExecutionRef, "provider-turn:running");
        assert.equal(request.lease.leaseKind, "execution");
        assert.equal(request.lease.executionEpoch, 3);
        assert.equal(request.permissionScope, "none");
        assert.equal(request.sideEffectPolicy, "none");
        reattachedOperationKey = request.operationKey;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "reattached-turn-completion",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: {},
          evidenceRefs: ["provider-receipt:reattached-turn"],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded",
          evidenceRefs: ["provider-receipt:reattached-turn"],
        };
      },
    };
    const first = openCompanyDatabase(companyDir, {
      interactionExecutionAdapter: adapter,
    });
    const { session, human } = createConsultation(first);
    const envelope = promptEnvelope(
      session.id,
      human.id,
      "prompt:formal-running-reattach",
    );
    const accepted = first.commandRegistry.execute(envelope);
    assert.equal(accepted.status, "succeeded");
    if (accepted.status !== "succeeded") assert.fail("Prompt should succeed.");
    const executing = first.interaction.executeTurn(accepted.value.id);
    await started;

    const restarted = openCompanyDatabase(companyDir, {
      interactionExecutionAdapter: adapter,
    });
    try {
      const reconciling = restarted.interaction.inspectTurn(accepted.value.id);
      assert.equal(reconciling.status, "reconciling");
      assert.equal(await restarted.interaction.reconcilePendingTurns(), 1);

      const completed = restarted.interaction.inspectTurn(accepted.value.id);
      assert.equal(completed.status, "completed");
      assert.equal(
        reattachedOperationKey,
        `interaction-turn:${accepted.value.id}`,
      );
      assert.deepEqual(
        restarted.interaction
          .inspectTurnExecution(accepted.value.id)
          .leases.map((lease) => [lease.leaseKind, lease.executionEpoch]),
        [
          ["execution", 1],
          ["reconciliation", 2],
          ["execution", 3],
        ],
      );
      const replacement = restarted.commandRegistry.execute(
        promptEnvelope(session.id, human.id, "prompt:after-reattach"),
      );
      assert.equal(replacement.status, "succeeded");
    } finally {
      releaseOriginalExecution();
      await executing;
      restarted.close();
      first.close();
    }
  });

  it("persists a Session, Messages, and an owned Permission decision", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      const participant = database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      });
      const message = database.interaction.addMessage({
        sessionId: session.id,
        participantId: participant.id,
        kind: "text",
        content: "Please explain the delivery risk.",
      });
      const permission = database.interaction.requestPermission({
        sessionId: session.id,
        scope: "repository.write",
      });
      assert.throws(
        () =>
          database.interaction.decidePermission({
            permissionId: permission.id,
            expectedStatus: "pending",
            decision: "approved",
            actor: {
              type: "test-driver",
              id: "forged-human",
              authenticatedBy: "runtime",
            },
            commandId: "permission-decision:forged",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PERMISSION_ACTOR_INVALID",
      );
      const decided = database.interaction.decidePermission({
        permissionId: permission.id,
        expectedStatus: "pending",
        decision: "approved",
        actor: {
          type: "human",
          id: "user-local",
          authenticatedBy: "local-session",
        },
        commandId: "permission-decision:approve",
      });
      const replayed = database.interaction.decidePermission({
        permissionId: permission.id,
        expectedStatus: "pending",
        decision: "approved",
        actor: {
          type: "human",
          id: "user-local",
          authenticatedBy: "local-session",
        },
        commandId: "permission-decision:approve",
      });
      const inspected = database.interaction.inspectSession(session.id);
      const closed = database.interaction.closeSession(session.id);

      assert.equal(message.content, "Please explain the delivery risk.");
      assert.equal(decided.status, "approved");
      assert.equal(replayed.id, decided.id);
      assert.deepEqual(decided.decisionActor, {
        type: "human",
        id: "user-local",
        authenticatedBy: "local-session",
      });
      assert.equal(decided.decisionCommandId, "permission-decision:approve");
      assert.equal(inspected.session.mode, "consultation");
      assert.equal(inspected.participants[0]?.id, participant.id);
      assert.equal(inspected.messages[0]?.id, message.id);
      assert.equal(inspected.permissions[0]?.status, "approved");
      assert.equal(inspected.permissions[0]?.scope, "repository.write");
      assert.deepEqual(inspected.permissions[0]?.decisionActor, {
        type: "human",
        id: "user-local",
        authenticatedBy: "local-session",
      });
      assert.equal(closed.status, "closed");
      assert.throws(
        () =>
          database.interaction.addMessage({
            sessionId: session.id,
            participantId: participant.id,
            kind: "text",
            content: "Late message",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "INTERACTION_SESSION_STATE_INVALID",
      );
      assert.equal(database.pipelineRuntime.listRuns().length, 0);
      assert.throws(
        () =>
          database.interaction.requestPermission({
            sessionId: session.id,
            scope: "repository.*",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "INTERACTION_SESSION_STATE_INVALID",
      );
    } finally {
      database.close();
    }
  });

  it("rejects wildcard Permission scope before persisting a request", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });

      assert.throws(
        () =>
          database.interaction.requestPermission({
            sessionId: session.id,
            scope: "repository.*",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PERMISSION_SCOPE_INVALID",
      );
      assert.equal(
        database.interaction.inspectSession(session.id).permissions.length,
        0,
      );
    } finally {
      database.close();
    }
  });
});
