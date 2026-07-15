import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCompanyRuntimeClientFromTransport,
  RuntimeClientError,
} from "./client.js";
import { createScriptedRuntimeTransport } from "./testing/scriptedRuntime.js";
import {
  assertSoftwareRndDepartmentContract,
  scriptedSoftwareRndDepartment,
} from "./testing/departmentInspectContract.js";
import {
  assertSkillConfigurationContract,
  scriptedSkillConfiguration,
} from "./testing/skillConfigurationContract.js";

const scriptedRun = {
  run: {
    id: "run-1",
    projectId: "project-1",
    departmentId: "department-1",
    pipelineVersionId: "pipeline-1",
    snapshotRevisionId: "snapshot-1",
    parentRunId: null,
    forkedFromSnapshotRevisionId: null,
    status: "ready" as const,
    revision: 0,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
  snapshot: {
    id: "snapshot-1",
    revision: 1,
    parentRevision: null,
    hash: "a".repeat(64),
    canonicalJson: "{}",
    payload: {
      schemaVersion: 1 as const,
      project: {
        id: "project-1",
        revision: 0,
        name: "Checkout",
        goal: "Ship it",
        sharedContext: "",
        repositoryReferences: [],
      },
      department: {
        id: "department-1",
        revision: 1,
        name: "Delivery",
        description: "",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: "profile-1",
      },
      pipelineVersion: {
        id: "pipeline-1",
        version: 1,
        hash: "b".repeat(64),
        graph: {
          nodes: [
            { id: "start", type: "start" as const, name: "Start" },
            { id: "complete", type: "complete" as const, name: "Complete" },
          ],
          edges: [{ from: "start", to: "complete" }],
        },
      },
      skillFlows: [],
      positions: [],
      executionProfiles: [
        {
          id: "profile-1",
          revision: 0,
          name: "Scripted",
          providerRef: "scripted",
          model: "scripted-v1",
          sandboxRef: "no-sandbox",
          branchStrategy: "head" as const,
          limits: {
            timeoutSeconds: 60,
            maxIterations: 1,
            maxTokens: null,
          },
          retryPolicy: { maxAttempts: 0 },
          permissionPolicy: "deny" as const,
          secretReferenceIds: [],
        },
      ],
      runLimits: { maxActiveNodes: 1 },
    },
  },
  nodes: [
    {
      id: "node-run-start",
      runId: "run-1",
      pipelineNodeId: "start",
      nodeType: "start" as const,
      status: "ready" as const,
      attemptCount: 0,
      attempts: [],
      approvals: [],
      requiredDependencyIds: [],
      result: null,
      failure: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
    {
      id: "node-run-complete",
      runId: "run-1",
      pipelineNodeId: "complete",
      nodeType: "complete" as const,
      status: "queued" as const,
      attemptCount: 0,
      attempts: [],
      approvals: [],
      requiredDependencyIds: ["start"],
      result: null,
      failure: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
};

describe("Scripted Runtime transport", () => {
  it("drives query and command contract tests through the production client", async () => {
    const transport = createScriptedRuntimeTransport({
      responses: [
        {
          ok: true,
          result: {
            status: "ok",
            schemaVersion: 1,
            pid: 42,
            startedAt: "2026-07-14T00:00:00.000Z",
          },
        },
        {
          ok: true,
          result: {
            company: { id: "company", name: "Acme" },
            metrics: {
              activeRuns: 0,
              waitingApprovalRuns: 0,
              blockedRuns: 0,
              completedRuns: 0,
              projects: 0,
              departments: 0,
              artifacts: 0,
            },
            attention: [],
          },
        },
        { ok: true, result: { stopping: true } },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    assert.equal((await client.query({ type: "runtime.health" })).pid, 42);
    assert.equal(
      (await client.query({ type: "company.overview" })).company.name,
      "Acme",
    );
    assert.deepEqual(await client.execute({ type: "runtime.shutdown" }), {
      stopping: true,
    });
    assert.deepEqual(
      transport.requests.map((request) => request.kind),
      ["query", "query", "command"],
    );
  });

  it("validates scripted events against the shared EventEnvelope contract", async () => {
    const transport = createScriptedRuntimeTransport({
      events: [
        {
          schemaVersion: 1,
          sequence: 7,
          eventId: "event-7",
          type: "runtime.test",
          companyId: "company-1",
          participantId: "member-1",
          timestamp: "2026-07-14T00:00:00.000Z",
          payload: { ready: true },
        },
      ],
    });

    const events = [];
    for await (const event of transport.events()) events.push(event);

    assert.deepEqual(events, [
      {
        schemaVersion: 1,
        sequence: 7,
        eventId: "event-7",
        type: "runtime.test",
        companyId: "company-1",
        participantId: "member-1",
        timestamp: "2026-07-14T00:00:00.000Z",
        payload: { ready: true },
      },
    ]);
  });

  it("serves the same typed department.inspect contract as the real Runtime", async () => {
    const transport = createScriptedRuntimeTransport({
      responses: [{ ok: true, result: scriptedSoftwareRndDepartment }],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    assertSoftwareRndDepartmentContract(
      await client.query({
        type: "department.inspect",
        departmentId: "software-rnd",
      }),
    );
    assert.deepEqual(transport.requests[0], {
      id: transport.requests[0]?.id,
      token: "scripted-runtime",
      kind: "query",
      query: {
        type: "department.inspect",
        departmentId: "software-rnd",
      },
    });
  });

  it("serves the same Department configuration command seam as the real Runtime", async () => {
    const updated = {
      ...scriptedSoftwareRndDepartment,
      name: "Product Engineering",
      description: "Builds and verifies product changes.",
      revision: 1,
    };
    const configured = {
      ...updated,
      positions: updated.positions.map((position) =>
        position.id === "software-engineer"
          ? {
              ...position,
              revision: 1,
              responsibility: "Ships tested vertical slices.",
              aiMember: {
                ...position.aiMember,
                displayName: "Delivery Engineer",
                profile: "Delivers verified slices.",
                responsibilityMetadata: { focus: "delivery" },
                status: "inactive" as const,
              },
            }
          : position,
      ),
    };
    const copied = {
      ...configured,
      id: "product-delivery",
      name: "Product Delivery",
      builtIn: false,
      positions: configured.positions.map((position, index) => ({
        ...position,
        id: `copied-position-${index}`,
        aiMember: {
          ...position.aiMember,
          id: `copied-member-${index}`,
          positionId: `copied-position-${index}`,
        },
      })),
      pipeline: configured.pipeline
        ? { ...configured.pipeline, id: "copied-pipeline" }
        : null,
    };
    const archived = {
      ...configured,
      status: "archived" as const,
      revision: 2,
    };
    const transport = createScriptedRuntimeTransport({
      responses: [
        { ok: true, result: updated },
        { ok: true, result: configured },
        { ok: true, result: copied },
        { ok: true, result: archived },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    assert.equal(
      (
        await client.execute({
          type: "department.update",
          departmentId: "software-rnd",
          expectedRevision: 0,
          name: "Product Engineering",
          description: "Builds and verifies product changes.",
          inputArtifactContracts: [],
          outputArtifactContracts: [],
          defaultExecutionProfileId: "software-rnd-default",
        })
      ).name,
      "Product Engineering",
    );
    assert.equal(
      (
        await client.execute({
          type: "position.update",
          departmentId: "software-rnd",
          positionId: "software-engineer",
          expectedRevision: 0,
          name: "Software Engineer",
          responsibility: "Ships tested vertical slices.",
          aiMemberDisplayName: "Delivery Engineer",
          aiMemberProfile: "Delivers verified slices.",
          aiMemberResponsibilityMetadata: { focus: "delivery" },
          aiMemberStatus: "inactive",
        })
      ).positions[2]?.aiMember.displayName,
      "Delivery Engineer",
    );
    assert.equal(
      (
        await client.execute({
          type: "department.copy",
          departmentId: "software-rnd",
          name: "Product Delivery",
        })
      ).id,
      "product-delivery",
    );
    assert.equal(
      (
        await client.execute({
          type: "department.archive",
          departmentId: "software-rnd",
          expectedRevision: 1,
        })
      ).status,
      "archived",
    );
    assert.deepEqual(
      transport.requests.map((request) =>
        request.kind === "command" ? request.command.type : request.query.type,
      ),
      [
        "department.update",
        "position.update",
        "department.copy",
        "department.archive",
      ],
    );
  });

  it("serves the same Phase 1 Position and Execution Profile command seam as the real Runtime", async () => {
    const position = scriptedSoftwareRndDepartment.positions[0];
    assert.ok(position);
    const created = {
      ...scriptedSoftwareRndDepartment,
      positions: [
        {
          ...position,
          id: "design-position",
          name: "Product Designer",
          aiMember: {
            ...position.aiMember,
            id: "design-member",
            positionId: "design-position",
            displayName: "Ada",
          },
        },
      ],
    };
    const updated = {
      ...created,
      positions: [{ ...created.positions[0]!, revision: 1 }],
    };
    const archived = {
      ...updated,
      positions: [
        { ...updated.positions[0]!, revision: 2, status: "archived" as const },
      ],
    };
    const transport = createScriptedRuntimeTransport({
      responses: [
        { ok: true, result: created },
        { ok: true, result: updated },
        { ok: true, result: updated },
        { ok: true, result: archived },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);
    const createdResult = await client.execute({
      type: "position.create",
      departmentId: "software-rnd",
      name: "Product Designer",
      responsibility: "Designs product flows.",
      aiMemberDisplayName: "Ada",
      aiMemberProfile: "",
      aiMemberResponsibilityMetadata: {},
    });
    assert.equal(createdResult.positions[0]?.aiMember.displayName, "Ada");
    await client.execute({
      type: "position.update",
      departmentId: "software-rnd",
      positionId: "design-position",
      expectedRevision: 0,
      name: "Product Designer",
      responsibility: "Owns product flows.",
      aiMemberDisplayName: "Ada Lovelace",
      aiMemberProfile: "",
      aiMemberResponsibilityMetadata: {},
      aiMemberStatus: "active",
    });
    await client.execute({
      type: "execution-profile.save",
      departmentId: "software-rnd",
      expectedRevision: 0,
      name: "Design profile",
      providerRef: "openai",
      model: "gpt-5",
      sandboxRef: "no-sandbox",
      branchStrategy: "head",
      timeoutSeconds: 600,
      maxIterations: 4,
      maxTokens: null,
      retryMaxAttempts: 1,
      permissionPolicy: "ask",
      secretReferenceIds: [],
    });
    const archivedResult = await client.execute({
      type: "position.archive",
      departmentId: "software-rnd",
      positionId: "design-position",
      expectedRevision: 1,
    });
    assert.equal(archivedResult.positions[0]?.status, "archived");
    assert.deepEqual(
      transport.requests.map((request) =>
        request.kind === "command" ? request.command.type : request.query.type,
      ),
      [
        "position.create",
        "position.update",
        "execution-profile.save",
        "position.archive",
      ],
    );
  });

  it("serves the same Project Configuration contract as the real Runtime", async () => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 0,
      sharedContext: "",
      repositoryReferences: [],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const updated = {
      ...project,
      name: "Checkout Platform",
      goal: "Ship a resilient checkout platform",
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web"],
    };
    const archived = {
      ...updated,
      status: "archived" as const,
      revision: 2,
    };
    const transport = createScriptedRuntimeTransport({
      responses: [
        { ok: true, result: project },
        { ok: true, result: updated },
        {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Project revision 0 does not match current revision 1.",
          },
        },
        { ok: true, result: archived },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    assert.equal(
      (
        await client.query({
          type: "project.inspect",
          projectId: project.id,
        })
      ).revision,
      0,
    );
    assert.deepEqual(
      await client.execute({
        type: "project.update",
        projectId: project.id,
        expectedRevision: 0,
        name: updated.name,
        goal: updated.goal,
        sharedContext: updated.sharedContext,
        repositoryReferences: updated.repositoryReferences,
      }),
      updated,
    );
    await assert.rejects(
      () =>
        client.execute({
          type: "project.update",
          projectId: project.id,
          expectedRevision: 0,
          name: "Stale overwrite",
          goal: updated.goal,
          sharedContext: updated.sharedContext,
          repositoryReferences: [],
        }),
      (error: unknown) =>
        error instanceof RuntimeClientError &&
        error.code === "VERSION_CONFLICT",
    );
    assert.equal(
      (
        await client.execute({
          type: "project.archive",
          projectId: project.id,
          expectedRevision: 1,
        })
      ).status,
      "archived",
    );
    assert.deepEqual(
      transport.requests.map((request) =>
        request.kind === "command" ? request.command.type : request.query.type,
      ),
      [
        "project.inspect",
        "project.update",
        "project.update",
        "project.archive",
      ],
    );
  });

  it("serves the same Pipeline Configuration command/query seam as the real Runtime", async () => {
    const graph = scriptedSoftwareRndDepartment.pipeline
      ? {
          nodes: scriptedSoftwareRndDepartment.pipeline.nodes,
          edges: scriptedSoftwareRndDepartment.pipeline.edges,
        }
      : { nodes: [], edges: [] };
    const editor = {
      department: { id: "software-rnd", name: "Software R&D" },
      positions: scriptedSoftwareRndDepartment.positions.map((position) => ({
        id: position.id,
        name: position.name,
      })),
      draft: { revision: 0, graph, updatedAt: null },
      validation: { valid: true, issues: [] },
      published: {
        id: "software-rnd-pipeline-v1",
        version: 1,
        graph,
        hash: "a".repeat(64),
        publishedAt: "2026-07-14T00:00:00.000Z",
      },
      history: [
        {
          id: "software-rnd-pipeline-v1",
          version: 1,
          graph,
          hash: "a".repeat(64),
          publishedAt: "2026-07-14T00:00:00.000Z",
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
        },
      ],
    };
    const saved = {
      ...editor,
      draft: {
        ...editor.draft,
        revision: 1,
        updatedAt: editor.published.publishedAt,
      },
    };
    const published = {
      ...saved,
      published: {
        ...saved.published,
        id: "software-rnd-pipeline-v2",
        version: 2,
      },
      history: [
        {
          ...saved.history[0],
          id: "software-rnd-pipeline-v2",
          version: 2,
        },
        saved.history[0],
      ],
    };
    const transport = createScriptedRuntimeTransport({
      responses: [
        { ok: true, result: editor },
        { ok: true, result: editor.validation },
        { ok: true, result: saved },
        { ok: true, result: published },
        {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message:
              "Pipeline Draft revision 0 does not match current revision 1.",
          },
        },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    const inspected = await client.query({
      type: "department.pipeline.inspect",
      departmentId: "software-rnd",
    });
    const validation = await client.query({
      type: "department.pipeline.validate",
      departmentId: "software-rnd",
      graph,
    });
    const nextDraft = await client.execute({
      type: "department.pipeline.draft.save",
      departmentId: "software-rnd",
      expectedRevision: 0,
      graph,
    });
    const nextPublished = await client.execute({
      type: "department.pipeline.publish",
      departmentId: "software-rnd",
      expectedRevision: 1,
    });

    assert.equal(inspected.draft.revision, 0);
    assert.equal(validation.valid, true);
    assert.equal(nextDraft.draft.revision, 1);
    assert.equal(nextPublished.published?.version, 2);
    await assert.rejects(
      () =>
        client.execute({
          type: "department.pipeline.draft.save",
          departmentId: "software-rnd",
          expectedRevision: 0,
          graph,
        }),
      (error: unknown) =>
        error instanceof RuntimeClientError &&
        error.code === "VERSION_CONFLICT",
    );
    assert.deepEqual(
      transport.requests.map((request) =>
        request.kind === "command" ? request.command.type : request.query.type,
      ),
      [
        "department.pipeline.inspect",
        "department.pipeline.validate",
        "department.pipeline.draft.save",
        "department.pipeline.publish",
        "department.pipeline.draft.save",
      ],
    );
  });

  it("serves the same Skill Configuration command/query seam as the real Runtime", async () => {
    const transport = createScriptedRuntimeTransport({
      responses: Array.from({ length: 6 }, () => ({
        ok: true as const,
        result: scriptedSkillConfiguration,
      })),
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    assertSkillConfigurationContract(
      await client.query({
        type: "department.skill-configuration.inspect",
        departmentId: "software-rnd",
      }),
    );
    await client.execute({
      type: "position.skills.set",
      departmentId: "software-rnd",
      positionId: "software-engineer",
      expectedRevision: 0,
      skillIds: ["tdd"],
    });
    await client.execute({
      type: "skill.catalog.save",
      departmentId: "software-rnd",
      expectedRevision: 0,
      name: "Release notes",
      description: "Produces release notes.",
      source: "local",
      version: "1",
      locationReference: "skill://release-notes",
    });
    await client.execute({
      type: "skill-flow.save",
      departmentId: "software-rnd",
      positionId: "software-engineer",
      expectedRevision: 0,
      name: "Focused delivery",
      instructions: "Deliver one tested behavior.",
      skillIds: ["tdd"],
    });
    await client.execute({
      type: "skill-flow.archive",
      departmentId: "software-rnd",
      skillFlowId: "implementation-flow",
      expectedRevision: 0,
    });
    await client.execute({
      type: "skill.catalog.archive",
      departmentId: "software-rnd",
      skillId: "release-notes",
      expectedRevision: 0,
    });

    assert.deepEqual(
      transport.requests.map((request) =>
        request.kind === "query" ? request.query.type : request.command.type,
      ),
      [
        "department.skill-configuration.inspect",
        "position.skills.set",
        "skill.catalog.save",
        "skill-flow.save",
        "skill-flow.archive",
        "skill.catalog.archive",
      ],
    );
  });

  it("serves the same Department Run command/query seam as the real Runtime", async () => {
    const completed = {
      ...scriptedRun,
      run: { ...scriptedRun.run, status: "completed" as const, revision: 2 },
      nodes: scriptedRun.nodes.map((node) => ({
        ...node,
        status: "succeeded" as const,
      })),
    };
    const transport = createScriptedRuntimeTransport({
      responses: [
        { ok: true, result: [scriptedRun] },
        { ok: true, result: scriptedRun },
        { ok: true, result: scriptedRun },
        { ok: true, result: scriptedRun },
        { ok: true, result: scriptedRun },
        { ok: true, result: scriptedRun },
        { ok: true, result: completed },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(transport);

    assert.equal(
      (await client.query({ type: "runs.list", projectId: "project-1" }))[0]
        ?.run.id,
      "run-1",
    );
    assert.equal(
      (await client.query({ type: "run.inspect", runId: "run-1" })).run.status,
      "ready",
    );
    await client.execute({
      type: "run.start",
      projectId: "project-1",
      departmentId: "department-1",
    });
    await client.execute({
      type: "run.approval.decide",
      runId: "run-1",
      nodeRunId: "node-run-approval",
      expectedRevision: 1,
      decision: "approve",
    });
    await client.execute({
      type: "run.approval.decide",
      runId: "run-1",
      nodeRunId: "node-run-approval",
      expectedRevision: 1,
      decision: "request-changes",
      feedback: "Try a different approach.",
    });
    await client.execute({
      type: "run.node.retry",
      runId: "run-1",
      nodeRunId: "node-run-ai-task",
      expectedRevision: 2,
      feedback: "Retry with more context.",
    });
    assert.equal(
      (
        await client.execute({
          type: "run.execute-ready",
          runId: "run-1",
          expectedRevision: 0,
        })
      ).run.status,
      "completed",
    );
    assert.deepEqual(
      transport.requests.map((request) =>
        request.kind === "query" ? request.query.type : request.command.type,
      ),
      [
        "runs.list",
        "run.inspect",
        "run.start",
        "run.approval.decide",
        "run.approval.decide",
        "run.node.retry",
        "run.execute-ready",
      ],
    );
  });
});
