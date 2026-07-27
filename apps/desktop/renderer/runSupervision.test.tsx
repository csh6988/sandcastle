import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSupervisionView } from "../runtime/interface.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";
import {
  applyRunSupervisionFrame,
  RunSupervisionPanel,
  type RunSupervisionTab,
} from "./runSupervision.js";

const supervisionView = (generation: number): RunSupervisionView => ({
  run: {
    ...scriptedDepartmentRun.run,
    revision: generation,
    status: "running",
  },
  snapshot: {
    id: scriptedDepartmentRun.snapshot.id,
    revision: scriptedDepartmentRun.snapshot.revision,
    hash: scriptedDepartmentRun.snapshot.hash,
  },
  graph: {
    nodes: [
      {
        nodeRunId: "node-run-implement",
        pipelineNodeId: "implement",
        name: "Implement",
        type: "ai-task",
        status: "running",
        attemptId: "attempt-1",
      },
    ],
    edges: [{ from: "start", to: "implement" }],
  },
  timeline: [
    {
      sequence: 9,
      eventId: "event-9",
      type: "attempt.reconciling",
      runId: "run-1",
      nodeRunId: "node-run-implement",
      payload: { status: "reconciling" },
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  ],
  agentActivities: [
    {
      aiMemberId: "member-1",
      aiMemberName: "Ada",
      positionId: "position-1",
      positionName: "Engineer",
      agentAdapterId: "adapter-1",
      model: "model-1",
      sessionId: "session-collaboration",
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      nodeRunId: "node-run-implement",
      attemptId: "attempt-1",
      workPackageId: null,
      worktree: null,
      status: "reconciling",
      startedAt: "2026-07-27T00:00:00.000Z",
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
      cost: null,
      nextAction: "reconcile-or-recover",
    },
  ],
  interactions: [
    {
      boundary: "consultation",
      session: {
        id: "session-consultation",
        mode: "consultation",
        projectId: "project-1",
        runId: "run-1",
        nodeRunId: null,
        status: "active",
        createdAt: "2026-07-27T00:00:00.000Z",
        closedAt: null,
      },
      turns: [],
      permissions: [],
    },
    {
      boundary: "run-collaboration",
      session: {
        id: "session-collaboration",
        mode: "run-collaboration",
        projectId: "project-1",
        runId: "run-1",
        nodeRunId: "node-run-implement",
        status: "active",
        createdAt: "2026-07-27T00:00:00.000Z",
        closedAt: null,
      },
      turns: [],
      permissions: [],
    },
  ],
  interventions: [],
  allowedCommands: {
    pause: true,
    resume: false,
    cancelAttemptIds: ["attempt-1"],
    cancelTurnIds: [],
    decidePermissionIds: [],
    interveneNodeRunIds: ["node-run-implement"],
  },
});

const render = (
  view: RunSupervisionView,
  initialTab: RunSupervisionTab = "graph",
) =>
  renderToStaticMarkup(
    <RunSupervisionPanel
      initialTab={initialTab}
      onCancelAttempt={() => undefined}
      onCancelTurn={() => undefined}
      onDecidePermission={() => undefined}
      onIntervene={() => undefined}
      onPause={() => undefined}
      onResume={() => undefined}
      view={view}
    />,
  );

describe("Run Supervision UI", () => {
  it("uses authoritative command guards and keeps interaction boundaries explicit", () => {
    const markup = render(supervisionView(4));

    assert.match(markup, /data-supervision-command="pause"/);
    assert.doesNotMatch(
      markup,
      /data-supervision-command="pause"[^>]*disabled/,
    );
    assert.match(markup, /data-supervision-command="resume"[^>]*disabled/);
    assert.match(markup, /data-cancel-attempt="attempt-1"/);
    assert.match(markup, /data-interaction-boundary="consultation"/);
    assert.match(markup, /data-interaction-boundary="run-collaboration"/);
  });

  it("renders reconciling and Timeline evidence without inferring status from prose", () => {
    const activity = render(supervisionView(4), "activity");
    const timeline = render(supervisionView(4), "timeline");

    assert.match(activity, /data-agent-activity-status="reconciling"/);
    assert.match(timeline, /data-runtime-event="attempt.reconciling"/);
  });

  it("discards stale event generations", () => {
    const current = {
      generation: 8,
      view: supervisionView(8),
    };

    assert.equal(
      applyRunSupervisionFrame(current, {
        generation: 7,
        view: supervisionView(7),
      }),
      current,
    );
    assert.equal(
      applyRunSupervisionFrame(current, {
        generation: 9,
        view: supervisionView(9),
      }).generation,
      9,
    );
  });
});
