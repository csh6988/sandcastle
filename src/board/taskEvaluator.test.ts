import { describe, expect, it } from "vitest";
import type { BoardRunRecord } from "./BoardStore.js";
import {
  buildBoardEvaluatorPrompt,
  repositoryAgentWorkWasRecorded,
} from "./taskEvaluator.js";
import { DEFAULT_ROLE_PROFILES } from "./roleProfiles.js";
import type { TaskProgressRun } from "./taskProgress.js";
import type { WorkspaceTaskRepositoryResult } from "../runWorkspaceTask.js";
import type { BoardTaskVerificationReport } from "./taskVerification.js";

const failedRun: BoardRunRecord = {
  id: "run-1",
  name: "api",
  agent: "codex",
  sandbox: "docker",
  branch: "codex/board/task/api",
  maxIterations: 1,
  status: "failed",
  createdAt: "2026-07-02T00:00:00.000Z",
  finishedAt: "2026-07-02T00:00:01.000Z",
  commits: 0,
  taskId: "task-1",
  repo: "api",
  error:
    "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally.",
};

const preAgentFailureEvents: TaskProgressRun["events"] = [
  {
    seq: 1,
    event: {
      type: "run.started",
      runId: "run-1",
      name: "api",
      agent: "codex",
      sandbox: "docker",
      branch: "codex/board/task/api",
      maxIterations: 1,
      timestamp: "2026-07-02T00:00:00.000Z",
    },
  },
  {
    seq: 2,
    event: {
      type: "iteration.started",
      runId: "run-1",
      iteration: 1,
      maxIterations: 1,
      timestamp: "2026-07-02T00:00:00.100Z",
    },
  },
  {
    seq: 3,
    event: {
      type: "run.error",
      runId: "run-1",
      message:
        "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally.",
      timestamp: "2026-07-02T00:00:00.900Z",
    },
  },
];

const failedResult: WorkspaceTaskRepositoryResult = {
  task: "Ship the API task.",
  status: "failed",
  branch: "codex/board/task/api",
  commits: [],
  error:
    "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally.",
};

describe("repositoryAgentWorkWasRecorded", () => {
  it("does not treat a pre-agent sandbox failure (run/iteration lifecycle events only) as agent work", () => {
    expect(
      repositoryAgentWorkWasRecorded(
        [{ run: failedRun, events: preAgentFailureEvents }],
        { api: failedResult },
      ),
    ).toBe(false);
  });

  it("treats recorded agent output events as agent work", () => {
    expect(
      repositoryAgentWorkWasRecorded(
        [
          {
            run: failedRun,
            events: [
              ...preAgentFailureEvents,
              {
                seq: 4,
                event: {
                  type: "message.delta",
                  runId: "run-1",
                  messageId: "message-1",
                  text: "Working on the task.",
                  iteration: 1,
                  timestamp: "2026-07-02T00:00:00.500Z",
                },
              },
            ],
          },
        ],
        { api: failedResult },
      ),
    ).toBe(true);
  });

  it("treats repository result stdout or commits as agent work", () => {
    expect(
      repositoryAgentWorkWasRecorded([], {
        api: { ...failedResult, stdout: "did something" },
      }),
    ).toBe(true);
    expect(
      repositoryAgentWorkWasRecorded([], {
        api: { ...failedResult, commits: [{ sha: "abc123" }] },
      }),
    ).toBe(true);
  });
});

describe("buildBoardEvaluatorPrompt", () => {
  const deterministicReport: BoardTaskVerificationReport = {
    taskId: "task-1",
    status: "passed",
    generatedAt: "2026-07-02T00:00:00.000Z",
    repositories: [],
    criteria: [],
    errors: [],
    infrastructureFailures: [],
    suggestedNextAction: "None.",
  };
  const promptInput = {
    task: {
      id: "task-1",
      title: "Ship the API",
      prompt: "Build the API endpoint.",
      status: "running" as const,
      createdAt: "2026-07-02T00:00:00.000Z",
      runIds: [],
    },
    repositoryResults: {},
    runs: [],
    deterministicReport,
    deterministicMarkdown: "evidence markdown",
  };

  it("renders the default Evaluator role profile boundary and skill flows", () => {
    const prompt = buildBoardEvaluatorPrompt(promptInput);
    expect(prompt).toContain(
      "Board role: Evaluator. Stay inside the Evaluator responsibility boundary.",
    );
    expect(prompt).toContain("Allowed actions:");
    expect(prompt).toContain("Do not:");
    for (const flow of DEFAULT_ROLE_PROFILES.evaluator.skillFlows) {
      expect(prompt).toContain(flow);
    }
    expect(prompt).toMatch(/do not copy every installed skill/i);
  });

  it("uses a configured Evaluator role profile override", () => {
    const prompt = buildBoardEvaluatorPrompt(promptInput, {
      ...DEFAULT_ROLE_PROFILES.evaluator,
      promptGuidance: "Prefer verification.md evidence over transcripts.",
      skillFlows: ["review", "qa-verification"],
    });
    expect(prompt).toContain(
      "Prefer verification.md evidence over transcripts.",
    );
    expect(prompt).toContain("qa-verification");
  });
});
