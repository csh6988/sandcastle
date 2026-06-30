import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import {
  createLangGraphTaskWorkflow,
  langGraphInterruptPhase,
  type LangGraphPlanResult,
} from "./langGraphTaskRunner.js";
import type { RunEvent } from "../RunEvent.js";
import type { BoardTaskPlan } from "./BoardStore.js";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

const started = (name: string, repo: string): RunEvent => ({
  type: "run-started",
  name,
  agent: "claude-code",
  model: "claude-opus-4-8",
  sandbox: "docker",
  branch: `sandcastle/${repo}`,
  maxIterations: 1,
  timestamp: new Date(),
});

const finished = (): RunEvent => ({
  type: "run-finished",
  iterationsRun: 1,
  timestamp: new Date(),
});

const failed = (message: string): RunEvent => ({
  type: "run-failed",
  message,
  timestamp: new Date(),
});

describe("createLangGraphTaskWorkflow", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-langgraph-"));
    store = new BoardStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pauses at each interactive phase before approval and execution", async () => {
    const plan: WorkspaceTaskPlan = {
      technicalPlan: "review before execute",
      repositories: [
        {
          name: "web",
          task: "add page",
          issue: {
            title: "Add page",
            body: "Implement the planned page.",
          },
        },
      ],
    };
    const calls: string[] = [];
    const workflowStatuses: string[] = [];
    const startedPhases: string[] = [];
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      onPhaseStarted: ({ phase }) => startedPhases.push(phase),
      planFromPhase: async () => {
        calls.push("import-plan");
        return { plan, plannerStdout: "ok" };
      },
      plan: async () => {
        calls.push("background-plan");
        return { plan, plannerStdout: "ok" };
      },
      execute: async ({ onRepoRunEvent }) => {
        calls.push("execute");
        onRepoRunEvent("web", started("web", "web"));
        onRepoRunEvent("web", finished());
        return {
          web: {
            task: "add page",
            status: "success",
            branch: "sandcastle/web",
            commits: [],
          },
        };
      },
    });

    const task = store.createTask({
      title: "Add page",
      prompt: "Please add a page",
    });
    const unsubscribe = store.subscribe((change) => {
      if (change.kind === "task-updated" && change.task.workflow?.status) {
        workflowStatuses.push(change.task.workflow.status);
      }
    });
    const reportedPlans: BoardTaskPlan[] = [];
    const runResult = await workflow.run({
      taskId: task.id,
      title: "Add page",
      prompt: "Please add a page",
      onPlan: (p) => reportedPlans.push(p),
      onRepoRunEvent: () => {},
    });

    expect(runResult.status).toBe("awaiting-phase-completion");
    expect(runResult.phase).toBe("classifying");
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "classifying",
      currentPhase: "classifying",
    });
    expect(startedPhases).toEqual(["classifying"]);
    expect(calls).toEqual([]);

    const classifying = await workflow.completePhase(task.id, "classifying");
    expect(classifying?.status).toBe("awaiting-phase-completion");
    expect(classifying?.phase).toBe("aligning-prd");
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "aligning-prd",
      currentPhase: "aligning-prd",
    });
    expect(startedPhases).toEqual(["classifying", "aligning-prd"]);
    expect(calls).toEqual([]);

    const aligning = await workflow.completePhase(task.id, "aligning-prd");
    expect(aligning?.status).toBe("awaiting-phase-completion");
    expect(aligning?.phase).toBe("technical-planning");
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "technical-planning",
      currentPhase: "technical-planning",
    });
    expect(startedPhases).toEqual([
      "classifying",
      "aligning-prd",
      "technical-planning",
    ]);
    expect(calls).toEqual([]);

    const technical = await workflow.completePhase(
      task.id,
      "technical-planning",
    );
    expect(technical?.status).toBe("awaiting-phase-completion");
    expect(technical?.phase).toBe("creating-issues");
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "creating-issues",
      currentPhase: "creating-issues",
    });
    expect(startedPhases).toEqual([
      "classifying",
      "aligning-prd",
      "technical-planning",
      "creating-issues",
    ]);
    expect(reportedPlans).toEqual([]);

    const issues = await workflow.completePhase(task.id, "creating-issues");
    expect(issues?.status).toBe("awaiting-approval");
    expect(calls).toEqual(["import-plan"]);
    expect(reportedPlans).toEqual([
      {
        technicalPlan: "review before execute",
        repositories: [
          {
            name: "web",
            task: "add page",
            issue: {
              title: "Add page",
              body: "Implement the planned page.",
            },
          },
        ],
      },
    ]);
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "awaiting-approval",
      currentPhase: "awaiting-approval",
    });
    expect(store.getTask(task.id)?.plan?.repositories[0]?.issue?.title).toBe(
      "Add page",
    );
    expect(workflowStatuses).toEqual(
      expect.arrayContaining([
        "classifying",
        "aligning-prd",
        "technical-planning",
        "creating-issues",
        "awaiting-approval",
      ]),
    );

    const resumed = await workflow.resume(task.id, "approve");
    unsubscribe();

    expect(resumed?.repositories.web?.status).toBe("success");
    expect(calls).toEqual(["import-plan", "execute"]);
    expect(store.getTask(task.id)?.status).toBe("succeeded");
  });

  it("retries failed repository execution once before aggregating the task result", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [{ name: "api", task: "fix endpoint" }],
    };
    let attempts = 0;
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      maxRepoRetries: 1,
      planFromPhase: async () => ({ plan, plannerStdout: "ok" }),
      plan: async () => {
        throw new Error("background planner should not start");
      },
      execute: async ({ onRepoRunEvent }) => {
        attempts += 1;
        onRepoRunEvent("api", started("api", "api"));
        if (attempts === 1) {
          onRepoRunEvent("api", failed("temporary failure"));
          return {
            api: {
              task: "fix endpoint",
              status: "failed",
              branch: "sandcastle/api",
              commits: [],
              error: "temporary failure",
            },
          };
        }
        onRepoRunEvent("api", finished());
        return {
          api: {
            task: "fix endpoint",
            status: "success",
            branch: "sandcastle/api",
            commits: [],
          },
        };
      },
    });

    const task = store.createTask({ title: "Fix endpoint", prompt: "Fix it" });
    await workflow.run({
      taskId: task.id,
      title: "Fix endpoint",
      prompt: "Fix it",
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");
    await workflow.completePhase(task.id, "creating-issues");

    const result = await workflow.resume(task.id, "approve");

    expect(attempts).toBe(2);
    expect(result?.repositories.api?.status).toBe("success");
  });

  it("marks the workflow as validating while the workspace plan is imported after creating-issues", async () => {
    let resolvePlan!: (value: {
      plan: WorkspaceTaskPlan;
      plannerStdout: string;
    }) => void;
    const planStarted: Promise<{
      plan: WorkspaceTaskPlan;
      plannerStdout: string;
    }> = new Promise((resolve) => {
      resolvePlan = resolve;
    });
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      planFromPhase: async () => planStarted,
      plan: async () => {
        throw new Error("background planner should not start");
      },
      execute: async () => ({}),
    });
    const task = store.createTask({
      title: "Generate issues",
      prompt: "do it",
    });
    await workflow.run({
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");

    const completing = workflow.completePhase(task.id, "creating-issues");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "planning",
      currentPhase: "creating-issues",
      substatus: "validating-workspace-plan",
      message: "Importing workspace plan from the completed phase.",
    });

    resolvePlan({
      plan: { repositories: [{ name: "web", task: "add page" }] },
      plannerStdout: "ok",
    });
    await completing;
  });

  it("uses a plan emitted by the creating-issues interactive phase without starting the background planner", async () => {
    const calls: string[] = [];
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      planFromPhase: async () => ({
        plan: {
          technicalPlan: "Use the interactive issue plan.",
          repositories: [
            {
              name: "web",
              task: "Implement generated issue",
              issue: {
                title: "Implement generated issue",
                body: "Status: ready-for-agent\n\nDo it.",
              },
            },
          ],
        },
        plannerStdout: "interactive",
      }),
      plan: async () => {
        calls.push("background-plan");
        return { plan: { repositories: [] }, plannerStdout: "ok" };
      },
      execute: async () => ({}),
    });
    const task = store.createTask({
      title: "Use interactive plan",
      prompt: "do it",
    });
    store.updateTask(task.id, { status: "running" });
    await workflow.run({
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");

    const result = await workflow.completePhase(task.id, "creating-issues");

    expect(result?.status).toBe("awaiting-approval");
    expect(calls).toEqual([]);
    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      plan: {
        technicalPlan: "Use the interactive issue plan.",
        repositories: [
          {
            name: "web",
            issue: { title: "Implement generated issue" },
          },
        ],
      },
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
      },
    });
  });

  it("returns to fixing-workspace-plan when the imported creating-issues plan duplicates repositories", async () => {
    let phasePlan: LangGraphPlanResult = {
      plan: {
        repositories: [
          { name: "vocmngweb", task: "Add first issue" },
          { name: "vocmngweb", task: "Add second issue" },
        ],
      },
      plannerStdout: "interactive",
    };
    let executeCalls = 0;
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      planFromPhase: async () => phasePlan,
      plan: async () => {
        throw new Error("background planner should not start");
      },
      execute: async () => {
        executeCalls++;
        return {};
      },
    });
    const task = store.createTask({
      title: "Generate issues",
      prompt: "do it",
    });
    await workflow.run({
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");

    const result = await workflow.completePhase(task.id, "creating-issues");

    expect(result?.status).toBe("awaiting-phase-completion");
    expect(result?.phase).toBe("creating-issues");
    expect(executeCalls).toBe(0);
    expect(store.getTask(task.id)?.plan).toBeUndefined();
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "creating-issues",
      currentPhase: "creating-issues",
      substatus: "fixing-workspace-plan",
      message:
        'Workspace plan contains duplicate repository "vocmngweb". Combine same-repository issues into one repository entry or use distinct repository names.',
    });

    phasePlan = {
      plan: {
        repositories: [{ name: "vocmngweb", task: "Add combined issue" }],
      },
      plannerStdout: "interactive",
    };

    const repaired = await workflow.completePhase(task.id, "creating-issues");

    expect(repaired?.status).toBe("awaiting-approval");
    expect(store.getTask(task.id)?.workflow?.status).toBe("awaiting-approval");
    expect(store.getTask(task.id)?.plan?.repositories).toEqual([
      { name: "vocmngweb", task: "Add combined issue" },
    ]);
  });

  it("stays interactive when the creating-issues phase does not emit an importable plan", async () => {
    let phasePlan: LangGraphPlanResult | undefined;
    const calls: string[] = [];
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      planFromPhase: async () => phasePlan,
      plan: async () => {
        calls.push("background-plan");
        return { plan: { repositories: [] }, plannerStdout: "ok" };
      },
      execute: async () => ({}),
    });
    const task = store.createTask({
      title: "Repair interactive plan",
      prompt: "do it",
    });
    store.updateTask(task.id, { status: "running" });
    await workflow.run({
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");

    const firstAttempt = await workflow.completePhase(
      task.id,
      "creating-issues",
    );

    expect(firstAttempt?.status).toBe("awaiting-phase-completion");
    expect(firstAttempt?.phase).toBe("creating-issues");
    expect(calls).toEqual([]);
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "creating-issues",
      currentPhase: "creating-issues",
      substatus: "fixing-workspace-plan",
      message:
        "Board could not import a workspace plan from this phase. Fix the <workspace_plan> block, then complete the phase again.",
    });

    phasePlan = {
      plan: { repositories: [{ name: "web", task: "add page" }] },
      plannerStdout: "interactive",
    };
    const secondAttempt = await workflow.completePhase(
      task.id,
      "creating-issues",
    );

    expect(secondAttempt?.status).toBe("awaiting-approval");
    expect(calls).toEqual([]);
    expect(store.getTask(task.id)?.workflow?.status).toBe("awaiting-approval");
  });

  it("cancels issue generation before the planner result moves to approval", async () => {
    let resolvePlan!: (value: {
      plan: WorkspaceTaskPlan;
      plannerStdout: string;
    }) => void;
    const planStarted: Promise<{
      plan: WorkspaceTaskPlan;
      plannerStdout: string;
    }> = new Promise((resolve) => {
      resolvePlan = resolve;
    });
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      planFromPhase: async () => planStarted,
      plan: async () => {
        throw new Error("background planner should not start");
      },
      execute: async () => ({}),
    });
    const task = store.createTask({ title: "Cancel issues", prompt: "do it" });
    await workflow.run({
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");
    const completing = workflow.completePhase(task.id, "creating-issues");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await workflow.cancel(task.id);
    resolvePlan({
      plan: { repositories: [{ name: "web", task: "add page" }] },
      plannerStdout: "ok",
    });

    await expect(completing).rejects.toThrow("Task cancelled.");
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "Task cancelled.",
      workflow: {
        status: "failed",
        currentPhase: "creating-issues",
        error: "Task cancelled.",
      },
    });
  });

  it("aborts repository execution and keeps the task cancelled", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [{ name: "api", task: "fix endpoint" }],
    };
    let executionSignal: AbortSignal | undefined;
    let markExecutionStarted!: () => void;
    let releaseExecution!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executionBlocked = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      planFromPhase: async () => ({ plan, plannerStdout: "ok" }),
      plan: async () => {
        throw new Error("background planner should not start");
      },
      execute: async ({ signal }) => {
        executionSignal = signal;
        markExecutionStarted();
        await executionBlocked;
        return {
          api: {
            task: "fix endpoint",
            status: "success",
            branch: "sandcastle/api",
            commits: [],
          },
        };
      },
    });
    const task = store.createTask({ title: "Fix endpoint", prompt: "Fix it" });
    await workflow.run({
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });
    await workflow.completePhase(task.id, "classifying");
    await workflow.completePhase(task.id, "aligning-prd");
    await workflow.completePhase(task.id, "technical-planning");
    await workflow.completePhase(task.id, "creating-issues");

    const resuming = workflow.resume(task.id, "approve");
    await executionStarted;
    await workflow.cancel(task.id);
    releaseExecution();

    expect(executionSignal?.aborted).toBe(true);
    await expect(resuming).rejects.toThrow("Task cancelled.");
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "Task cancelled.",
      workflow: {
        status: "failed",
        currentPhase: "running",
        error: "Task cancelled.",
      },
    });
  });

  it("recovers running execution with the board progress document in the prompt", async () => {
    const plan: BoardTaskPlan = {
      repositories: [{ name: "web", task: "finish the UI" }],
    };
    let recoveredPrompt = "";
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => {
        throw new Error("background planner should not start");
      },
      execute: async ({ prompt }) => {
        recoveredPrompt = prompt;
        return {
          web: {
            task: "finish the UI",
            status: "success",
            branch: "sandcastle/web",
            commits: [],
          },
        };
      },
    });
    const task = store.createTask({
      title: "Recover execution",
      prompt: "Finish it",
    });
    store.updateTask(task.id, {
      status: "failed",
      error: "Task cancelled.",
      plan,
      workflow: {
        status: "failed",
        currentPhase: "running",
        error: "Task cancelled.",
        checkpointThreadId: task.id,
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    await workflow.recoverPhase(task.id);

    expect(recoveredPrompt).toContain("Board progress document:");
    expect(recoveredPrompt).toContain("# Board Execution Progress");
    expect(recoveredPrompt).toContain("## Repository: web");
    expect(recoveredPrompt).toContain("Status: pending");
    expect(recoveredPrompt).toContain("Original task prompt:\nFinish it");
  });

  it("recognizes thrown LangGraph interrupt payloads as phase pauses", () => {
    const interruptPayload = [
      {
        id: "interrupt-id",
        value: {
          taskId: "task-1",
          title: "Fix endpoint",
          phase: "aligning-prd",
        },
      },
    ];

    expect(langGraphInterruptPhase(interruptPayload)).toBe("aligning-prd");
    expect(
      langGraphInterruptPhase(new Error(JSON.stringify(interruptPayload))),
    ).toBe("aligning-prd");
  });

  it("recovers a failed task whose error is a persisted phase interrupt", async () => {
    const startedPhases: string[] = [];
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      onPhaseStarted: ({ phase }) => startedPhases.push(phase),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async () => ({}),
    });
    const task = store.createTask({ title: "Recover me", prompt: "do it" });
    const interruptPayload = [
      {
        id: "interrupt-id",
        value: {
          taskId: task.id,
          title: task.title,
          phase: "aligning-prd",
        },
      },
    ];
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error: JSON.stringify(interruptPayload),
      workflow: {
        status: "failed",
        currentPhase: "aligning-prd",
        checkpointThreadId: task.id,
        phaseSessions: {
          "aligning-prd": {
            taskId: task.id,
            phase: "aligning-prd",
            pid: 123,
            status: "exited",
            startedAt: "2026-06-26T06:59:00.000Z",
            exitedAt: "2026-06-26T07:00:00.000Z",
            exitCode: 1,
          },
        },
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(result?.status).toBe("awaiting-phase-completion");
    expect(result?.phase).toBe("aligning-prd");
    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      workflow: {
        status: "aligning-prd",
        currentPhase: "aligning-prd",
        checkpointThreadId: task.id,
        message: "Recovered failed workflow phase.",
        phaseSessions: {
          "aligning-prd": { status: "exited", exitCode: 1 },
        },
      },
    });
    expect(store.getTask(task.id)?.error).toBeUndefined();
    expect(store.getTask(task.id)?.finishedAt).toBeUndefined();
    expect(startedPhases).toEqual(["aligning-prd"]);
  });

  it("recovers a failed approved execution by rerunning the stored plan", async () => {
    let executeCalls = 0;
    let recoveredPlan: WorkspaceTaskPlan | undefined;
    let recoveredPrompt = "";
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async ({ prompt, plan, onRepoRunEvent }) => {
        executeCalls++;
        recoveredPrompt = prompt;
        recoveredPlan = plan;
        onRepoRunEvent("web", started("web", "web"));
        onRepoRunEvent("web", finished());
        return {
          web: {
            task: "execute it",
            status: "success",
            branch: "sandcastle/web",
            commits: [],
          },
        };
      },
    });
    const task = store.createTask({ title: "Failed", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error: "One or more repository executions failed.",
      plan: {
        technicalPlan: "approved work",
        repositories: [{ name: "web", task: "execute it" }],
      },
      workflow: {
        status: "failed",
        currentPhase: "running",
        checkpointThreadId: task.id,
        phaseSessions: {
          "creating-issues": {
            taskId: task.id,
            phase: "creating-issues",
            pid: 123,
            status: "exited",
            startedAt: "2026-06-26T06:50:00.000Z",
            exitedAt: "2026-06-26T06:55:00.000Z",
            exitCode: 0,
          },
        },
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(executeCalls).toBe(1);
    expect(result?.repositories.web?.status).toBe("success");
    expect(recoveredPrompt).toContain(
      "Continue the approved Board workspace execution after an interruption.",
    );
    expect(recoveredPrompt).toContain("Original task prompt:");
    expect(recoveredPrompt).toContain("do it");
    expect(recoveredPlan).toMatchObject({
      technicalPlan: "approved work",
      repositories: [{ name: "web", task: "execute it" }],
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "succeeded",
      finishedAt: expect.any(String),
      workflow: {
        status: "succeeded",
        currentPhase: "running",
      },
    });
    expect(store.getTask(task.id)?.error).toBeUndefined();
  });

  it("merges duplicate repository entries when recovering approved execution", async () => {
    let executeCalls = 0;
    let recoveredPlan: WorkspaceTaskPlan | undefined;
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async ({ plan, onRepoRunEvent }) => {
        executeCalls++;
        recoveredPlan = plan;
        onRepoRunEvent("vocmngweb", started("vocmngweb", "vocmngweb"));
        onRepoRunEvent("vocmngweb", finished());
        return {
          vocmngweb: {
            task: "combined",
            status: "success",
            branch: "sandcastle/vocmngweb",
            commits: [],
          },
        };
      },
    });
    const task = store.createTask({ title: "Fix duplicate", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error: "Interrupted when the board server stopped or restarted.",
      plan: {
        repositories: [
          { name: "vocmngweb", task: "first issue" },
          { name: "vocmngweb", task: "second issue" },
        ],
      },
      workflow: {
        status: "failed",
        message: "Executing approved workspace plan.",
        checkpointThreadId: task.id,
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(executeCalls).toBe(1);
    expect(result?.repositories.vocmngweb?.status).toBe("success");
    expect(recoveredPlan?.repositories).toHaveLength(1);
    expect(recoveredPlan?.repositories[0]).toMatchObject({
      name: "vocmngweb",
    });
    expect(recoveredPlan?.repositories[0]?.task).toContain("first issue");
    expect(recoveredPlan?.repositories[0]?.task).toContain("second issue");
    expect(store.getTask(task.id)).toMatchObject({
      status: "succeeded",
      workflow: {
        status: "succeeded",
        currentPhase: "running",
      },
    });
    expect(store.getTask(task.id)?.plan?.repositories).toHaveLength(1);
    expect(store.getTask(task.id)?.error).toBeUndefined();
  });

  it("recovers a cancelled approved execution in the same workflow process", async () => {
    let executeCalls = 0;
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async ({ onRepoRunEvent }) => {
        executeCalls++;
        onRepoRunEvent("web", started("web", "web"));
        onRepoRunEvent("web", finished());
        return {
          web: {
            task: "execute it",
            status: "success",
            branch: "sandcastle/web",
            commits: [],
          },
        };
      },
    });
    const task = store.createTask({ title: "Cancelled", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      plan: {
        repositories: [{ name: "web", task: "execute it" }],
      },
      workflow: {
        status: "running",
        currentPhase: "running",
        message: "Executing approved workspace plan.",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    await workflow.cancel(task.id);
    const result = await workflow.recoverPhase(task.id);

    expect(executeCalls).toBe(1);
    expect(result?.repositories.web?.status).toBe("success");
    expect(store.getTask(task.id)).toMatchObject({
      status: "succeeded",
      workflow: {
        status: "succeeded",
        currentPhase: "running",
      },
    });
  });

  it("treats older interrupted execution task records as recoverable execution", () => {
    const task = store.createTask({ title: "Interrupted", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      error: "Interrupted when the board server stopped or restarted.",
      plan: {
        repositories: [{ name: "web", task: "execute it" }],
      },
      workflow: {
        status: "failed",
        message: "Executing approved workspace plan.",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    return expect(
      createLangGraphTaskWorkflow({
        store,
        checkpointPath: join(dir, "workflows.sqlite"),
        plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
        execute: async () => ({}),
      }).recoverPhase(task.id),
    ).resolves.toMatchObject({
      repositories: {},
    });
  });

  it("recovers a failed transient workflow error to the persisted interactive phase", async () => {
    const startedPhases: string[] = [];
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      onPhaseStarted: ({ phase }) => startedPhases.push(phase),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async () => ({}),
    });
    const task = store.createTask({ title: "Retry planner", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error:
        "runWorkspace repository failed on branch sandcastle/planner: Agent idle for 90 seconds",
      workflow: {
        status: "failed",
        currentPhase: "creating-issues",
        checkpointThreadId: task.id,
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(result?.phase).toBe("creating-issues");
    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        message: "Recovered failed workflow phase.",
      },
    });
    expect(startedPhases).toEqual(["creating-issues"]);
  });

  it("recovers older transient workflow failures from the latest phase session when currentPhase was lost", async () => {
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async () => ({}),
    });
    const task = store.createTask({
      title: "Old failed task",
      prompt: "do it",
    });
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error:
        "runWorkspace repository failed on branch sandcastle/planner: Agent idle for 90 seconds",
      workflow: {
        status: "failed",
        checkpointThreadId: task.id,
        phaseSessions: {
          classifying: {
            taskId: task.id,
            phase: "classifying",
            pid: 111,
            status: "exited",
            startedAt: "2026-06-26T06:00:00.000Z",
            exitedAt: "2026-06-26T06:05:00.000Z",
            exitCode: 0,
          },
          "creating-issues": {
            taskId: task.id,
            phase: "creating-issues",
            pid: 222,
            status: "exited",
            startedAt: "2026-06-26T06:30:00.000Z",
            exitedAt: "2026-06-26T06:35:00.000Z",
            exitCode: 0,
          },
        },
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(result?.phase).toBe("creating-issues");
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "creating-issues",
      currentPhase: "creating-issues",
      phaseSessions: {
        classifying: { status: "exited" },
        "creating-issues": { status: "exited" },
      },
    });
  });

  it("recovers old planner idle failures without phase metadata to creating-issues", async () => {
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async () => ({}),
    });
    const task = store.createTask({
      title: "Old planner timeout",
      prompt: "create issues",
    });
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error:
        "runWorkspace repository failed on branch sandcastle/planner: Agent idle for 90 seconds — no output received.",
      workflow: {
        status: "failed",
        checkpointThreadId: task.id,
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(result?.phase).toBe("creating-issues");
    expect(store.getTask(task.id)?.workflow).toMatchObject({
      status: "creating-issues",
      currentPhase: "creating-issues",
    });
  });

  it("recovers interrupted approval tasks back to awaiting approval", async () => {
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async () => ({ plan: { repositories: [] }, plannerStdout: "ok" }),
      execute: async () => ({}),
    });
    const task = store.createTask({
      title: "Recover approval",
      prompt: "do it",
    });
    store.updateTask(task.id, {
      status: "failed",
      finishedAt: "2026-06-26T07:00:00.000Z",
      error: "Interrupted when the board server stopped or restarted.",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        checkpointThreadId: task.id,
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const result = await workflow.recoverPhase(task.id);

    expect(result?.status).toBe("awaiting-approval");
    const recovered = store.getTask(task.id);
    expect(recovered?.error).toBeUndefined();
    expect(recovered).toMatchObject({
      status: "running",
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
      },
    });
  });
});
