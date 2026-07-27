import type { DatabaseSync } from "node:sqlite";
import type { InteractionView, RuntimeInteraction } from "./interaction.js";
import type {
  DepartmentRunStatus,
  DepartmentRunView,
  NodeRunStatus,
} from "./interface.js";
import type {
  PipelineRuntime,
  RuntimeEventRecord,
} from "./pipeline/pipelineRuntime.js";

export interface RunSupervisionView {
  readonly run: DepartmentRunView["run"];
  readonly snapshot: {
    readonly id: string;
    readonly revision: number;
    readonly hash: string;
  };
  readonly graph: {
    readonly nodes: readonly {
      readonly nodeRunId: string;
      readonly pipelineNodeId: string;
      readonly name: string;
      readonly type: string;
      readonly status: NodeRunStatus;
      readonly attemptId: string | null;
    }[];
    readonly edges: readonly { readonly from: string; readonly to: string }[];
  };
  readonly timeline: readonly RuntimeEventRecord[];
  readonly agentActivities: readonly {
    readonly aiMemberId: string;
    readonly aiMemberName: string;
    readonly positionId: string;
    readonly positionName: string;
    readonly agentAdapterId: string;
    readonly model: string;
    readonly sessionId: string | null;
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly nodeRunId: string;
    readonly attemptId: string | null;
    readonly workPackageId: string | null;
    readonly worktree: string | null;
    readonly status: NodeRunStatus | "reconciling" | "interrupted";
    readonly startedAt: string | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number | null;
    readonly nextAction: string;
  }[];
  readonly interactions: readonly {
    readonly boundary: "consultation" | "run-collaboration";
    readonly session: InteractionView["session"];
    readonly turns: InteractionView["turns"];
    readonly permissions: InteractionView["permissions"];
  }[];
  readonly interventions: readonly {
    readonly id: string;
    readonly nodeRunId: string;
    readonly attemptId: string | null;
    readonly snapshotRevisionId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly feedback: string;
    readonly outcome: "feedback" | "new-attempt";
    readonly createdAt: string;
  }[];
  readonly allowedCommands: {
    readonly pause: boolean;
    readonly resume: boolean;
    readonly cancelAttemptIds: readonly string[];
    readonly cancelTurnIds: readonly string[];
    readonly decidePermissionIds: readonly string[];
    readonly interveneNodeRunIds: readonly string[];
  };
}

export interface RuntimeSupervision {
  readonly inspect: (runId: string) => RunSupervisionView;
}

const pauseableStatuses = new Set<DepartmentRunStatus>([
  "ready",
  "running",
  "waiting-approval",
  "blocked",
  "recovering",
]);

const nextActionFor = (status: NodeRunStatus): string => {
  switch (status) {
    case "queued":
      return "wait-for-dependencies";
    case "ready":
      return "execute";
    case "running":
      return "observe-or-intervene";
    case "waiting-permission":
      return "decide-permission";
    case "waiting-approval":
      return "decide-approval";
    case "paused":
      return "resume";
    case "blocked":
      return "reconcile-or-recover";
    case "failed":
      return "retry-or-recover";
    case "succeeded":
    case "skipped":
    case "cancelled":
      return "none";
  }
};

export const openRuntimeSupervision = (
  database: DatabaseSync,
  options: {
    readonly pipelineRuntime: PipelineRuntime;
    readonly interaction: RuntimeInteraction;
  },
): RuntimeSupervision => ({
  inspect: (runId) => {
    const inspected = options.pipelineRuntime.inspectRun(runId);
    const graphNodes = inspected.snapshot.payload.pipelineVersion.graph.nodes;
    const graphNodeById = new Map(graphNodes.map((node) => [node.id, node]));
    const positions = new Map(
      inspected.snapshot.payload.positions.map((position) => [
        position.id,
        position,
      ]),
    );
    const profiles = new Map(
      inspected.snapshot.payload.executionProfiles.map((profile) => [
        profile.id,
        profile,
      ]),
    );
    const defaultProfile = inspected.snapshot.payload.department
      .defaultExecutionProfileId
      ? profiles.get(
          inspected.snapshot.payload.department.defaultExecutionProfileId,
        )
      : undefined;
    const interactions = options.interaction
      .listSessions(inspected.run.projectId)
      .filter((view) => view.session.runId === runId)
      .sort((left, right) => {
        if (left.session.mode !== right.session.mode) {
          return left.session.mode === "run-collaboration" ? -1 : 1;
        }
        return left.session.createdAt.localeCompare(right.session.createdAt);
      });
    const collaborationByNode = new Map(
      interactions
        .filter(
          (view) =>
            view.session.mode === "run-collaboration" &&
            view.session.nodeRunId !== null,
        )
        .map((view) => [view.session.nodeRunId!, view]),
    );
    const timeline = options.pipelineRuntime
      .runtimeEvents({ afterSequence: 0, limit: 1_000 })
      .filter((event) => event.runId === runId);
    const usageByNode = new Map<
      string,
      { inputTokens: number; outputTokens: number; totalTokens: number }
    >();
    for (const event of timeline) {
      if (event.type !== "usage.recorded" || !event.nodeRunId) continue;
      const payload = event.payload as {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      };
      const current = usageByNode.get(event.nodeRunId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      usageByNode.set(event.nodeRunId, {
        inputTokens: current.inputTokens + (payload.inputTokens ?? 0),
        outputTokens: current.outputTokens + (payload.outputTokens ?? 0),
        totalTokens: current.totalTokens + (payload.totalTokens ?? 0),
      });
    }
    const hasInterventions = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'governed_interventions'",
      )
      .get() as { readonly present: number } | undefined;
    const interventions = hasInterventions
      ? (database
          .prepare(
            `SELECT id, node_run_id AS nodeRunId, attempt_id AS attemptId,
                    snapshot_revision_id AS snapshotRevisionId,
                    actor_id AS actorId, reason, feedback, outcome,
                    created_at AS createdAt
               FROM governed_interventions
              WHERE run_id = ? ORDER BY created_at, id`,
          )
          .all(runId) as unknown as RunSupervisionView["interventions"])
      : [];

    return {
      run: inspected.run,
      snapshot: {
        id: inspected.snapshot.id,
        revision: inspected.snapshot.revision,
        hash: inspected.snapshot.hash,
      },
      graph: {
        nodes: inspected.nodes.map((node) => ({
          nodeRunId: node.id,
          pipelineNodeId: node.pipelineNodeId,
          name:
            graphNodeById.get(node.pipelineNodeId)?.name ?? node.pipelineNodeId,
          type: node.nodeType,
          status: node.status,
          attemptId: node.attempts.at(-1)?.id ?? null,
        })),
        edges: inspected.snapshot.payload.pipelineVersion.graph.edges.map(
          (edge) => ({
            from: edge.from,
            to: edge.to,
          }),
        ),
      },
      timeline,
      agentActivities: inspected.nodes.flatMap((node) => {
        const graphNode = graphNodeById.get(node.pipelineNodeId);
        if (
          !graphNode ||
          !("positionId" in graphNode) ||
          !graphNode.positionId
        ) {
          return [];
        }
        const position = positions.get(graphNode.positionId);
        if (!position) return [];
        const attempt = node.attempts.at(-1);
        const usage = usageByNode.get(node.id) ?? {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        return [
          {
            aiMemberId: position.aiMember.id,
            aiMemberName: position.aiMember.displayName,
            positionId: position.id,
            positionName: position.name,
            agentAdapterId:
              defaultProfile?.providerRef ?? position.resolvedAgentId,
            model: defaultProfile?.model ?? "unknown",
            sessionId: collaborationByNode.get(node.id)?.session.id ?? null,
            runId,
            snapshotRevisionId:
              attempt?.snapshotRevisionId ?? inspected.snapshot.id,
            nodeRunId: node.id,
            attemptId: attempt?.id ?? null,
            workPackageId: null,
            worktree: null,
            status: attempt?.status ?? node.status,
            startedAt: attempt?.startedAt ?? null,
            ...usage,
            cost: null,
            nextAction: nextActionFor(node.status),
          },
        ];
      }),
      interactions: interactions.map((view) => ({
        boundary: view.session.mode,
        session: view.session,
        turns: view.turns,
        permissions: view.permissions,
      })),
      interventions,
      allowedCommands: {
        pause: pauseableStatuses.has(inspected.run.status),
        resume: inspected.run.status === "paused",
        cancelAttemptIds: inspected.nodes.flatMap((node) => {
          const attempt = node.attempts.at(-1);
          return attempt && ["running", "reconciling"].includes(attempt.status)
            ? [attempt.id]
            : [];
        }),
        cancelTurnIds: interactions.flatMap((view) =>
          view.turns
            .filter((turn) =>
              ["queued", "running", "reconciling"].includes(turn.status),
            )
            .map((turn) => turn.id),
        ),
        decidePermissionIds: interactions.flatMap((view) =>
          view.permissions
            .filter((permission) => permission.status === "pending")
            .map((permission) => permission.id),
        ),
        interveneNodeRunIds: inspected.nodes
          .filter((node) =>
            ["failed", "interrupted", "cancelled"].includes(
              node.attempts.at(-1)?.status ?? "",
            ),
          )
          .map((node) => node.id),
      },
    };
  },
});
