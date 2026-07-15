import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
}

export interface InteractionView {
  readonly session: InteractionSessionView;
  readonly participants: readonly SessionParticipantView[];
  readonly messages: readonly SessionMessageView[];
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
  readonly requestPermission: (input: {
    readonly sessionId: string;
    readonly scope: string;
    readonly expiresAt?: string;
  }) => PermissionRequestView;
  readonly decidePermission: (input: {
    readonly permissionId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "denied";
  }) => PermissionRequestView;
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
): RuntimeInteraction => {
  const appendMutation = (input: {
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly eventType: string;
    readonly runId?: string | null;
    readonly nodeRunId?: string | null;
    readonly sessionId: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
      );
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

  const readPermission = (permissionId: string): PermissionRequestView => {
    const row = database
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId,
                node_run_id AS nodeRunId, scope, status,
                expires_at AS expiresAt, created_at AS createdAt,
                decided_at AS decidedAt
           FROM permission_requests WHERE id = ?`,
      )
      .get(permissionId) as PermissionRequestView | undefined;
    if (!row) {
      throw new RuntimeInteractionError(
        "PERMISSION_REQUEST_NOT_FOUND",
        `Permission Request ${permissionId} was not found.`,
      );
    }
    return row;
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

  const requestPermission: RuntimeInteraction["requestPermission"] = (
    input,
  ) => {
    const session = requireActiveSession(readSession(input.sessionId));
    if (!input.scope.trim()) {
      throw new RuntimeInteractionError(
        "PERMISSION_SCOPE_INVALID",
        "Permission scope must not be empty.",
      );
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO permission_requests(
             id, session_id, run_id, node_run_id, scope, status,
             expires_at, created_at, decided_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
        )
        .run(
          id,
          session.id,
          session.runId,
          session.nodeRunId,
          input.scope,
          input.expiresAt ?? null,
          now,
        );
      appendMutation({
        action: "permission.request",
        entityType: "permission-request",
        entityId: id,
        eventType: "permission.requested",
        runId: session.runId,
        nodeRunId: session.nodeRunId,
        sessionId: session.id,
        payload: { permissionId: id, scope: input.scope, status: "pending" },
        createdAt: now,
      });
      database.exec("COMMIT");
      return readPermission(id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const decidePermission: RuntimeInteraction["decidePermission"] = (input) => {
    const current = readPermission(input.permissionId);
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
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
      appendMutation({
        action: "permission.decide",
        entityType: "permission-request",
        entityId: current.id,
        eventType: "permission.decided",
        runId: current.runId,
        nodeRunId: current.nodeRunId,
        sessionId: current.sessionId,
        payload: {
          permissionId: current.id,
          scope: current.scope,
          status: input.decision,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
      return readPermission(input.permissionId);
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
          ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as SessionParticipantView[];
    const messages = database
      .prepare(
        `SELECT id, session_id AS sessionId, participant_id AS participantId,
                kind, content, created_at AS createdAt
           FROM session_messages WHERE session_id = ?
          ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as SessionMessageView[];
    const permissions = database
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId,
                node_run_id AS nodeRunId, scope, status,
                expires_at AS expiresAt, created_at AS createdAt,
                decided_at AS decidedAt
           FROM permission_requests WHERE session_id = ?
          ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as PermissionRequestView[];
    return { session, participants, messages, permissions };
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

  return {
    createSession,
    closeSession,
    addParticipant,
    addMessage,
    requestPermission,
    decidePermission,
    inspectSession,
    listSessions,
  };
};
