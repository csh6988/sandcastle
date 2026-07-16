import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSandcastleExecutionPort,
  type SandcastleExecutionRuntime,
} from "./sandcastleExecutionPort.js";
import type { SoftwareDevelopmentExecutionInput } from "./productionExecutionAdapter.js";

const input = (): SoftwareDevelopmentExecutionInput => ({
  handler: "product-goal-alignment",
  runId: "run-1",
  nodeRunId: "node-1",
  signal: new AbortController().signal,
  node: {
    id: "product-alignment",
    type: "ai-task",
    name: "Product alignment",
    positionId: "planner",
    instructions: "Use the goal contract.",
  },
  project: {
    id: "project-1",
    revision: 0,
    name: "Checkout",
    goal: "Ship checkout",
    sharedContext: "Preserve payments.",
    repositoryReferences: [],
  },
  department: {
    id: "department-1",
    revision: 0,
    name: "Delivery",
    description: "Ships software.",
    inputArtifactContracts: [],
    outputArtifactContracts: [],
    defaultExecutionProfileId: "profile-1",
  },
  position: {
    id: "planner",
    revision: 0,
    name: "Planner",
    responsibility: "Aligns goals.",
    defaultAgentId: "codex",
    resolvedAgentId: "codex",
    agentSource: "position-default",
    skillIds: [],
    aiMember: {
      id: "member-1",
      displayName: "Ada",
      profile: "Careful planner.",
      responsibilityMetadata: {},
      status: "active",
    },
  },
  aiMember: {
    id: "member-1",
    displayName: "Ada",
    profile: "Careful planner.",
    responsibilityMetadata: {},
    status: "active",
  },
  skillFlow: {
    id: "flow-1",
    revision: 0,
    name: "Alignment",
    instructions: "Clarify the goal.",
    skillIds: ["domain-modeling"],
    positionId: "planner",
  },
  executionProfile: {
    id: "profile-1",
    revision: 0,
    name: "Default",
    providerRef: "codex",
    model: "gpt-test",
    sandboxRef: "no-sandbox",
    branchStrategy: "head",
    limits: { timeoutSeconds: 60, maxIterations: 1, maxTokens: null },
    retryPolicy: { maxAttempts: 1 },
    permissionPolicy: "ask",
    secretReferenceIds: [],
  },
  attempt: {
    id: "attempt-1",
    attemptNumber: 1,
    snapshotRevisionId: "snapshot-1",
    reason: "initial",
    feedback: [],
    previousResult: null,
    previousFailure: null,
  },
});

describe("Sandcastle Execution Port", () => {
  it("maps Product goal alignment to run() with frozen prompt and structured output", async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: (sandbox) => ({ sandbox }),
      run: async (options) => {
        received = options;
        return { output: { aligned: true } };
      },
      runWorkspaceTask: async () => ({}),
    };
    const result =
      await createSandcastleExecutionPort(runtime).execute(input());
    assert.deepEqual(result, {
      kind: "succeeded",
      structuredResult: { aligned: true },
    });
    assert.match(String(received?.prompt), /Ship checkout/);
    assert.match(String(received?.prompt), /Clarify the goal/);
    assert.match(String(received?.prompt), /<product_alignment>/);
    assert.deepEqual(received?.output, {
      tag: "product_alignment",
      schema: "object",
    });
    assert.deepEqual(received?.branchStrategy, { type: "head" });
    assert.equal(received?.idleTimeoutSeconds, 60);
    assert.equal(received?.completionTimeoutSeconds, 60);
  });

  it("keeps Technical Plan in the planning phase without executing repository changes", async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: (sandbox) => ({ sandbox }),
      run: async () => ({}),
      runWorkspaceTask: async (options) => {
        received = options;
        return { plan: { technicalPlan: "Use a staged migration." } };
      },
    };
    const result = await createSandcastleExecutionPort(runtime).execute({
      ...input(),
      handler: "technical-plan",
      node: {
        ...input().node,
        id: "technical-plan",
      },
      project: {
        ...input().project,
        repositoryReferences: ["/workspace/checkout"],
      },
    });

    assert.deepEqual(result, {
      kind: "succeeded",
      structuredResult: { technicalPlan: "Use a staged migration." },
    });
    assert.equal(received?.dryRun, true);
    assert.deepEqual(received?.repositories, [
      { name: "repository-1", cwd: "/workspace/checkout" },
    ]);
  });

  it("includes prior Node Attempt evidence in implementation prompts", async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: (sandbox) => ({ sandbox }),
      run: async (options) => {
        received = options;
        return { commits: [{ sha: "abc123" }] };
      },
      runWorkspaceTask: async () => ({}),
    };
    const result = await createSandcastleExecutionPort(runtime).execute({
      ...input(),
      handler: "repository-implementation",
      node: { ...input().node, id: "implementation" },
      attempt: {
        ...input().attempt,
        previousResult: { technicalPlan: "Use a staged migration." },
        previousFailure: null,
      },
      executionProfile: {
        ...input().executionProfile,
        branchStrategy: "branch",
      },
      project: {
        ...input().project,
        repositoryReferences: ["/workspace/checkout"],
      },
    });

    assert.equal(result.kind, "succeeded");
    assert.match(String(received?.prompt), /Use a staged migration/);
    assert.deepEqual(received?.branchStrategy, {
      type: "branch",
      branch: "sandcastle/run-1/node-1",
    });
  });

  it("serializes same-repository work for a non-isolated sandbox", async () => {
    let started = 0;
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: () => ({ tag: "none" }),
      run: async () => {
        started += 1;
        if (started === 1) await firstFinished;
        return { commits: [] };
      },
      runWorkspaceTask: async () => ({}),
    };
    const port = createSandcastleExecutionPort(runtime);
    const shared = {
      ...input(),
      project: {
        ...input().project,
        repositoryReferences: ["/workspace/checkout"],
      },
      executionProfile: {
        ...input().executionProfile,
        branchStrategy: "branch" as const,
      },
    };
    const first = port.execute({
      ...shared,
      handler: "repository-implementation",
      node: { ...shared.node, id: "implementation" },
    });
    while (started !== 1) await Promise.resolve();
    const second = port.execute({
      ...shared,
      handler: "independent-review",
      node: { ...shared.node, id: "review" },
      project: {
        ...shared.project,
        repositoryReferences: ["/workspace/../workspace/checkout"],
      },
    });
    await Promise.resolve();
    assert.equal(started, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(started, 2);
  });

  it("serializes an isolated sandbox when head strategy would share the host repository", async () => {
    let started = 0;
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: () => ({ tag: "isolated" }),
      run: async () => {
        started += 1;
        if (started === 1) await firstFinished;
        return { commits: [] };
      },
      runWorkspaceTask: async () => ({}),
    };
    const port = createSandcastleExecutionPort(runtime);
    const shared = {
      ...input(),
      project: {
        ...input().project,
        repositoryReferences: ["/workspace/checkout"],
      },
      executionProfile: {
        ...input().executionProfile,
        sandboxRef: "isolated",
        branchStrategy: "head" as const,
      },
    };
    const first = port.execute({
      ...shared,
      handler: "repository-implementation",
      node: { ...shared.node, id: "implementation" },
    });
    while (started !== 1) await Promise.resolve();
    const second = port.execute({
      ...shared,
      handler: "independent-review",
      node: { ...shared.node, id: "review" },
    });
    await Promise.resolve();
    assert.equal(started, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(started, 2);
  });

  it("returns structured independent review and verification facts without implicit Session resume", async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: () => ({ tag: "isolated" }),
      run: async (options) => {
        calls.push(options);
        const output = options.output as { readonly tag?: string } | undefined;
        return {
          output:
            output?.tag === "independent_review"
              ? { decision: "approved", findings: [] }
              : { accepted: true, checks: ["test", "typecheck"] },
        };
      },
      runWorkspaceTask: async () => ({}),
    };
    const port = createSandcastleExecutionPort(runtime);
    const shared = {
      ...input(),
      project: {
        ...input().project,
        repositoryReferences: ["/workspace/checkout"],
      },
      executionProfile: {
        ...input().executionProfile,
        sandboxRef: "isolated",
        branchStrategy: "branch" as const,
      },
    };

    const review = await port.execute({
      ...shared,
      handler: "independent-review",
      node: { ...shared.node, id: "review" },
    });
    const verification = await port.execute({
      ...shared,
      handler: "delivery-verification",
      node: { ...shared.node, id: "verification" },
    });

    assert.deepEqual(review, {
      kind: "succeeded",
      structuredResult: { decision: "approved", findings: [] },
      artifacts: [
        {
          type: "independent-review",
          schemaVersion: "1",
          logicalName: "project-1-independent-review",
          content: JSON.stringify({ decision: "approved", findings: [] }),
          status: "produced",
        },
      ],
    });
    assert.deepEqual(verification, {
      kind: "succeeded",
      structuredResult: { accepted: true, checks: ["test", "typecheck"] },
      artifacts: [
        {
          type: "verification-report",
          schemaVersion: "1",
          logicalName: "project-1-verification-report",
          content: JSON.stringify({
            accepted: true,
            checks: ["test", "typecheck"],
          }),
          status: "produced",
        },
      ],
    });
    assert.deepEqual(
      calls.map((call) => call.output),
      [
        { tag: "independent_review", schema: "object" },
        { tag: "verification_report", schema: "object" },
      ],
    );
    assert.equal(
      calls.some((call) => "resumeSession" in call),
      false,
    );
    assert.match(String(calls[0]?.prompt), /<independent_review>/);
    assert.match(String(calls[1]?.prompt), /<verification_report>/);
    assert.match(
      String(calls[1]?.prompt),
      /Return the JSON result inside <verification_report>/,
    );
  });
});
