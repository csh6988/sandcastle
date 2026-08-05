import { isDeepStrictEqual } from "node:util";
import type { EventEnvelope } from "./interface.js";
import {
  assertRuntimeEventRegistryVersionSupported,
  createRuntimeEventRegistry,
  effectiveRuntimeEventRegistryVersion,
  RuntimeEventRegistryError,
} from "./events/registry.js";

export interface AgUiEvent {
  readonly type:
    | "RUN_STARTED"
    | "RUN_FINISHED"
    | "RUN_ERROR"
    | "STEP_STARTED"
    | "STEP_FINISHED"
    | "TEXT_MESSAGE_CONTENT"
    | "TOOL_CALL_START"
    | "TOOL_CALL_ARGS"
    | "TOOL_CALL_END"
    | "TOOL_CALL_RESULT"
    | "STEP_FAILED"
    | "CUSTOM";
  readonly runId: string | null;
  readonly eventId: string;
  readonly sequence: number;
  readonly payload: unknown;
}

export class AgUiCursorExpiredError extends Error {
  readonly code = "AG_UI_CURSOR_EXPIRED";

  constructor(afterSequence: number, earliestSequence: number) {
    super(
      `AG-UI cursor ${afterSequence} is older than the retained Runtime event sequence ${earliestSequence}.`,
    );
    this.name = "AgUiCursorExpiredError";
  }
}

export class AgUiProtocolDiagnosticError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly eventId: string,
    readonly sequence: number,
  ) {
    super(message);
    this.name = "AgUiProtocolDiagnosticError";
  }
}

const runtimeEventRegistry = createRuntimeEventRegistry();

const standardTypeByRuntimeEvent: Readonly<Record<string, AgUiEvent["type"]>> =
  {
    "run.created": "RUN_STARTED",
    "run.started": "RUN_STARTED",
    "attempt.started": "STEP_STARTED",
    "attempt.succeeded": "STEP_FINISHED",
    "attempt.failed": "STEP_FAILED",
    "attempt.interrupted": "STEP_FINISHED",
    "interaction.turn.started": "RUN_STARTED",
    "interaction.turn.completed": "RUN_FINISHED",
    "interaction.turn.failed": "RUN_ERROR",
    "interaction.turn.cancelled": "RUN_FINISHED",
    "interaction.turn.interrupted": "RUN_FINISHED",
  };

const sensitiveKey =
  /^(?:api[_-]?key|authorization|password|secret|token|private[_-]?reasoning|chain[_-]?of[_-]?thought|raw[_-]?reasoning)$/i;

const redactString = (value: string): string =>
  value
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");

const canonicalizeAndRedact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeAndRedact);
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactString(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : canonicalizeAndRedact(entry),
      ]),
  );
};

const canonicalString = (value: unknown): string =>
  typeof value === "string"
    ? redactString(value)
    : JSON.stringify(canonicalizeAndRedact(value));

const eventSource = (event: EventEnvelope): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries({
      eventId: event.eventId,
      sequence: event.sequence,
      registryVersion: effectiveRuntimeEventRegistryVersion(event),
      schemaVersion: event.schemaVersion,
      companyId: event.companyId,
      projectId: event.projectId,
      applicationId: event.applicationId,
      departmentId: event.departmentId,
      positionId: event.positionId,
      aiMemberId: event.aiMemberId,
      companyAgentAdapterId: event.companyAgentAdapterId,
      skillId: event.skillId,
      skillFlowId: event.skillFlowId,
      executionProfileId: event.executionProfileId,
      repositoryReferenceId: event.repositoryReferenceId,
      productProposalId: event.productProposalId,
      productBaselineId: event.productBaselineId,
      projectSpecRevisionId: event.projectSpecRevisionId,
      applicationSpecRevisionId: event.applicationSpecRevisionId,
      technicalBaselineProposalId: event.technicalBaselineProposalId,
      technicalBaselineId: event.technicalBaselineId,
      pipelineVersionId: event.pipelineVersionId,
      runId: event.runId,
      snapshotRevisionId: event.snapshotRevisionId,
      nodeRunId: event.nodeRunId,
      nodeAttemptId: event.nodeAttemptId,
      nodeLeaseId: event.nodeLeaseId,
      executionLeaseId: event.executionLeaseId,
      executionOperationKey: event.executionOperationKey,
      executionFactId: event.executionFactId,
      workPackageId: event.workPackageId,
      workPackageVersionId: event.workPackageVersionId,
      workspaceAllocationId: event.workspaceAllocationId,
      integrationGenerationId: event.integrationGenerationId,
      integrationOperationId: event.integrationOperationId,
      sessionId: event.sessionId,
      interactionTurnId: event.interactionTurnId,
      participantId: event.participantId,
      topicId: event.topicId,
      artifactId: event.artifactId,
      reviewFindingId: event.reviewFindingId,
      qualityGateResultId: event.qualityGateResultId,
      artifactVersionId: event.artifactVersionId,
      defectId: event.defectId,
      permissionRequestId: event.permissionRequestId,
      nodeApprovalRequestId: event.nodeApprovalRequestId,
      nodeApprovalDecisionId: event.nodeApprovalDecisionId,
      testCaseRevisionId: event.testCaseRevisionId,
      testRunId: event.testRunId,
      securityReviewId: event.securityReviewId,
      operabilityReviewId: event.operabilityReviewId,
      deliveryCandidateInputId: event.deliveryCandidateInputId,
      deliveryCandidateId: event.deliveryCandidateId,
      releaseDecisionId: event.releaseDecisionId,
      releaseOperationId: event.releaseOperationId,
      memoryCandidateId: event.memoryCandidateId,
      memoryEntryId: event.memoryEntryId,
      improvementProposalId: event.improvementProposalId,
      improvementApplicationOperationId:
        event.improvementApplicationOperationId,
      commandId: event.commandId,
    }).filter(([, value]) => value !== undefined),
  );

export const runtimeEventToAgUi = (
  event: EventEnvelope,
): readonly AgUiEvent[] => {
  const registryVersion = effectiveRuntimeEventRegistryVersion(event);
  try {
    assertRuntimeEventRegistryVersionSupported(
      registryVersion,
      runtimeEventRegistry.version,
    );
  } catch (error) {
    if (!(error instanceof RuntimeEventRegistryError)) throw error;
    // A version-too-new (or below-floor) registry version is a permanent
    // condition: retrying will never make the event readable. Surface it as the
    // AG-UI protocol diagnostic with retryable=false.
    throw new AgUiProtocolDiagnosticError(
      "AG_UI_RUNTIME_EVENT_REGISTRY_UNSUPPORTED",
      `Runtime event registry ${String(registryVersion)} is not supported.`,
      false,
      event.eventId,
      event.sequence,
    );
  }
  let mappingIntent: "mapped" | "custom" | "unmapped";
  try {
    mappingIntent = runtimeEventRegistry.validate({
      type: event.type,
      scope: event,
      payload: event.payload,
      schemaVersion: event.schemaVersion,
    }).agUiMapping;
  } catch (error) {
    if (!(error instanceof RuntimeEventRegistryError)) throw error;
    throw new AgUiProtocolDiagnosticError(
      error.code === "RUNTIME_EVENT_SCHEMA_UNSUPPORTED"
        ? "AG_UI_RUNTIME_EVENT_SCHEMA_UNSUPPORTED"
        : error.code === "RUNTIME_EVENT_UNREGISTERED"
          ? "AG_UI_RUNTIME_EVENT_UNREGISTERED"
          : "AG_UI_RUNTIME_EVENT_INVALID",
      error.message,
      error.code === "RUNTIME_EVENT_SCHEMA_UNSUPPORTED" ||
        error.code === "RUNTIME_EVENT_UNREGISTERED",
      event.eventId,
      event.sequence,
    );
  }
  if (mappingIntent === "unmapped") {
    return [
      {
        type: "CUSTOM",
        runId: event.runId ?? null,
        eventId: event.eventId,
        sequence: event.sequence,
        payload: {
          name: "sandcastle.runtime-event.unmapped",
          value: {
            payload: canonicalizeAndRedact(event.payload),
            runtimeEventType: event.type,
          },
          source: eventSource(event),
        },
      },
    ];
  }
  if (event.type === "message.delta") {
    const payload = event.payload as {
      readonly messageId?: string;
      readonly content?: string;
    };
    return [
      {
        type: "TEXT_MESSAGE_CONTENT",
        runId: event.runId ?? null,
        eventId: event.eventId,
        sequence: event.sequence,
        payload: {
          messageId: payload.messageId,
          delta: redactString(payload.content ?? ""),
          source: eventSource(event),
        },
      },
    ];
  }
  if (event.type === "tool.call") {
    const payload = event.payload as {
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
    };
    const common = {
      runId: event.runId ?? null,
      eventId: event.eventId,
      sequence: event.sequence,
    };
    const source = eventSource(event);
    return [
      {
        ...common,
        type: "TOOL_CALL_START",
        payload: {
          toolCallId: payload.toolCallId,
          toolName: payload.name,
          source,
        },
      },
      {
        ...common,
        type: "TOOL_CALL_ARGS",
        payload: {
          toolCallId: payload.toolCallId,
          args: canonicalString(payload.args),
          source,
        },
      },
      {
        ...common,
        type: "TOOL_CALL_END",
        payload: { toolCallId: payload.toolCallId, source },
      },
    ];
  }
  if (event.type === "tool.result") {
    const payload = event.payload as {
      readonly toolCallId?: string;
      readonly content?: unknown;
    };
    return [
      {
        type: "TOOL_CALL_RESULT",
        runId: event.runId ?? null,
        eventId: event.eventId,
        sequence: event.sequence,
        payload: {
          toolCallId: payload.toolCallId,
          content: canonicalString(payload.content),
          source: eventSource(event),
        },
      },
    ];
  }
  const standardType = standardTypeByRuntimeEvent[event.type];
  if (standardType) {
    return [
      {
        type: standardType,
        runId: event.runId ?? event.interactionTurnId ?? null,
        eventId: event.eventId,
        sequence: event.sequence,
        payload: {
          value: canonicalizeAndRedact(event.payload),
          source: eventSource(event),
        },
      },
    ];
  }
  return [
    {
      type: "CUSTOM",
      runId: event.runId ?? event.interactionTurnId ?? null,
      eventId: event.eventId,
      sequence: event.sequence,
      payload: {
        name: `sandcastle.${event.type}`,
        value: {
          payload: canonicalizeAndRedact(event.payload),
          runtimeEventType: event.type,
        },
        source: eventSource(event),
      },
    },
  ];
};

export const replayRuntimeEventsAsAgUi = (
  events: readonly EventEnvelope[],
  input: {
    readonly afterSequence: number;
    readonly earliestRetainedSequence?: number;
  },
): { readonly events: readonly AgUiEvent[]; readonly nextSequence: number } => {
  const sorted = [...events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const earliest = input.earliestRetainedSequence ?? sorted[0]?.sequence;
  if (earliest !== undefined && input.afterSequence < earliest - 1) {
    throw new AgUiCursorExpiredError(input.afterSequence, earliest);
  }
  const selected = sorted.filter(
    (event) => event.sequence > input.afterSequence,
  );
  const seenEventIds = new Map<string, EventEnvelope>();
  const deduplicated = selected.filter((event) => {
    const seen = seenEventIds.get(event.eventId);
    if (seen !== undefined) {
      if (!isDeepStrictEqual(seen, event)) {
        throw new AgUiProtocolDiagnosticError(
          "AG_UI_RUNTIME_EVENT_DUPLICATE_CONFLICT",
          `Runtime event ${event.eventId} was replayed with conflicting content.`,
          true,
          event.eventId,
          event.sequence,
        );
      }
      return false;
    }
    seenEventIds.set(event.eventId, event);
    return true;
  });
  let expectedSequence = input.afterSequence + 1;
  for (const event of deduplicated) {
    if (event.sequence !== expectedSequence) {
      throw new AgUiProtocolDiagnosticError(
        "AG_UI_RUNTIME_EVENT_SEQUENCE_GAP",
        `Expected Runtime event sequence ${expectedSequence}, received ${event.sequence}.`,
        true,
        event.eventId,
        event.sequence,
      );
    }
    expectedSequence = event.sequence + 1;
  }
  return {
    events: deduplicated.flatMap(runtimeEventToAgUi),
    nextSequence: deduplicated.at(-1)?.sequence ?? input.afterSequence,
  };
};
