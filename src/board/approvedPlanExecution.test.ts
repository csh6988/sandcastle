import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore, createRunRecorder } from "./BoardStore.js";
import { executeApprovedBoardPlan } from "./approvedPlanExecution.js";
import { workspacePlanToBoardPlan } from "./langGraphTaskRunner.js";
import type { RuntimeEvent } from "../RuntimeEvent.js";
import type {
  WorkspaceTaskPlan,
  WorkspaceTaskRepositoryResult,
} from "../runWorkspaceTask.js";

const started = (repo: string): RuntimeEvent => ({
  type: "run.started",
  runId: "run-1",
  name: repo,
  agent: "claude-code",
  sandbox: "docker",
  branch: `sandcastle/${repo}`,
  maxIterations: 1,
  timestamp: new Date(),
});

const agentText = (text: string): RuntimeEvent => ({
  type: "message.delta",
  runId: "run-1",
  messageId: "message-1",
  text,
  iteration: 1,
  timestamp: new Date(),
});

const commit = (sha: string): RuntimeEvent => ({
  type: "commit.created",
  runId: "run-1",
  sha,
  iteration: 1,
  timestamp: new Date(),
});

const finished = (): RuntimeEvent => ({
  type: "run.finished",
  runId: "run-1",
  commits: [],
  iterationsRun: 1,
  timestamp: new Date(),
});

describe("executeApprovedBoardPlan", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-approved-plan-execution-"));
    store = new BoardStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("executes, verifies, and syncs issue status for an approved plan", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [
        {
          name: "api",
          task: "Ship the API task.",
          issue: {
            title: "Ship API",
            body: "status: ready-for-agent\n\nShip the API task.",
          },
        },
      ],
    };
    const task = store.createTask({
      title: "Approved task",
      prompt: "Run the approved plan.",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: workspacePlanToBoardPlan(plan),
    });
    const workflowUpdates: unknown[] = [];
    const recorders = new Map<string, (event: RuntimeEvent) => void>();
    const evaluatorInputs: string[] = [];

    const result = await executeApprovedBoardPlan({
      store,
      state: {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        plan,
        repositories: {},
        retryCount: 0,
        status: "approved",
      },
      callbacks: {
        onRepoRuntimeEvent: (repo, event) => {
          let recorder = recorders.get(repo);
          if (!recorder) {
            recorder = createRunRecorder(store, { taskId: task.id, repo });
            recorders.set(repo, recorder);
          }
          recorder(event);
        },
      },
      maxRepoRetries: 0,
      abortControllersByTask: new Map(),
      throwIfCancelled: () => {},
      updateWorkflow: (workflow) => workflowUpdates.push(workflow),
      execute: async ({ onRepoRuntimeEvent }) => {
        onRepoRuntimeEvent("api", started("api"));
        onRepoRuntimeEvent("api", agentText("<promise>COMPLETE</promise>"));
        onRepoRuntimeEvent("api", commit("abc123"));
        onRepoRuntimeEvent("api", finished());
        return {
          api: {
            task: "Ship the API task.",
            status: "success",
            branch: "sandcastle/api",
            commits: [{ sha: "abc123" }],
            stdout: "<promise>COMPLETE</promise>",
          },
        } satisfies Record<string, WorkspaceTaskRepositoryResult>;
      },
      evaluate: async (input) => {
        evaluatorInputs.push(input.deterministicMarkdown);
        return {
          status: "passed",
          markdown:
            "Evaluator reviewed the recorded completion signal, commit, and deterministic evidence.",
        };
      },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      verificationStatus: "passed",
      repositories: {
        api: {
          status: "success",
          commits: [{ sha: "abc123" }],
        },
      },
    });
    expect(workflowUpdates).toContainEqual(
      expect.objectContaining({
        status: "verifying",
        currentPhase: "verifying",
        message: "Preparing deterministic verification evidence.",
      }),
    );
    expect(workflowUpdates).toContainEqual(
      expect.objectContaining({
        status: "verifying",
        currentPhase: "verifying",
        message: "Running Evaluator agent verification.",
      }),
    );
    expect(workflowUpdates).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        currentPhase: "verifying",
        verificationStatus: "passed",
        message: "Workspace task verified.",
      }),
    );
    expect(evaluatorInputs[0]).toContain("Status: passed");
    expect(store.readTaskVerification(task.id)).toContain("Status: passed");
    expect(store.readTaskVerification(task.id)).toContain(
      "## Evaluator output",
    );
    expect(store.readTaskVerification(task.id)).toContain(
      "Deterministic structured evidence",
    );
    expect(store.readTaskIssue(task.id, "api")).toContain("status: succeeded");
  });

  it("marks successful execution as needing verification when PRD integration evidence is missing", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [
        {
          name: "web",
          task: "Ship the UI task.",
          issue: {
            title: "Ship UI",
            body: `status: ready-for-agent

## Acceptance criteria

- [ ] 手动验证权限隐藏、接口返回和浏览器页面展示
`,
          },
        },
      ],
    };
    const task = store.createTask({
      title: "Approved PRD task",
      prompt: "Run the approved PRD plan.",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: workspacePlanToBoardPlan(plan),
    });
    const workflowUpdates: unknown[] = [];
    const recorders = new Map<string, (event: RuntimeEvent) => void>();
    const evaluatorInputs: Array<{
      readonly progressMarkdown?: string;
      readonly deterministicMarkdown: string;
    }> = [];

    const result = await executeApprovedBoardPlan({
      store,
      state: {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        plan,
        repositories: {},
        retryCount: 0,
        status: "approved",
      },
      callbacks: {
        onRepoRuntimeEvent: (repo, event) => {
          let recorder = recorders.get(repo);
          if (!recorder) {
            recorder = createRunRecorder(store, { taskId: task.id, repo });
            recorders.set(repo, recorder);
          }
          recorder(event);
        },
      },
      maxRepoRetries: 0,
      abortControllersByTask: new Map(),
      throwIfCancelled: () => {},
      updateWorkflow: (workflow) => {
        workflowUpdates.push(workflow);
        store.updateTask(task.id, {
          workflow: {
            ...workflow,
            updatedAt: "2026-07-01T00:02:00.000Z",
          },
        });
      },
      execute: async ({ onRepoRuntimeEvent }) => {
        onRepoRuntimeEvent("web", started("web"));
        onRepoRuntimeEvent("web", agentText("npm run build passed"));
        onRepoRuntimeEvent("web", finished());
        return {
          web: {
            task: "Ship the UI task.",
            status: "success",
            branch: "sandcastle/web",
            commits: [],
            stdout: "npm run build passed\n<promise>COMPLETE</promise>",
          },
        } satisfies Record<string, WorkspaceTaskRepositoryResult>;
      },
      evaluate: async (input) => {
        evaluatorInputs.push({
          progressMarkdown: input.progressMarkdown,
          deterministicMarkdown: input.deterministicMarkdown,
        });
        return {
          status: "needs-verification",
          markdown:
            "Evaluator found no recorded browser/backend integration evidence for the PRD acceptance criterion.",
          repositoryStatuses: { web: "needs-verification" },
        };
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      verificationStatus: "needs-verification",
    });
    expect(workflowUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        currentPhase: "verifying",
        verificationStatus: "needs-verification",
        error:
          "Verification incomplete: PRD acceptance criteria still need recorded integration or manual evidence.",
      }),
    );
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "failed",
      currentPhase: "verifying",
      verificationStatus: "needs-verification",
      error:
        "Verification incomplete: PRD acceptance criteria still need recorded integration or manual evidence.",
    });
    expect(store.readTaskVerification(task.id)).toContain(
      "Status: needs-verification",
    );
    expect(store.readTaskVerification(task.id)).toContain(
      "Evaluator found no recorded browser/backend integration evidence",
    );
    expect(evaluatorInputs[0]?.progressMarkdown).toContain(
      "# Board Execution Progress",
    );
    expect(evaluatorInputs[0]?.deterministicMarkdown).toContain(
      "No browser/backend integration evidence was recorded",
    );
    expect(store.readTaskIssue(task.id, "web")).toContain(
      "status: needs-verification",
    );
  });

  it("retries only failed repositories and keeps earlier successful results", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [
        { name: "api", task: "Ship the API task." },
        { name: "web", task: "Ship the UI task." },
      ],
    };
    const task = store.createTask({
      title: "Partial failure",
      prompt: "Run the approved plan.",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: workspacePlanToBoardPlan(plan),
    });
    const executedPlans: string[][] = [];

    const success = (name: string): WorkspaceTaskRepositoryResult => ({
      task: `Ship the ${name} task.`,
      status: "success",
      branch: `sandcastle/${name}`,
      commits: [{ sha: `${name}-sha` }],
      stdout: "<promise>COMPLETE</promise>",
    });

    const result = await executeApprovedBoardPlan({
      store,
      state: {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        plan,
        repositories: {},
        retryCount: 0,
        status: "approved",
      },
      callbacks: { onRepoRuntimeEvent: () => {} },
      maxRepoRetries: 1,
      abortControllersByTask: new Map(),
      throwIfCancelled: () => {},
      updateWorkflow: () => {},
      execute: async ({
        plan: executedPlan,
      }): Promise<Record<string, WorkspaceTaskRepositoryResult>> => {
        executedPlans.push(executedPlan.repositories.map((repo) => repo.name));
        if (executedPlans.length === 1) {
          return {
            api: success("api"),
            web: {
              task: "Ship the UI task.",
              status: "failed",
              branch: "sandcastle/web",
              commits: [],
              error: "Agent idle for 600 seconds",
            },
          };
        }
        return { web: success("web") };
      },
      evaluate: async () => ({
        status: "passed",
        markdown: "Both repositories delivered.",
      }),
    });

    expect(executedPlans).toEqual([["api", "web"], ["web"]]);
    expect(result).toMatchObject({
      status: "succeeded",
      verificationStatus: "passed",
      repositories: {
        api: { status: "success", commits: [{ sha: "api-sha" }] },
        web: { status: "success", commits: [{ sha: "web-sha" }] },
      },
    });
  });

  it("executes at least once when recovering with an exhausted retry count", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [{ name: "sandcastle", task: "Ship the task." }],
    };
    const task = store.createTask({
      title: "Recovered task",
      prompt: "Continue the approved plan.",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: workspacePlanToBoardPlan(plan),
    });
    let executeCalls = 0;

    const result = await executeApprovedBoardPlan({
      store,
      state: {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        plan,
        repositories: {},
        // A previous failed execution left the cumulative retry count above
        // the retry budget; recovery must still execute the plan.
        retryCount: 2,
        status: "running",
      },
      callbacks: { onRepoRuntimeEvent: () => {} },
      maxRepoRetries: 1,
      abortControllersByTask: new Map(),
      throwIfCancelled: () => {},
      updateWorkflow: () => {},
      execute: async () => {
        executeCalls++;
        return {
          sandcastle: {
            task: "Ship the task.",
            status: "success",
            branch: "sandcastle/sandcastle",
            commits: [{ sha: "abc123" }],
            stdout: "<promise>COMPLETE</promise>",
          },
        } satisfies Record<string, WorkspaceTaskRepositoryResult>;
      },
      evaluate: async () => ({
        status: "passed",
        markdown: "Recovered delivery verified.",
      }),
    });

    expect(executeCalls).toBe(1);
    expect(result).toMatchObject({
      status: "succeeded",
      verificationStatus: "passed",
      repositories: { sandcastle: { status: "success" } },
    });
  });

  it("skips the evaluator and reports failed pre-agent execution clearly", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [
        {
          name: "api",
          task: "Ship the API task.",
        },
      ],
    };
    const task = store.createTask({
      title: "Pre-agent failure",
      prompt: "Run the approved plan.",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: workspacePlanToBoardPlan(plan),
    });
    let evaluatorCalls = 0;

    const result = await executeApprovedBoardPlan({
      store,
      state: {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        plan,
        repositories: {},
        retryCount: 0,
        status: "approved",
      },
      callbacks: { onRepoRuntimeEvent: () => {} },
      maxRepoRetries: 0,
      abortControllersByTask: new Map(),
      throwIfCancelled: () => {},
      updateWorkflow: () => {},
      execute: async () => ({
        api: {
          task: "Ship the API task.",
          status: "failed",
          branch: "sandcastle/api",
          commits: [],
          error: 'No such image: "sandcastle:sandcastle"',
        },
      }),
      evaluate: async () => {
        evaluatorCalls++;
        return {
          status: "passed",
          markdown: "should not run",
        };
      },
    });

    expect(evaluatorCalls).toBe(0);
    expect(result).toMatchObject({
      status: "failed",
      verificationStatus: "needs-recovery",
    });
    expect(result.error).toContain("No such image");
    expect(store.readTaskVerification(task.id)).toContain(
      "Evaluator agent skipped",
    );
    expect(store.readTaskVerification(task.id)).toContain("No such image");
    expect(store.readTaskVerification(task.id)).toContain(
      "no repository agent activity was recorded",
    );
  });

  it("does not launch the evaluator when the sandbox failed before any agent work, even with lifecycle runtime events", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [
        {
          name: "sandcastle",
          task: "Ship the task.",
        },
      ],
    };
    const task = store.createTask({
      title: "Sandbox create failure",
      prompt: "Run the approved plan.",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: workspacePlanToBoardPlan(plan),
    });
    const createFailure =
      "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally. Build it first with 'sandcastle docker build-image'.";
    const recorders = new Map<string, (event: RuntimeEvent) => void>();
    let evaluatorCalls = 0;

    const result = await executeApprovedBoardPlan({
      store,
      state: {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        plan,
        repositories: {},
        retryCount: 0,
        status: "approved",
      },
      callbacks: {
        onRepoRuntimeEvent: (repo, event) => {
          let recorder = recorders.get(repo);
          if (!recorder) {
            recorder = createRunRecorder(store, { taskId: task.id, repo });
            recorders.set(repo, recorder);
          }
          recorder(event);
        },
      },
      maxRepoRetries: 1,
      abortControllersByTask: new Map(),
      throwIfCancelled: () => {},
      updateWorkflow: () => {},
      execute: async ({ onRepoRuntimeEvent }) => {
        onRepoRuntimeEvent("sandcastle", started("sandcastle"));
        onRepoRuntimeEvent("sandcastle", {
          type: "iteration.started",
          runId: "run-1",
          iteration: 1,
          maxIterations: 1,
          timestamp: new Date(),
        });
        onRepoRuntimeEvent("sandcastle", {
          type: "run.error",
          runId: "run-1",
          message: createFailure,
          timestamp: new Date(),
        });
        return {
          sandcastle: {
            task: "Ship the task.",
            status: "failed",
            branch: "codex/board/task/sandcastle",
            commits: [],
            error: createFailure,
          },
        } satisfies Record<string, WorkspaceTaskRepositoryResult>;
      },
      evaluate: async () => {
        evaluatorCalls++;
        return { status: "passed", markdown: "should not run" };
      },
    });

    expect(evaluatorCalls).toBe(0);
    expect(result).toMatchObject({
      status: "failed",
      verificationStatus: "needs-recovery",
    });
    expect(result.error).toContain("Provider 'docker' create failed");
    expect(store.readTaskVerification(task.id)).toContain(
      "Provider 'docker' create failed",
    );
    expect(store.readTaskIssue(task.id, "sandcastle")).toContain(
      "status: needs-recovery",
    );
  });
});
