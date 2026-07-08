import { describe, expect, it } from "vitest";
import type {
  BoardRuntimeEventRecord,
  BoardRunRecord,
  BoardTaskRecord,
} from "./BoardStore.js";
import { renderTaskProgress, type TaskProgressRun } from "./taskProgress.js";

const FIXED_NOW = new Date("2026-07-02T00:00:00.000Z");

const baseTask = (): BoardTaskRecord => ({
  id: "task-1",
  title: "Rich run failure evidence",
  prompt: "PRD",
  status: "running",
  createdAt: "2026-07-01T00:00:00.000Z",
  runIds: ["run-1"],
  plan: {
    repositories: [{ name: "sandcastle", task: "Add recovery evidence" }],
  },
});

const failedRun = (): BoardRunRecord => ({
  id: "run-1",
  name: "workspace sandcastle",
  agent: "test-agent",
  sandbox: "test",
  branch: "codex/board/sandcastle",
  maxIterations: 1,
  status: "failed",
  createdAt: "2026-07-01T01:00:00.000Z",
  error: "agent exited with code 1",
  commits: 0,
  repo: "sandcastle",
});

const eventRecord = (
  event: BoardRuntimeEventRecord["event"],
  seq = 1,
): BoardRuntimeEventRecord => ({ seq, event });

describe("renderTaskProgress recovery evidence", () => {
  it("surfaces preserved worktree, run log, session, and completion state", () => {
    const runs: TaskProgressRun[] = [
      {
        run: failedRun(),
        events: [
          eventRecord({
            type: "run.error",
            runId: "run-1",
            message: "agent exited with code 1",
            recovery: {
              failureKind: "agent",
              failurePhase: "agent",
              preservedWorktreePath: "/host/worktrees/sandcastle",
              runLogPath: "/host/logs/sandcastle.log",
              sessionId: "sess-42",
              sessionFilePath: "/host/sessions/sess-42.jsonl",
              completionSignalSeen: true,
              commits: ["abc123", "def456"],
            },
            timestamp: "2026-07-01T01:05:00.000Z",
          }),
        ],
      },
    ];

    const output = renderTaskProgress(baseTask(), runs, FIXED_NOW);
    expect(output).toBeDefined();
    expect(output).toContain("/host/worktrees/sandcastle");
    expect(output).toContain("/host/logs/sandcastle.log");
    expect(output).toContain("sess-42");
    expect(output).toContain("abc123");
    // Verification can tell the agent claimed completion before failing.
    expect(output).toContain("claimed completion");
    // The failure kind is projected into board recovery wording.
    expect(output).toContain("agent failure");
  });

  it("distinguishes an infrastructure failure that did not claim completion", () => {
    const runs: TaskProgressRun[] = [
      {
        run: failedRun(),
        events: [
          eventRecord({
            type: "run.error",
            runId: "run-1",
            message:
              "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally.",
            recovery: {
              failureKind: "infrastructure",
              failurePhase: "sandbox-create",
              completionSignalSeen: false,
            },
            timestamp: "2026-07-01T01:05:00.000Z",
          }),
        ],
      },
    ];

    const output = renderTaskProgress(baseTask(), runs, FIXED_NOW);
    expect(output).toContain("infrastructure failure");
    expect(output).toContain("did not claim completion");
  });

  it("renders a minimal run.error event without crashing", () => {
    const runs: TaskProgressRun[] = [
      {
        run: failedRun(),
        events: [
          eventRecord({
            type: "run.error",
            runId: "run-1",
            message: "something went wrong",
            timestamp: "2026-07-01T01:05:00.000Z",
          }),
        ],
      },
    ];

    // No `recovery` field at all — must not throw and must still render.
    const output = renderTaskProgress(baseTask(), runs, FIXED_NOW);
    expect(output).toBeDefined();
    expect(output).toContain("something went wrong");
    expect(output).toContain("## Repository: sandcastle");
    // No recovery lines are invented when evidence is absent.
    expect(output).not.toContain("Preserved worktree");
    expect(output).not.toContain("Failure kind:");
  });
});
