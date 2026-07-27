import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorRef } from "./interface.js";
import {
  createExecutionFactSink,
  inspectExecution,
  ExecutionFactError,
} from "./execution/executionFacts.js";
import {
  MODEL_ONLY_CONTEXT_SCHEMA_HASH,
  type AdapterExecutionFact,
  type ExecutionAdapterCapabilities,
  type ExecutionCompletion,
  type ExecutionEventSink,
  type ExecutionInspection,
  type ExecutionLeaseContext,
  type InteractionExecutionRequest,
  type ModelOnlyInteractionContext,
} from "./execution/contract.js";
import type { RuntimeEvents } from "./events/subscription.js";
import type { ModelOnlyInteractionExecutionAdapter } from "./adapters/interactionExecutionAdapter.js";

export interface InteractionSessionView {
  readonly id: string;
  readonly mode: "consultation" | "run-collaboration";
  readonly projectId: string;
  readonly runId: string | null;
  readonly nodeRunId: string | null;
  readonly status: "active" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface InteractionTurnView {
  readonly id: string;
  readonly sessionId: string;
  readonly inputMessageId: string;
  readonly outputMessageId: string | null;
  readonly status:
    | "queued"
    | "running"
    | "reconciling"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly commandId: string;
  readonly executionOperationKey: string;
  readonly executionLeaseId: string | null;
  readonly executionEpoch: number | null;
  readonly fenceToken: string | null;
  readonly mechanism: "model-only";
  readonly mechanismVersion: string;
  readonly contextHash: string;
  readonly contextSchemaHash: string;
  readonly terminalExecutionFactId: string | null;
  readonly providerExecutionRef: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface SessionParticipantView {
  readonly id: string;
  readonly sessionId: string;
  readonly participantType: "human" | "ai-member" | "system";
  readonly participantRef: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface SessionMessageView {
  readonly id: string;
  readonly sessionId: string;
  readonly participantId: string;
  readonly kind: "text" | "tool" | "status";
  readonly content: string;
  readonly createdAt: string;
}

export interface PermissionRequestView {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly nodeRunId: string | null;
  readonly scope: string;
  readonly status: "pending" | "approved" | "denied" | "expired";
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionActor: ActorRef | null;
  readonly decisionCommandId: string | null;
}

export interface InteractionView {
  readonly session: InteractionSessionView;
  readonly participants: readonly SessionParticipantView[];
  readonly messages: readonly SessionMessageView[];
  readonly turns: readonly InteractionTurnView[];
  readonly permissions: readonly PermissionRequestView[];
}

export interface RuntimeInteraction {
  readonly createSession: (input: {
    readonly projectId: string;
    readonly mode: InteractionSessionView["mode"];
    readonly runId?: string;
    readonly nodeRunId?: string;
  }) => InteractionSessionView;
  readonly closeSession: (sessionId: string) => InteractionSessionView;
  readonly addParticipant: (input: {
    readonly sessionId: string;
    readonly participantType: SessionParticipantView["participantType"];
    readonly participantRef: string;
    readonly role: string;
  }) => SessionParticipantView;
  readonly addMessage: (input: {
    readonly sessionId: string;
    readonly participantId: string;
    readonly kind: SessionMessageView["kind"];
    readonly content: string;
  }) => SessionMessageView;
  readonly acceptPromptInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly sessionId: string;
    readonly participantId: string;
    readonly content: string;
  }) => InteractionTurnView;
  readonly executeTurn: (turnId: string) => Promise<InteractionTurnView>;
  readonly cancelInteractionTurn: (
    turnId: string,
  ) => Promise<InteractionTurnView>;
  readonly requestInteractionTurnCancellationInTransaction: (
    turnId: string,
  ) => InteractionTurnView;
  readonly dispatchInteractionTurnCancellation: (
    turnId: string,
  ) => Promise<void>;
  readonly requestTurnCancellationInTransaction: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly actor: ActorRef;
    readonly commandId: string;
  }) => InteractionTurnView;
  readonly cancelTurn: (turnId: string) => Promise<InteractionTurnView>;
  readonly reconcilePendingTurns: () => Promise<number>;
  readonly prepareForShutdown: () => Promise<void>;
  readonly inspectTurn: (turnId: string) => InteractionTurnView;
  readonly inspectTurnExecution: (turnId: string) => ExecutionInspection;
  readonly requestPermission: (input: {
    readonly sessionId: string;
    readonly scope: string;
    readonly expiresAt?: string;
  }) => PermissionRequestView;
  readonly requestExecutionPermissionInTransaction: (input: {
    readonly projectId: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly scope: string;
    readonly expiresAt?: string;
  }) => PermissionRequestView;
  readonly decidePermission: (input: {
    readonly permissionId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "denied";
    readonly actor: ActorRef;
    readonly commandId: string;
  }) => PermissionRequestView;
  readonly decidePermissionInTransaction: (input: {
    readonly permissionId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "denied";
    readonly actor: ActorRef;
    readonly commandId: string;
  }) => PermissionRequestView;
  readonly inspectPermission: (permissionId: string) => PermissionRequestView;
  readonly inspectSession: (sessionId: string) => InteractionView;
  readonly listSessions: (projectId: string) => readonly InteractionView[];
}

export class RuntimeInteractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeInteractionError";
  }
}

export const openRuntimeInteraction = (
  database: DatabaseSync,
  options: {
    readonly clock?: () => Date;
    readonly events?: RuntimeEvents;
    readonly interactionExecutionAdapter?: ModelOnlyInteractionExecutionAdapter;
  } = {},
): RuntimeInteraction => {
  const clock = options.clock ?? (() => new Date());
  const interactionAdapter = options.interactionExecutionAdapter;
  const activeTurns = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly done: Promise<void>;
    }
  >();
  const appendMutation = (input: {
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly eventType: string;
    readonly runId?: string | null;
    readonly nodeRunId?: string | null;
    readonly sessionId: string;
    readonly projectId?: string;
    readonly permissionRequestId?: string;
    readonly payload: unknown;
    readonly createdAt: string;
    readonly actor?: ActorRef;
    readonly commandId?: string;
  }): void => {
    const commandContext = database
      .prepare(
        `SELECT command_id AS commandId, actor_type AS actorType,
                actor_id AS actorId, authenticated_by AS authenticatedBy
           FROM runtime_unit_of_work_context WHERE slot = 1`,
      )
      .get() as
      | {
          readonly commandId: string;
          readonly actorType: ActorRef["type"];
          readonly actorId: string;
          readonly authenticatedBy: ActorRef["authenticatedBy"];
        }
      | undefined;
    const actor =
      input.actor ??
      (commandContext
        ? {
            type: commandContext.actorType,
            id: commandContext.actorId,
            authenticatedBy: commandContext.authenticatedBy,
          }
        : undefined);
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.action,
        input.entityType,
        input.entityId,
        input.runId ?? null,
        input.nodeRunId ?? null,
        JSON.stringify(input.payload),
        input.createdAt,
        input.commandId ?? commandContext?.commandId ?? null,
        actor?.type ?? null,
        actor?.id ?? null,
        actor?.authenticatedBy ?? null,
      );
    if (input.permissionRequestId) {
      if (!options.events || !input.projectId) {
        throw new RuntimeInteractionError(
          "RUNTIME_EVENTS_UNAVAILABLE",
          "Permission mutations require the Runtime Event outbox.",
        );
      }
      options.events.append({
        type: input.eventType,
        scope: {
          companyId: "company",
          projectId: input.projectId,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
          sessionId: input.sessionId,
          permissionRequestId: input.permissionRequestId,
          ...((input.commandId ?? commandContext?.commandId)
            ? { commandId: input.commandId ?? commandContext!.commandId }
            : {}),
        },
        payload: input.payload,
        timestamp: input.createdAt,
      });
      return;
    }
    database
      .prepare(
        `INSERT INTO runtime_event_outbox(
           event_id, type, run_id, node_run_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.eventType,
        input.runId ?? null,
        input.nodeRunId ?? null,
        JSON.stringify({
          sessionId: input.sessionId,
          ...(input.payload as object),
        }),
        input.createdAt,
      );
  };

  const readSession = (sessionId: string): InteractionSessionView => {
    const row = database
      .prepare(
        `SELECT id, mode, project_id AS projectId, run_id AS runId,
                node_run_id AS nodeRunId, status, created_at AS createdAt,
                closed_at AS closedAt
           FROM interaction_sessions WHERE id = ?`,
      )
      .get(sessionId) as InteractionSessionView | undefined;
    if (!row) {
      throw new RuntimeInteractionError(
        "INTERACTION_SESSION_NOT_FOUND",
        `Interaction Session ${sessionId} was not found.`,
      );
    }
    return row;
  };

  const readTurn = (turnId: string): InteractionTurnView => {
    const row = database
      .prepare(
        `SELECT id, session_id AS sessionId,
                input_message_id AS inputMessageId,
                output_message_id AS outputMessageId,
                status, command_id AS commandId,
                execution_operation_key AS executionOperationKey,
                execution_lease_id AS executionLeaseId,
                execution_epoch AS executionEpoch,
                fence_token AS fenceToken,
                mechanism, mechanism_version AS mechanismVersion,
                context_hash AS contextHash,
                context_schema_hash AS contextSchemaHash,
                terminal_execution_fact_id AS terminalExecutionFactId,
                provider_execution_ref AS providerExecutionRef,
                failure_code AS failureCode,
                failure_message AS failureMessage,
                created_at AS createdAt, started_at AS startedAt,
                completed_at AS completedAt
           FROM interaction_turns WHERE id = ?`,
      )
      .get(turnId) as InteractionTurnView | undefined;
    if (!row) {
      throw new RuntimeInteractionError(
        "INTERACTION_TURN_NOT_FOUND",
        `Interaction Turn ${turnId} was not found.`,
      );
    }
    return row;
  };

  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  };

  const canonicalJson = (value: unknown): string =>
    JSON.stringify(canonicalize(value));

  const sha256 = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

  const redact = (value: string): string =>
    value
      .replace(
        /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[REDACTED]",
      )
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");

  const appendInteractionEvent = (input: {
    readonly type: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly projectId: string;
    readonly payload: unknown;
    readonly timestamp: string;
    readonly commandId?: string;
  }): string | undefined => {
    const event = options.events?.append({
      type: input.type,
      scope: {
        companyId: "company",
        projectId: input.projectId,
        sessionId: input.sessionId,
        interactionTurnId: input.turnId,
        ...(input.commandId ? { commandId: input.commandId } : {}),
      },
      payload: input.payload,
      timestamp: input.timestamp,
    });
    return event?.eventId;
  };

  const turnContext = (input: {
    readonly session: InteractionSessionView;
    readonly inputMessageId: string;
    readonly aiParticipantId: string;
    readonly prompt: string;
  }): {
    readonly context: ModelOnlyInteractionContext;
    readonly model: string;
    readonly timeoutSeconds: number;
    readonly agentAdapterId: string;
  } => {
    const project = database
      .prepare(
        `SELECT id, name, goal, shared_context AS sharedContext
           FROM projects WHERE id = ?`,
      )
      .get(input.session.projectId) as
      | {
          readonly id: string;
          readonly name: string;
          readonly goal: string;
          readonly sharedContext: string;
        }
      | undefined;
    const ai = database
      .prepare(
        `SELECT ai_members.id AS aiMemberId,
                ai_members.display_name AS displayName,
                ai_members.profile AS profile,
                positions.id AS positionId,
                positions.name AS positionName,
                positions.responsibility AS responsibility,
                departments.default_execution_profile_id AS profileId,
                execution_profiles.provider_ref AS providerRef,
                execution_profiles.model AS model,
                execution_profiles.timeout_seconds AS timeoutSeconds
           FROM session_participants
           JOIN ai_members ON ai_members.id = session_participants.participant_ref
           JOIN positions ON positions.ai_member_id = ai_members.id
           JOIN departments ON departments.id = positions.department_id
           LEFT JOIN execution_profiles
             ON execution_profiles.id = departments.default_execution_profile_id
          WHERE session_participants.id = ?
            AND session_participants.session_id = ?
            AND session_participants.participant_type = 'ai-member'
            AND ai_members.status = 'active'`,
      )
      .get(input.aiParticipantId, input.session.id) as
      | {
          readonly aiMemberId: string;
          readonly displayName: string;
          readonly profile: string;
          readonly positionId: string;
          readonly positionName: string;
          readonly responsibility: string;
          readonly profileId: string | null;
          readonly providerRef: string | null;
          readonly model: string | null;
          readonly timeoutSeconds: number | null;
        }
      | undefined;
    if (!project || !ai || !ai.profileId || !ai.model || !ai.providerRef) {
      throw new RuntimeInteractionError(
        "INTERACTION_CONFIGURATION_INVALID",
        "Consultation requires an active AI Member Position and Execution Profile.",
      );
    }
    const history = database
      .prepare(
        `SELECT session_messages.content AS content,
                session_participants.participant_type AS participantType
           FROM session_messages
           JOIN session_participants
             ON session_participants.id = session_messages.participant_id
          WHERE session_messages.session_id = ?
            AND session_messages.id <> ?
            AND session_messages.kind = 'text'
            AND session_participants.participant_type IN ('human', 'ai-member')
       ORDER BY session_messages.created_at, session_messages.id`,
      )
      .all(input.session.id, input.inputMessageId) as Array<{
      readonly content: string;
      readonly participantType: "human" | "ai-member";
    }>;
    const contextWithoutHash = {
      schemaVersion: 1 as const,
      schemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
      mechanism: "model-only" as const,
      mechanismVersion: "1",
      session: { id: input.session.id, mode: "consultation" as const },
      project: {
        id: project.id,
        name: redact(project.name),
        goal: redact(project.goal),
        sharedContext: redact(project.sharedContext),
      },
      aiMember: {
        id: ai.aiMemberId,
        displayName: redact(ai.displayName),
        profile: redact(ai.profile),
      },
      position: {
        id: ai.positionId,
        name: redact(ai.positionName),
        responsibility: redact(ai.responsibility),
      },
      history: history.map((message) => ({
        role:
          message.participantType === "human"
            ? ("user" as const)
            : ("assistant" as const),
        content: redact(message.content),
      })),
      prompt: redact(input.prompt),
    };
    const contextHash = sha256(canonicalJson(contextWithoutHash));
    return {
      context: { ...contextWithoutHash, contextHash },
      model: ai.model,
      timeoutSeconds: ai.timeoutSeconds ?? 60,
      agentAdapterId: ai.providerRef,
    };
  };

  const readParticipant = (participantId: string): SessionParticipantView => {
    const row = database
      .prepare(
        `SELECT id, session_id AS sessionId,
                participant_type AS participantType,
                participant_ref AS participantRef, role,
                created_at AS createdAt
           FROM session_participants WHERE id = ?`,
      )
      .get(participantId) as SessionParticipantView | undefined;
    if (!row) {
      throw new RuntimeInteractionError(
        "SESSION_PARTICIPANT_NOT_FOUND",
        `Session Participant ${participantId} was not found.`,
      );
    }
    return row;
  };

  const requireActiveSession = (
    session: InteractionSessionView,
  ): InteractionSessionView => {
    if (session.status !== "active") {
      throw new RuntimeInteractionError(
        "INTERACTION_SESSION_STATE_INVALID",
        `Interaction Session ${session.id} is not active.`,
      );
    }
    return session;
  };

  const exactPermissionScope = (input: string): string => {
    const scope = input.trim();
    if (
      !scope ||
      scope === "*" ||
      scope.endsWith(".*") ||
      /[\s,]/.test(scope)
    ) {
      throw new RuntimeInteractionError(
        "PERMISSION_SCOPE_INVALID",
        "Permission scope must identify one exact capability.",
      );
    }
    return scope;
  };

  const readPermission = (permissionId: string): PermissionRequestView => {
    const row = database
      .prepare(
        `SELECT permission_requests.id,
                permission_requests.session_id AS sessionId,
                permission_requests.run_id AS runId,
                permission_requests.node_run_id AS nodeRunId,
                permission_requests.scope,
                permission_requests.status,
                expires_at AS expiresAt,
                permission_requests.created_at AS createdAt,
                decided_at AS decidedAt,
                permission_decisions.actor_type AS decisionActorType,
                permission_decisions.actor_id AS decisionActorId,
                permission_decisions.authenticated_by AS decisionActorAuthenticatedBy,
                permission_decisions.command_id AS decisionCommandId
           FROM permission_requests
           LEFT JOIN permission_decisions
             ON permission_decisions.permission_request_id = permission_requests.id
          WHERE permission_requests.id = ?`,
      )
      .get(permissionId) as
      | (Omit<PermissionRequestView, "decisionActor"> & {
          readonly decisionActorType: ActorRef["type"] | null;
          readonly decisionActorId: string | null;
          readonly decisionActorAuthenticatedBy:
            | ActorRef["authenticatedBy"]
            | null;
        })
      | undefined;
    if (!row) {
      throw new RuntimeInteractionError(
        "PERMISSION_REQUEST_NOT_FOUND",
        `Permission Request ${permissionId} was not found.`,
      );
    }
    const {
      decisionActorType,
      decisionActorId,
      decisionActorAuthenticatedBy,
      ...permission
    } = row;
    return {
      ...permission,
      decisionActor:
        decisionActorType && decisionActorId && decisionActorAuthenticatedBy
          ? {
              type: decisionActorType,
              id: decisionActorId,
              authenticatedBy: decisionActorAuthenticatedBy,
            }
          : null,
    };
  };

  const createSession: RuntimeInteraction["createSession"] = (input) => {
    if (input.mode === "run-collaboration" && !input.runId) {
      throw new RuntimeInteractionError(
        "INTERACTION_SESSION_INVALID",
        "Run collaboration requires a Department Run.",
      );
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      const project = database
        .prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'")
        .get(input.projectId);
      if (!project) {
        throw new RuntimeInteractionError(
          "PROJECT_NOT_FOUND",
          `Active Project ${input.projectId} was not found.`,
        );
      }
      if (input.runId) {
        const run = database
          .prepare(
            "SELECT id FROM department_runs WHERE id = ? AND project_id = ?",
          )
          .get(input.runId, input.projectId);
        if (!run) {
          throw new RuntimeInteractionError(
            "RUN_NOT_FOUND",
            `Department Run ${input.runId} was not found in Project ${input.projectId}.`,
          );
        }
      }
      database
        .prepare(
          `INSERT INTO interaction_sessions(
             id, mode, project_id, run_id, node_run_id, status, created_at, closed_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .run(
          id,
          input.mode,
          input.projectId,
          input.runId ?? null,
          input.nodeRunId ?? null,
          now,
        );
      appendMutation({
        action: "interaction.session.create",
        entityType: "interaction-session",
        entityId: id,
        eventType: "session.created",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        sessionId: id,
        payload: { mode: input.mode, projectId: input.projectId },
        createdAt: now,
      });
      database.exec("COMMIT");
      return readSession(id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const addParticipant: RuntimeInteraction["addParticipant"] = (input) => {
    const session = requireActiveSession(readSession(input.sessionId));
    const now = new Date().toISOString();
    const id = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO session_participants(
             id, session_id, participant_type, participant_ref, role, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.participantType,
          input.participantRef,
          input.role,
          now,
        );
      appendMutation({
        action: "interaction.participant.add",
        entityType: "session-participant",
        entityId: id,
        eventType: "session.participant.added",
        runId: session.runId,
        nodeRunId: session.nodeRunId,
        sessionId: session.id,
        payload: { participantType: input.participantType, role: input.role },
        createdAt: now,
      });
      database.exec("COMMIT");
      return readParticipant(id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const closeSession: RuntimeInteraction["closeSession"] = (sessionId) => {
    const current = readSession(sessionId);
    if (current.status === "closed") return current;
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const closed = database
        .prepare(
          `UPDATE interaction_sessions
              SET status = 'closed', closed_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(now, sessionId);
      if (Number(closed.changes) !== 1) {
        throw new RuntimeInteractionError(
          "INTERACTION_SESSION_STATE_INVALID",
          `Interaction Session ${sessionId} is not active.`,
        );
      }
      appendMutation({
        action: "interaction.session.close",
        entityType: "interaction-session",
        entityId: sessionId,
        eventType: "session.closed",
        runId: current.runId,
        nodeRunId: current.nodeRunId,
        sessionId,
        payload: { status: "closed" },
        createdAt: now,
      });
      database.exec("COMMIT");
      return readSession(sessionId);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const addMessage: RuntimeInteraction["addMessage"] = (input) => {
    const session = requireActiveSession(readSession(input.sessionId));
    const participant = readParticipant(input.participantId);
    if (participant.sessionId !== session.id || !input.content.trim()) {
      throw new RuntimeInteractionError(
        "SESSION_MESSAGE_INVALID",
        "Session Message requires a participant in the same Session and non-empty content.",
      );
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO session_messages(
             id, session_id, participant_id, kind, content, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, session.id, participant.id, input.kind, input.content, now);
      appendMutation({
        action: "interaction.message.add",
        entityType: "session-message",
        entityId: id,
        eventType: "session.message.created",
        runId: session.runId,
        nodeRunId: session.nodeRunId,
        sessionId: session.id,
        payload: {
          messageId: id,
          participantId: participant.id,
          kind: input.kind,
          content: input.content,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
      return {
        id,
        sessionId: session.id,
        participantId: participant.id,
        kind: input.kind,
        content: input.content,
        createdAt: now,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const acceptPromptInTransaction: RuntimeInteraction["acceptPromptInTransaction"] =
    (input) => {
      const capability: ExecutionAdapterCapabilities | undefined =
        interactionAdapter?.capabilities;
      if (
        !capability ||
        capability.enforceNoSideEffects === false ||
        capability.enforceNoSideEffects.mechanism !== "model-only" ||
        capability.enforceNoSideEffects.policySchemaHash !==
          MODEL_ONLY_CONTEXT_SCHEMA_HASH
      ) {
        throw new RuntimeInteractionError(
          "CONSULTATION_ISOLATION_REQUIRED",
          "Consultation requires a trusted model-only Execution Adapter.",
        );
      }
      const session = requireActiveSession(readSession(input.sessionId));
      if (session.mode !== "consultation") {
        throw new RuntimeInteractionError(
          "INTERACTION_MODE_INVALID",
          "Model-only prompt Turns require a consultation Interaction Session.",
        );
      }
      const human = readParticipant(input.participantId);
      if (
        human.sessionId !== session.id ||
        human.participantType !== "human" ||
        human.participantRef !== input.actor.id
      ) {
        throw new RuntimeInteractionError(
          "SESSION_MESSAGE_INVALID",
          "Interaction Prompt requires the authenticated human participant.",
        );
      }
      const ai = database
        .prepare(
          `SELECT id FROM session_participants
          WHERE session_id = ? AND participant_type = 'ai-member'
       ORDER BY created_at, id LIMIT 1`,
        )
        .get(session.id) as { readonly id: string } | undefined;
      if (!ai) {
        throw new RuntimeInteractionError(
          "SESSION_PARTICIPANT_NOT_FOUND",
          `Interaction Session ${session.id} has no AI Member participant.`,
        );
      }
      const activeTurn = database
        .prepare(
          `SELECT id FROM interaction_turns
          WHERE session_id = ?
            AND status IN ('queued', 'running', 'reconciling')
          LIMIT 1`,
        )
        .get(session.id) as { readonly id: string } | undefined;
      if (activeTurn) {
        throw new RuntimeInteractionError(
          "INTERACTION_TURN_IN_PROGRESS",
          `Interaction Session ${session.id} already has active Turn ${activeTurn.id}.`,
        );
      }
      const now = clock().toISOString();
      const turnId = randomUUID();
      const prompt = redact(input.content.trim());
      const inputMessageId = randomUUID();
      database
        .prepare(
          `INSERT INTO session_messages(
           id, session_id, participant_id, kind, content, created_at
         ) VALUES (?, ?, ?, 'text', ?, ?)`,
        )
        .run(inputMessageId, session.id, human.id, prompt, now);
      const contextResult = turnContext({
        session,
        inputMessageId,
        aiParticipantId: ai.id,
        prompt,
      });
      database
        .prepare(
          `INSERT INTO interaction_turns(
           id, session_id, human_participant_id, ai_participant_id,
           input_message_id, output_message_id, status, command_id,
           execution_operation_key, execution_lease_id, execution_epoch,
           fence_token, agent_adapter_id, model, timeout_seconds, mechanism,
           mechanism_version, context_json, context_hash, context_schema_hash,
           terminal_execution_fact_id, provider_execution_ref, failure_code,
           failure_message, created_at, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL,
                   ?, ?, ?, 'model-only', ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                   ?, NULL, NULL)`,
        )
        .run(
          turnId,
          session.id,
          human.id,
          ai.id,
          inputMessageId,
          input.commandId,
          `interaction-turn:${turnId}`,
          contextResult.agentAdapterId,
          contextResult.model,
          contextResult.timeoutSeconds,
          contextResult.context.mechanismVersion,
          JSON.stringify(contextResult.context),
          contextResult.context.contextHash,
          contextResult.context.schemaHash,
          now,
        );
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by
         ) VALUES (?, 'interaction.turn.accept', 'interaction-turn', ?, NULL,
                   NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          turnId,
          JSON.stringify({
            status: "queued",
            executionOperationKey: `interaction-turn:${turnId}`,
            contextHash: contextResult.context.contextHash,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      return readTurn(turnId);
    };

  const forbiddenFactKinds = new Set<AdapterExecutionFact["kind"]>([
    "tool-call",
    "tool-result",
    "permission-request",
    "artifact",
    "commit",
  ]);

  const effectBearingKeys = new Set([
    "artifact",
    "artifactId",
    "commit",
    "commitSha",
    "cwd",
    "filesystem",
    "permission",
    "tool",
    "toolCall",
    "toolResult",
    "worktree",
    "sandbox",
  ]);

  const containsEffectBearingPayload = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsEffectBearingPayload);
    if (value === null || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, entry]) =>
        effectBearingKeys.has(key) || containsEffectBearingPayload(entry),
    );
  };

  const markTurnFailure = (input: {
    readonly turnId: string;
    readonly code: string;
    readonly message: string;
    readonly status?: "failed" | "cancelled" | "interrupted" | "reconciling";
  }): InteractionTurnView => {
    const current = readTurn(input.turnId);
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "interrupted"
    ) {
      return current;
    }
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const nextStatus = input.status ?? "failed";
      database
        .prepare(
          `UPDATE interaction_turns
              SET status = ?, failure_code = ?, failure_message = ?,
                  completed_at = CASE WHEN ? IN ('failed', 'cancelled', 'interrupted')
                                      THEN ? ELSE completed_at END
            WHERE id = ? AND status IN ('queued', 'running', 'reconciling')`,
        )
        .run(
          nextStatus,
          input.code,
          input.message,
          nextStatus,
          now,
          input.turnId,
        );
      database
        .prepare(
          `UPDATE execution_leases SET released_at = ?
            WHERE target_kind = 'interaction-turn' AND target_id = ?
              AND released_at IS NULL`,
        )
        .run(now, input.turnId);
      const session = readSession(current.sessionId);
      appendInteractionEvent({
        type: `interaction.turn.${nextStatus}`,
        sessionId: current.sessionId,
        turnId: current.id,
        projectId: session.projectId,
        payload: {
          status: nextStatus,
          operationKey: current.executionOperationKey,
          failureCode: input.code,
        },
        timestamp: now,
      });
      database.exec("COMMIT");
      return readTurn(input.turnId);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const executeTurn: RuntimeInteraction["executeTurn"] = async (turnId) => {
    const queued = readTurn(turnId);
    if (queued.status !== "queued") return queued;
    if (!interactionAdapter) {
      return markTurnFailure({
        turnId,
        code: "CONSULTATION_ISOLATION_REQUIRED",
        message:
          "Consultation requires a trusted model-only Execution Adapter.",
      });
    }
    const session = readSession(queued.sessionId);
    const turnConfiguration = database
      .prepare(
        `SELECT timeout_seconds AS timeoutSeconds,
                agent_adapter_id AS agentAdapterId, model
           FROM interaction_turns WHERE id = ?`,
      )
      .get(turnId) as
      | {
          readonly timeoutSeconds: number;
          readonly agentAdapterId: string;
          readonly model: string;
        }
      | undefined;
    const timeoutSeconds = turnConfiguration?.timeoutSeconds ?? 60;
    const context = JSON.parse(
      String(
        database
          .prepare(
            "SELECT context_json AS contextJson FROM interaction_turns WHERE id = ?",
          )
          .get(turnId)?.contextJson,
      ),
    ) as ModelOnlyInteractionContext;
    const now = clock();
    const nowIso = now.toISOString();
    const leaseId = randomUUID();
    const fenceToken = `interaction-fence:${randomUUID()}`;
    const target = { kind: "interaction-turn" as const, id: turnId };
    const lease: ExecutionLeaseContext & { readonly target: typeof target } = {
      leaseId,
      leaseKind: "execution",
      operationKey: queued.executionOperationKey,
      target,
      executionEpoch: 1,
      fenceToken,
    };
    database.exec("BEGIN IMMEDIATE");
    try {
      const claimed = database
        .prepare(
          `UPDATE interaction_turns
              SET status = 'running', execution_lease_id = ?,
                  execution_epoch = ?, fence_token = ?, started_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .run(leaseId, lease.executionEpoch, fenceToken, nowIso, turnId);
      if (Number(claimed.changes) !== 1) {
        database.exec("COMMIT");
        return readTurn(turnId);
      }
      database
        .prepare(
          `INSERT INTO execution_leases(
             id, target_kind, target_id, lease_kind, operation_key,
             execution_epoch, fence_token, worker_id, issued_at, expires_at,
             renewed_at, released_at, cancel_requested
           ) VALUES (?, 'interaction-turn', ?, 'execution', ?, ?, ?,
                     'interaction-runtime', ?, ?, NULL, NULL, 0)`,
        )
        .run(
          leaseId,
          turnId,
          queued.executionOperationKey,
          lease.executionEpoch,
          fenceToken,
          nowIso,
          new Date(now.getTime() + timeoutSeconds * 1_000).toISOString(),
        );
      appendInteractionEvent({
        type: "interaction.turn.started",
        sessionId: session.id,
        turnId,
        projectId: session.projectId,
        commandId: queued.commandId,
        payload: {
          status: "running",
          operationKey: queued.executionOperationKey,
          executionLeaseId: leaseId,
          executionEpoch: 1,
          mechanism: "model-only",
          mechanismVersion: queued.mechanismVersion,
          contextHash: queued.contextHash,
          contextSchemaHash: queued.contextSchemaHash,
        },
        timestamp: nowIso,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const baseSink = createExecutionFactSink({
      database,
      lease,
      target: lease.target,
      now: clock,
      applyAcceptedFact: ({ fact, envelope, now: factNow }) => {
        if (
          forbiddenFactKinds.has(fact.kind) ||
          containsEffectBearingPayload(fact.payload)
        ) {
          throw new ExecutionFactError(
            "EXECUTION_ADAPTER_PROTOCOL",
            `Fact kind ${fact.kind} is forbidden for model-only consultation Turns.`,
          );
        }
        const effects: string[] = [];
        if (fact.kind === "provider-started") {
          const providerExecutionRef =
            typeof fact.payload === "object" &&
            fact.payload !== null &&
            "providerExecutionRef" in fact.payload &&
            typeof fact.payload.providerExecutionRef === "string"
              ? fact.payload.providerExecutionRef
              : undefined;
          if (providerExecutionRef) {
            database
              .prepare(
                "UPDATE interaction_turns SET provider_execution_ref = ? WHERE id = ? AND status = 'running'",
              )
              .run(providerExecutionRef, turnId);
          }
        }
        if (fact.kind === "message") {
          const content =
            typeof fact.payload === "object" &&
            fact.payload !== null &&
            "content" in fact.payload &&
            typeof fact.payload.content === "string"
              ? redact(fact.payload.content)
              : "";
          if (!content) {
            throw new ExecutionFactError(
              "EXECUTION_ADAPTER_PROTOCOL",
              "Model-only message Fact must contain non-empty content.",
            );
          }
          const messageId = randomUUID();
          database
            .prepare(
              `INSERT INTO session_messages(
                 id, session_id, participant_id, kind, content, created_at
               ) SELECT ?, session_id, ai_participant_id, 'text', ?, ?
                   FROM interaction_turns WHERE id = ?`,
            )
            .run(messageId, content, factNow, turnId);
          database
            .prepare(
              "UPDATE interaction_turns SET output_message_id = ? WHERE id = ? AND status = 'running'",
            )
            .run(messageId, turnId);
          const eventId = appendInteractionEvent({
            type: "message.delta",
            sessionId: session.id,
            turnId,
            projectId: session.projectId,
            payload: { messageId, content },
            timestamp: factNow,
          });
          if (eventId) effects.push(eventId, messageId);
        }
        if (fact.kind === "usage") {
          const payload = fact.payload as {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly totalTokens?: number;
          };
          const eventId = appendInteractionEvent({
            type: "usage.recorded",
            sessionId: session.id,
            turnId,
            projectId: session.projectId,
            payload: {
              inputTokens: payload.inputTokens ?? 0,
              outputTokens: payload.outputTokens ?? 0,
              totalTokens: payload.totalTokens ?? 0,
            },
            timestamp: factNow,
          });
          if (eventId) effects.push(eventId);
        }
        if (["completed", "failed", "cancelled"].includes(fact.kind)) {
          const status =
            fact.kind === "completed"
              ? "completed"
              : fact.kind === "failed"
                ? "failed"
                : "cancelled";
          const payload = fact.payload as {
            readonly code?: string;
            readonly message?: string;
          };
          database
            .prepare(
              `UPDATE interaction_turns
                  SET status = ?, terminal_execution_fact_id = ?,
                      failure_code = ?, failure_message = ?, completed_at = ?
                WHERE id = ? AND status IN ('running', 'reconciling')`,
            )
            .run(
              status,
              envelope.id,
              status === "failed" ? (payload.code ?? "MODEL_FAILED") : null,
              status === "failed"
                ? (payload.message ?? "Model execution failed.")
                : null,
              factNow,
              turnId,
            );
          database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(factNow, leaseId);
          const eventId = appendInteractionEvent({
            type: `interaction.turn.${status}`,
            sessionId: session.id,
            turnId,
            projectId: session.projectId,
            payload: {
              status,
              operationKey: queued.executionOperationKey,
              terminalExecutionFactId: envelope.id,
              ...(status === "failed"
                ? { failureCode: payload.code ?? "MODEL_FAILED" }
                : {}),
            },
            timestamp: factNow,
          });
          if (eventId) effects.push(eventId);
        }
        return effects;
      },
    });
    const sink: ExecutionEventSink = {
      record: async (fact) => {
        if (
          forbiddenFactKinds.has(fact.kind) ||
          containsEffectBearingPayload(fact.payload)
        ) {
          throw new RuntimeInteractionError(
            "EXECUTION_ADAPTER_PROTOCOL",
            `Fact kind ${fact.kind} is forbidden for model-only consultation Turns.`,
          );
        }
        return baseSink.record(fact);
      },
    };
    const request: InteractionExecutionRequest = {
      operationKey: queued.executionOperationKey,
      target: lease.target,
      lease,
      agentAdapterId: turnConfiguration?.agentAdapterId ?? "unknown",
      model: turnConfiguration?.model ?? "default",
      permissionScope: "none",
      sideEffectPolicy: "none",
      completionSignal: "execution-fact",
      timeoutSeconds,
      immutableContext: context,
    };
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    activeTurns.set(turnId, { controller, done });
    try {
      const timeout = setTimeout(
        () => controller.abort(),
        timeoutSeconds * 1_000,
      );
      timeout.unref?.();
      const completion = await interactionAdapter.execute(
        request,
        sink,
        controller.signal,
      );
      clearTimeout(timeout);
      const execution = inspectExecution(database, {
        operationKey: queued.executionOperationKey,
      });
      const terminal = execution.facts.find(
        (fact) =>
          fact.status === "accepted" &&
          ["completed", "failed", "cancelled"].includes(fact.kind),
      );
      if (!terminal || completion.terminalExecutionFactId !== terminal.id) {
        return markTurnFailure({
          turnId,
          code: "EXECUTION_ADAPTER_PROTOCOL",
          message:
            "Interaction Adapter did not reference an accepted terminal Fact.",
        });
      }
      return readTurn(turnId);
    } catch (error) {
      const code =
        error instanceof RuntimeInteractionError
          ? error.code
          : error instanceof ExecutionFactError
            ? error.code
            : "MODEL_TRANSPORT_FAILED";
      return markTurnFailure({
        turnId,
        code,
        message:
          code === "EXECUTION_ADAPTER_PROTOCOL"
            ? "The model-only Adapter submitted a forbidden or invalid Fact."
            : "The trusted Model Transport failed without exposing provider output.",
      });
    } finally {
      activeTurns.delete(turnId);
      resolveDone();
    }
  };

  const requestTurnCancellationInTransaction: RuntimeInteraction["requestTurnCancellationInTransaction"] =
    (input) => {
      const turn = readTurn(input.turnId);
      if (turn.sessionId !== input.sessionId) {
        throw new RuntimeInteractionError(
          "INTERACTION_TURN_NOT_FOUND",
          `Interaction Turn ${input.turnId} was not found in Session ${input.sessionId}.`,
        );
      }
      const actorIsVerified =
        (input.actor.type === "human" &&
          input.actor.authenticatedBy === "local-session") ||
        (input.actor.type === "acp-client" &&
          input.actor.authenticatedBy === "acp-connection");
      if (!actorIsVerified) {
        throw new RuntimeInteractionError(
          "INTERACTION_CANCEL_ACTOR_INVALID",
          "Turn cancellation requires a verified Human or ACP Client actor.",
        );
      }
      const participant = database
        .prepare(
          `SELECT id FROM session_participants
            WHERE session_id = ? AND participant_type = 'human'
              AND participant_ref = ? LIMIT 1`,
        )
        .get(input.sessionId, input.actor.id);
      if (!participant) {
        throw new RuntimeInteractionError(
          "INTERACTION_TURN_NOT_FOUND",
          `Interaction Turn ${input.turnId} was not found in Session ${input.sessionId}.`,
        );
      }
      if (
        turn.status === "completed" ||
        turn.status === "failed" ||
        turn.status === "cancelled" ||
        turn.status === "interrupted"
      ) {
        return turn;
      }
      return requestInteractionTurnCancellationInTransaction(turn.id);
    };

  const cancelTurn: RuntimeInteraction["cancelTurn"] = async (turnId) => {
    await dispatchInteractionTurnCancellation(turnId);
    return readTurn(turnId);
  };

  const reconcilePendingTurns: RuntimeInteraction["reconcilePendingTurns"] =
    async () => {
      if (!interactionAdapter?.reconcile) return 0;
      const candidates = database
        .prepare(
          `SELECT id, session_id AS sessionId,
                  execution_operation_key AS operationKey,
                  agent_adapter_id AS agentAdapterId, model,
                  timeout_seconds AS timeoutSeconds, context_json AS contextJson
             FROM interaction_turns
            WHERE status = 'reconciling'
              AND NOT EXISTS (
                SELECT 1 FROM execution_leases
                 WHERE target_kind = 'interaction-turn'
                   AND target_id = interaction_turns.id
                   AND released_at IS NULL
              )
         ORDER BY created_at, id`,
        )
        .all() as Array<{
        readonly id: string;
        readonly sessionId: string;
        readonly operationKey: string;
        readonly agentAdapterId: string;
        readonly model: string;
        readonly timeoutSeconds: number;
        readonly contextJson: string;
      }>;
      let reconciled = 0;
      for (const candidate of candidates) {
        const session = readSession(candidate.sessionId);
        const issuedAt = clock();
        const issuedAtIso = issuedAt.toISOString();
        const reconciliationLeaseId = randomUUID();
        const reconciliationEpoch =
          Number(
            (
              database
                .prepare(
                  `SELECT COALESCE(MAX(execution_epoch), 0) AS executionEpoch
                     FROM execution_leases WHERE operation_key = ?`,
                )
                .get(candidate.operationKey) as {
                readonly executionEpoch: number;
              }
            ).executionEpoch,
          ) + 1;
        const target = {
          kind: "interaction-turn" as const,
          id: candidate.id,
        };
        const reconciliationLease: ExecutionLeaseContext & {
          readonly target: typeof target;
          readonly leaseKind: "reconciliation";
        } = {
          leaseId: reconciliationLeaseId,
          leaseKind: "reconciliation",
          operationKey: candidate.operationKey,
          target,
          executionEpoch: reconciliationEpoch,
          fenceToken: `interaction-fence:${randomUUID()}`,
        };
        const reconciliationExpiresAt = new Date(
          issuedAt.getTime() + candidate.timeoutSeconds * 1_000,
        ).toISOString();
        database.exec("BEGIN IMMEDIATE");
        try {
          const claimed = database
            .prepare(
              `UPDATE interaction_turns
                  SET execution_lease_id = ?, execution_epoch = ?,
                      fence_token = ?
                WHERE id = ? AND status = 'reconciling'
                  AND NOT EXISTS (
                    SELECT 1 FROM execution_leases
                     WHERE target_kind = 'interaction-turn' AND target_id = ?
                       AND released_at IS NULL
                  )`,
            )
            .run(
              reconciliationLeaseId,
              reconciliationEpoch,
              reconciliationLease.fenceToken,
              candidate.id,
              candidate.id,
            );
          if (claimed.changes !== 1) {
            database.exec("COMMIT");
            continue;
          }
          database
            .prepare(
              `INSERT INTO execution_leases(
                 id, target_kind, target_id, lease_kind, operation_key,
                 execution_epoch, fence_token, worker_id, issued_at, expires_at,
                 renewed_at, released_at, cancel_requested
               ) VALUES (?, 'interaction-turn', ?, 'reconciliation', ?, ?, ?,
                         'interaction-reconciliation', ?, ?, NULL, NULL, 0)`,
            )
            .run(
              reconciliationLeaseId,
              candidate.id,
              candidate.operationKey,
              reconciliationEpoch,
              reconciliationLease.fenceToken,
              issuedAtIso,
              reconciliationExpiresAt,
            );
          appendInteractionEvent({
            type: "interaction.turn.reconciling",
            sessionId: candidate.sessionId,
            turnId: candidate.id,
            projectId: session.projectId,
            payload: {
              status: "reconciling",
              operationKey: candidate.operationKey,
              executionLeaseId: reconciliationLeaseId,
              executionEpoch: reconciliationEpoch,
            },
            timestamp: issuedAtIso,
          });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }

        const createTurnSink = (
          activeLease: ExecutionLeaseContext,
          expectedStatus: "reconciling" | "running",
        ): ExecutionEventSink => {
          const baseSink = createExecutionFactSink({
            database,
            lease: activeLease,
            target,
            now: clock,
            applyAcceptedFact: ({ fact, envelope, now }) => {
              if (
                forbiddenFactKinds.has(fact.kind) ||
                containsEffectBearingPayload(fact.payload)
              ) {
                throw new ExecutionFactError(
                  "EXECUTION_ADAPTER_PROTOCOL",
                  `Fact kind ${fact.kind} is forbidden for model-only consultation Turns.`,
                );
              }
              if (fact.kind === "provider-started") {
                const providerExecutionRef =
                  typeof fact.payload === "object" &&
                  fact.payload !== null &&
                  "providerExecutionRef" in fact.payload &&
                  typeof fact.payload.providerExecutionRef === "string"
                    ? fact.payload.providerExecutionRef
                    : undefined;
                if (providerExecutionRef) {
                  database
                    .prepare(
                      "UPDATE interaction_turns SET provider_execution_ref = ? WHERE id = ? AND status = ?",
                    )
                    .run(providerExecutionRef, candidate.id, expectedStatus);
                }
                return [];
              }
              if (
                fact.kind !== "not-started" &&
                fact.kind !== "completed" &&
                fact.kind !== "failed" &&
                fact.kind !== "cancelled"
              ) {
                return [];
              }
              const status =
                fact.kind === "not-started"
                  ? "interrupted"
                  : fact.kind === "completed"
                    ? "completed"
                    : fact.kind;
              const payload =
                typeof fact.payload === "object" && fact.payload !== null
                  ? (fact.payload as Record<string, unknown>)
                  : {};
              const failureCode =
                status === "completed"
                  ? null
                  : typeof payload.code === "string"
                    ? payload.code
                    : status === "interrupted"
                      ? "EXECUTION_NOT_STARTED"
                      : status === "cancelled"
                        ? "MODEL_CANCELLED"
                        : "MODEL_FAILED";
              const failureMessage =
                status === "completed"
                  ? null
                  : typeof payload.message === "string"
                    ? payload.message
                    : status === "interrupted"
                      ? "Provider evidence proves the consultation never started."
                      : status === "cancelled"
                        ? "Model execution was cancelled."
                        : "Model execution failed.";
              const updated = database
                .prepare(
                  `UPDATE interaction_turns
                      SET status = ?, terminal_execution_fact_id = ?,
                          failure_code = ?, failure_message = ?, completed_at = ?
                    WHERE id = ? AND status = ? AND execution_lease_id = ?`,
                )
                .run(
                  status,
                  envelope.id,
                  failureCode,
                  failureMessage,
                  now,
                  candidate.id,
                  expectedStatus,
                  activeLease.leaseId,
                );
              if (updated.changes !== 1) {
                throw new RuntimeInteractionError(
                  "EXECUTION_TERMINAL_CONFLICT",
                  `Interaction Turn ${candidate.id} cannot accept another terminal Fact.`,
                );
              }
              database
                .prepare(
                  "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
                )
                .run(now, activeLease.leaseId);
              const eventId = appendInteractionEvent({
                type: `interaction.turn.${status}`,
                sessionId: candidate.sessionId,
                turnId: candidate.id,
                projectId: session.projectId,
                payload: {
                  status,
                  operationKey: candidate.operationKey,
                  terminalExecutionFactId: envelope.id,
                  ...(failureCode ? { failureCode } : {}),
                },
                timestamp: now,
              });
              return eventId ? [eventId] : [];
            },
          });
          return {
            record: async (fact) => {
              if (
                forbiddenFactKinds.has(fact.kind) ||
                containsEffectBearingPayload(fact.payload)
              ) {
                throw new RuntimeInteractionError(
                  "EXECUTION_ADAPTER_PROTOCOL",
                  `Fact kind ${fact.kind} is forbidden for model-only consultation Turns.`,
                );
              }
              return baseSink.record(fact);
            },
          };
        };

        const releaseLease = (leaseId: string): void => {
          database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(clock().toISOString(), leaseId);
        };
        try {
          const result = await interactionAdapter.reconcile(
            {
              operationKey: candidate.operationKey,
              reconciliationLease,
            },
            createTurnSink(reconciliationLease, "reconciling"),
          );
          if (result.status === "unknown") {
            releaseLease(reconciliationLeaseId);
          } else if (result.status === "running") {
            if (
              interactionAdapter.capabilities.reattachRunningOperation !==
                true ||
              !interactionAdapter.reattach
            ) {
              releaseLease(reconciliationLeaseId);
            } else {
              const reattachNow = clock();
              const reattachNowIso = reattachNow.toISOString();
              const executionLeaseId = randomUUID();
              const executionLease: ExecutionLeaseContext & {
                readonly target: typeof target;
                readonly leaseKind: "execution";
              } = {
                leaseId: executionLeaseId,
                leaseKind: "execution",
                operationKey: candidate.operationKey,
                target,
                executionEpoch: reconciliationEpoch + 1,
                fenceToken: `interaction-fence:${randomUUID()}`,
              };
              database.exec("BEGIN IMMEDIATE");
              try {
                releaseLease(reconciliationLeaseId);
                const resumed = database
                  .prepare(
                    `UPDATE interaction_turns
                        SET status = 'running', execution_lease_id = ?,
                            execution_epoch = ?, fence_token = ?,
                            provider_execution_ref = ?, failure_code = NULL,
                            failure_message = NULL
                      WHERE id = ? AND status = 'reconciling'`,
                  )
                  .run(
                    executionLeaseId,
                    executionLease.executionEpoch,
                    executionLease.fenceToken,
                    result.providerExecutionRef,
                    candidate.id,
                  );
                if (resumed.changes !== 1) {
                  throw new RuntimeInteractionError(
                    "EXECUTION_LEASE_CONFLICT",
                    `Interaction Turn ${candidate.id} changed before reattachment.`,
                  );
                }
                database
                  .prepare(
                    `INSERT INTO execution_leases(
                       id, target_kind, target_id, lease_kind, operation_key,
                       execution_epoch, fence_token, worker_id, issued_at,
                       expires_at, renewed_at, released_at, cancel_requested
                     ) VALUES (?, 'interaction-turn', ?, 'execution', ?, ?, ?,
                               'interaction-reattach', ?, ?, NULL, NULL, 0)`,
                  )
                  .run(
                    executionLeaseId,
                    candidate.id,
                    candidate.operationKey,
                    executionLease.executionEpoch,
                    executionLease.fenceToken,
                    reattachNowIso,
                    new Date(
                      reattachNow.getTime() + candidate.timeoutSeconds * 1_000,
                    ).toISOString(),
                  );
                appendInteractionEvent({
                  type: "interaction.turn.started",
                  sessionId: candidate.sessionId,
                  turnId: candidate.id,
                  projectId: session.projectId,
                  payload: {
                    status: "running",
                    operationKey: candidate.operationKey,
                    executionLeaseId,
                    executionEpoch: executionLease.executionEpoch,
                    providerExecutionRef: result.providerExecutionRef,
                    reattached: true,
                  },
                  timestamp: reattachNowIso,
                });
                database.exec("COMMIT");
              } catch (error) {
                database.exec("ROLLBACK");
                throw error;
              }
              const context = JSON.parse(
                candidate.contextJson,
              ) as ModelOnlyInteractionContext;
              const request: InteractionExecutionRequest = {
                operationKey: candidate.operationKey,
                target,
                lease: executionLease,
                agentAdapterId: candidate.agentAdapterId,
                model: candidate.model,
                permissionScope: "none",
                sideEffectPolicy: "none",
                completionSignal: "execution-fact",
                timeoutSeconds: candidate.timeoutSeconds,
                immutableContext: context,
              };
              const controller = new AbortController();
              const completion = await interactionAdapter.reattach(
                request,
                result.providerExecutionRef,
                createTurnSink(executionLease, "running"),
                controller.signal,
              );
              const accepted = database
                .prepare(
                  `SELECT kind FROM execution_facts
                    WHERE id = ? AND operation_key = ? AND lease_id = ?
                      AND execution_epoch = ? AND status = 'accepted'`,
                )
                .get(
                  completion.terminalExecutionFactId,
                  candidate.operationKey,
                  executionLeaseId,
                  executionLease.executionEpoch,
                ) as { readonly kind: string } | undefined;
              const expectedKind =
                completion.status === "succeeded"
                  ? "completed"
                  : completion.status;
              if (!accepted || accepted.kind !== expectedKind) {
                throw new RuntimeInteractionError(
                  "EXECUTION_ADAPTER_PROTOCOL",
                  `Interaction reattachment did not reference its accepted ${expectedKind} Fact.`,
                );
              }
            }
          } else {
            const accepted = database
              .prepare(
                `SELECT kind FROM execution_facts
                  WHERE id = ? AND operation_key = ? AND lease_id = ?
                    AND execution_epoch = ? AND status = 'accepted'`,
              )
              .get(
                result.terminalExecutionFactId,
                candidate.operationKey,
                reconciliationLeaseId,
                reconciliationEpoch,
              ) as { readonly kind: string } | undefined;
            const expectedKind =
              result.status === "not-started"
                ? "not-started"
                : result.status === "succeeded"
                  ? "completed"
                  : result.status;
            if (!accepted || accepted.kind !== expectedKind) {
              throw new RuntimeInteractionError(
                "EXECUTION_ADAPTER_PROTOCOL",
                `Interaction reconciliation did not reference its accepted ${expectedKind} Fact.`,
              );
            }
          }
          reconciled += 1;
        } catch (error) {
          releaseLease(reconciliationLeaseId);
          if (error instanceof Error) {
            reconciled += 1;
            continue;
          }
          throw error;
        }
      }
      return reconciled;
    };

  const requestInteractionTurnCancellationInTransaction: RuntimeInteraction["requestInteractionTurnCancellationInTransaction"] =
    (turnId) => {
      const current = readTurn(turnId);
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          current.status,
        )
      ) {
        throw new RuntimeInteractionError(
          "INTERACTION_TURN_CANCEL_STATE_INVALID",
          `Interaction Turn ${turnId} is not active.`,
        );
      }
      const now = clock().toISOString();
      const session = readSession(current.sessionId);
      database
        .prepare(
          `UPDATE interaction_turns
                SET status = CASE WHEN status = 'queued' THEN 'cancelled'
                                  ELSE 'reconciling' END,
                    failure_code = CASE WHEN status = 'queued'
                      THEN 'TURN_CANCELLED_BEFORE_EXECUTION'
                      ELSE 'TURN_CANCELLATION_RECONCILIATION_REQUIRED' END,
                    failure_message = CASE WHEN status = 'queued'
                      THEN 'The Interaction Turn was cancelled before execution.'
                      ELSE 'Cancellation was requested, but provider termination is not proven.' END,
                    completed_at = CASE WHEN status = 'queued' THEN ? ELSE NULL END
              WHERE id = ? AND status IN ('queued', 'running', 'reconciling')`,
        )
        .run(now, turnId);
      database
        .prepare(
          `UPDATE execution_leases
                SET cancel_requested = 1
              WHERE target_kind = 'interaction-turn' AND target_id = ?
                AND released_at IS NULL`,
        )
        .run(turnId);
      appendMutation({
        action: "interaction.turn.cancel.request",
        entityType: "interaction-turn",
        entityId: turnId,
        eventType:
          current.status === "queued"
            ? "interaction.turn.cancelled"
            : "interaction.turn.reconciling",
        runId: session.runId,
        nodeRunId: session.nodeRunId,
        sessionId: session.id,
        payload: {
          turnId,
          status: current.status === "queued" ? "cancelled" : "reconciling",
          failureCode:
            current.status === "queued"
              ? "TURN_CANCELLED_BEFORE_EXECUTION"
              : "TURN_CANCELLATION_RECONCILIATION_REQUIRED",
        },
        createdAt: now,
      });
      return readTurn(turnId);
    };

  const dispatchInteractionTurnCancellation: RuntimeInteraction["dispatchInteractionTurnCancellation"] =
    async (turnId) => {
      const current = readTurn(turnId);
      try {
        await interactionAdapter?.cancel(current.executionOperationKey);
      } catch {
        // Cancellation is advisory; reconciliation remains authoritative.
      }
      const active = activeTurns.get(turnId);
      active?.controller.abort();
      if (active) await active.done;
      const execution = inspectExecution(database, {
        operationKey: current.executionOperationKey,
      });
      const terminalProven = execution.facts.some(
        (fact) =>
          fact.status === "accepted" &&
          ["completed", "failed", "cancelled"].includes(fact.kind),
      );
      if (!terminalProven) {
        database
          .prepare(
            `UPDATE interaction_turns
                SET status = 'reconciling',
                    failure_code = 'TURN_CANCELLATION_RECONCILIATION_REQUIRED',
                    failure_message = 'Cancellation was requested, but provider termination is not proven.',
                    completed_at = NULL
              WHERE id = ? AND status IN ('failed', 'interrupted')`,
          )
          .run(turnId);
      }
    };

  const cancelInteractionTurn: RuntimeInteraction["cancelInteractionTurn"] =
    async (turnId) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        requestInteractionTurnCancellationInTransaction(turnId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      await dispatchInteractionTurnCancellation(turnId);
      return readTurn(turnId);
    };

  const prepareForShutdown: RuntimeInteraction["prepareForShutdown"] =
    async () => {
      const active = [...activeTurns.values()];
      for (const turn of active) turn.controller.abort();
      await Promise.all(active.map((turn) => turn.done));
      const running = database
        .prepare(
          `SELECT id, session_id AS sessionId
             FROM interaction_turns WHERE status = 'running'`,
        )
        .all() as Array<{ readonly id: string; readonly sessionId: string }>;
      if (running.length === 0) return;
      const now = clock().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const turn of running) {
          database
            .prepare(
              `UPDATE interaction_turns
                  SET status = 'reconciling', failure_code = 'RUNTIME_SHUTDOWN',
                      failure_message = 'Runtime drained before the consultation reached a proven terminal state.'
                WHERE id = ? AND status = 'running'`,
            )
            .run(turn.id);
          database
            .prepare(
              `UPDATE execution_leases SET released_at = ?
                WHERE target_kind = 'interaction-turn' AND target_id = ?
                  AND released_at IS NULL`,
            )
            .run(now, turn.id);
          const session = readSession(turn.sessionId);
          appendInteractionEvent({
            type: "interaction.turn.reconciling",
            sessionId: turn.sessionId,
            turnId: turn.id,
            projectId: session.projectId,
            payload: {
              status: "reconciling",
              failureCode: "RUNTIME_SHUTDOWN",
            },
            timestamp: now,
          });
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

  const insertPermissionInTransaction = (input: {
    readonly session: InteractionSessionView;
    readonly scope: string;
    readonly expiresAt?: string;
    readonly now: string;
  }): PermissionRequestView => {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO permission_requests(
           id, session_id, run_id, node_run_id, scope, status,
           expires_at, created_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(
        id,
        input.session.id,
        input.session.runId,
        input.session.nodeRunId,
        input.scope,
        input.expiresAt ?? null,
        input.now,
      );
    appendMutation({
      action: "permission.request",
      entityType: "permission-request",
      entityId: id,
      eventType: "permission.requested",
      runId: input.session.runId,
      nodeRunId: input.session.nodeRunId,
      sessionId: input.session.id,
      projectId: input.session.projectId,
      permissionRequestId: id,
      payload: { permissionId: id, scope: input.scope, status: "pending" },
      createdAt: input.now,
    });
    return readPermission(id);
  };

  const requestPermission: RuntimeInteraction["requestPermission"] = (
    input,
  ) => {
    const session = requireActiveSession(readSession(input.sessionId));
    const scope = exactPermissionScope(input.scope);
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const permission = insertPermissionInTransaction({
        session,
        scope,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        now,
      });
      database.exec("COMMIT");
      return permission;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const requestExecutionPermissionInTransaction: RuntimeInteraction["requestExecutionPermissionInTransaction"] =
    (input) => {
      const scope = exactPermissionScope(input.scope);
      const now = clock().toISOString();
      const existing = database
        .prepare(
          `SELECT id
             FROM interaction_sessions
            WHERE mode = 'run-collaboration' AND project_id = ?
              AND run_id = ? AND node_run_id = ? AND status = 'active'
         ORDER BY created_at, id
            LIMIT 1`,
        )
        .get(input.projectId, input.runId, input.nodeRunId) as
        | { readonly id: string }
        | undefined;
      let session: InteractionSessionView;
      if (existing) {
        session = readSession(existing.id);
      } else {
        const id = randomUUID();
        database
          .prepare(
            `INSERT INTO interaction_sessions(
               id, mode, project_id, run_id, node_run_id, status,
               created_at, closed_at
             ) VALUES (?, 'run-collaboration', ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(id, input.projectId, input.runId, input.nodeRunId, now);
        appendMutation({
          action: "interaction.session.create",
          entityType: "interaction-session",
          entityId: id,
          eventType: "session.created",
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          sessionId: id,
          payload: { mode: "run-collaboration", status: "active" },
          createdAt: now,
        });
        session = readSession(id);
      }
      return insertPermissionInTransaction({
        session,
        scope,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        now,
      });
    };

  const decidePermissionInTransaction: RuntimeInteraction["decidePermissionInTransaction"] =
    (input) => {
      const actorIsVerified =
        (input.actor.type === "human" &&
          input.actor.authenticatedBy === "local-session") ||
        (input.actor.type === "acp-client" &&
          input.actor.authenticatedBy === "acp-connection");
      if (!actorIsVerified) {
        throw new RuntimeInteractionError(
          "PERMISSION_ACTOR_INVALID",
          "Permission decisions require a verified Human or ACP Client actor.",
        );
      }
      if (!input.commandId.trim()) {
        throw new RuntimeInteractionError(
          "PERMISSION_COMMAND_INVALID",
          "Permission decisions require a stable Command ID.",
        );
      }
      const commandOwner = database
        .prepare(
          `SELECT permission_request_id AS permissionId
           FROM permission_decisions WHERE command_id = ?`,
        )
        .get(input.commandId) as { readonly permissionId: string } | undefined;
      if (commandOwner && commandOwner.permissionId !== input.permissionId) {
        throw new RuntimeInteractionError(
          "PERMISSION_COMMAND_REUSE",
          `Permission Command ${input.commandId} already belongs to another request.`,
        );
      }
      const current = readPermission(input.permissionId);
      if (current.decisionCommandId !== null) {
        if (
          current.status === input.decision &&
          current.decisionCommandId === input.commandId &&
          current.decisionActor?.type === input.actor.type &&
          current.decisionActor.id === input.actor.id &&
          current.decisionActor.authenticatedBy === input.actor.authenticatedBy
        ) {
          return current;
        }
        throw new RuntimeInteractionError(
          "PERMISSION_DECISION_EXISTS",
          `Permission Request ${input.permissionId} already has a decision.`,
        );
      }
      const now = clock().toISOString();
      const updated = database
        .prepare(
          `UPDATE permission_requests
              SET status = ?, decided_at = ?
            WHERE id = ? AND status = ?`,
        )
        .run(input.decision, now, input.permissionId, input.expectedStatus);
      if (Number(updated.changes) !== 1) {
        throw new RuntimeInteractionError(
          "PERMISSION_STATE_INVALID",
          `Permission Request ${input.permissionId} is not pending.`,
        );
      }
      database
        .prepare(
          `INSERT INTO permission_decisions(
             id, permission_request_id, scope, decision, actor_type,
             actor_id, authenticated_by, command_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          current.id,
          current.scope,
          input.decision,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
          input.commandId,
          now,
        );
      appendMutation({
        action: "permission.decide",
        entityType: "permission-request",
        entityId: current.id,
        eventType: "permission.decided",
        runId: current.runId,
        nodeRunId: current.nodeRunId,
        sessionId: current.sessionId,
        projectId: readSession(current.sessionId).projectId,
        permissionRequestId: current.id,
        payload: {
          permissionId: current.id,
          scope: current.scope,
          status: input.decision,
          decisionActor: input.actor,
        },
        createdAt: now,
        actor: input.actor,
        commandId: input.commandId,
      });
      return readPermission(input.permissionId);
    };

  const decidePermission: RuntimeInteraction["decidePermission"] = (input) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const permission = decidePermissionInTransaction(input);
      database.exec("COMMIT");
      return permission;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const inspectSession = (sessionId: string): InteractionView => {
    const session = readSession(sessionId);
    const participants = database
      .prepare(
        `SELECT id, session_id AS sessionId,
                participant_type AS participantType,
                participant_ref AS participantRef, role,
                created_at AS createdAt
           FROM session_participants WHERE session_id = ?
          ORDER BY created_at, rowid`,
      )
      .all(sessionId) as unknown as SessionParticipantView[];
    const messages = database
      .prepare(
        `SELECT id, session_id AS sessionId, participant_id AS participantId,
                kind, content, created_at AS createdAt
           FROM session_messages WHERE session_id = ?
          ORDER BY created_at, rowid`,
      )
      .all(sessionId) as unknown as SessionMessageView[];
    const permissions = database
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId,
                node_run_id AS nodeRunId
           FROM permission_requests WHERE session_id = ?
          ORDER BY created_at, id`,
      )
      .all(sessionId) as Array<{ readonly id: string }>;
    const permissionViews = permissions.map((permission) =>
      readPermission(permission.id),
    );
    const turns = database
      .prepare(
        `SELECT id FROM interaction_turns
          WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as Array<{ readonly id: string }>;
    return {
      session,
      participants,
      messages,
      turns: turns.map((turn) => readTurn(turn.id)),
      permissions: permissionViews,
    };
  };

  const listSessions = (projectId: string): readonly InteractionView[] => {
    const rows = database
      .prepare(
        `SELECT id FROM interaction_sessions
          WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId) as Array<{ readonly id: string }>;
    return rows.map((row) => inspectSession(row.id));
  };

  const recoveringTurns = database
    .prepare(
      `SELECT id, session_id AS sessionId
         FROM interaction_turns WHERE status = 'running'`,
    )
    .all() as Array<{ readonly id: string; readonly sessionId: string }>;
  if (recoveringTurns.length > 0) {
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `UPDATE interaction_turns
              SET status = 'reconciling', failure_code = 'RUNTIME_RESTART',
                  failure_message = 'Runtime restarted while this Turn was running.'
            WHERE status = 'running'`,
        )
        .run();
      database
        .prepare(
          `UPDATE execution_leases
              SET released_at = ?
            WHERE target_kind = 'interaction-turn' AND released_at IS NULL
              AND target_id IN (
                SELECT id FROM interaction_turns WHERE status = 'reconciling'
              )`,
        )
        .run(now);
      for (const turn of recoveringTurns) {
        const session = readSession(turn.sessionId);
        appendInteractionEvent({
          type: "interaction.turn.reconciling",
          sessionId: turn.sessionId,
          turnId: turn.id,
          projectId: session.projectId,
          payload: { status: "reconciling", failureCode: "RUNTIME_RESTART" },
          timestamp: now,
        });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    createSession,
    closeSession,
    addParticipant,
    addMessage,
    requestPermission,
    requestExecutionPermissionInTransaction,
    decidePermission,
    decidePermissionInTransaction,
    inspectPermission: readPermission,
    inspectSession,
    acceptPromptInTransaction,
    executeTurn,
    cancelInteractionTurn,
    requestInteractionTurnCancellationInTransaction,
    dispatchInteractionTurnCancellation,
    requestTurnCancellationInTransaction,
    cancelTurn,
    reconcilePendingTurns,
    prepareForShutdown,
    inspectTurn: readTurn,
    inspectTurnExecution: (turnId) =>
      inspectExecution(database, {
        operationKey: readTurn(turnId).executionOperationKey,
      }),
    listSessions,
  };
};
