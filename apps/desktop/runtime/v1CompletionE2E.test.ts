import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { companyRuntimeAddress } from "./address.js";
import { createAcpStdioFacade } from "./acp.js";
import { createCompanyRuntimeClient } from "./client.js";
import { startCompanyRuntimeServer } from "./server.js";
import { createScriptedExecutionAdapter } from "./adapters/scriptedExecutionAdapter.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-v1-e2e-"));

describe("Sandcastle v1 Company Runtime E2E", () => {
  it("keeps one authoritative Run through controls, restart, artifacts, interaction, AG-UI, ACP, and Memory", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtimeAdapter = createScriptedExecutionAdapter({
      script: {
        review: [
          {
            kind: "succeeded",
            structuredResult: { decision: "approved", findings: [] },
            artifacts: [
              {
                type: "independent-review",
                schemaVersion: "1",
                logicalName: "independent-review",
                content: JSON.stringify({ decision: "approved", findings: [] }),
              },
            ],
          },
        ],
        verification: [
          {
            kind: "succeeded",
            structuredResult: { accepted: true, checks: ["e2e"] },
            artifacts: [
              {
                type: "verification-report",
                schemaVersion: "1",
                logicalName: "verification-report",
                content: JSON.stringify({ accepted: true, checks: ["e2e"] }),
              },
            ],
          },
        ],
      },
    });
    let runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "e2e-token",
      executionAdapter: runtimeAdapter,
    });

    try {
      let client = createCompanyRuntimeClient({
        address,
        token: "e2e-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "v1 E2E",
        goal: "Trace one authoritative Company Runtime Run.",
      });
      const started = await client.execute({
        type: "run.start",
        projectId: project.id,
        departmentId: "software-rnd",
      });
      const paused = await client.execute({
        type: "run.pause",
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      assert.equal(paused.run.status, "paused");
      await runtime.close();
      runtime = await startCompanyRuntimeServer({
        address,
        companyDir,
        token: "e2e-token",
        executionAdapter: runtimeAdapter,
      });
      client = createCompanyRuntimeClient({
        address,
        token: "e2e-token",
      });
      const resumed = await client.execute({
        type: "run.resume",
        runId: started.run.id,
        expectedRevision: paused.run.revision,
      });
      const firstApproval = await client.execute({
        type: "run.execute-ready",
        runId: resumed.run.id,
        expectedRevision: resumed.run.revision,
      });
      assert.equal(firstApproval.run.status, "waiting-approval");
      const approvalNode = firstApproval.nodes.find(
        (node) => node.status === "waiting-approval",
      );
      assert.ok(approvalNode);

      const acp = createAcpStdioFacade(client);
      const sessionResponse = await acp.handle({
        id: "session-new",
        method: "session/new",
        params: {
          projectId: project.id,
          aiMemberId: "product-planner-member",
          runId: started.run.id,
          nodeRunId: approvalNode.id,
        },
      });
      if (!sessionResponse.result) {
        throw new Error(JSON.stringify(sessionResponse));
      }
      const sessionId = String(sessionResponse.result.sessionId);
      const participantId = String(sessionResponse.result.participantId);
      await acp.handle({
        id: "session-prompt",
        method: "session/prompt",
        params: {
          sessionId,
          participantId,
          content: "Please explain the approval evidence.",
        },
      });
      const permission = await client.execute({
        type: "permission.request",
        sessionId,
        scope: "repository.write",
      });
      const permissionDecision = await acp.handle({
        id: "permission-decide",
        method: "session/request_permission",
        params: { permissionId: permission.id, decision: "approved" },
      });
      assert.equal(permissionDecision.result?.status, "approved");
      const replay = await acp.handle({
        id: "session-update",
        method: "session/update",
        params: { afterSequence: 0, limit: 100 },
      });
      assert.ok(replay.result);
      assert.ok(
        Array.isArray(
          (replay.result as { readonly events?: unknown[] }).events,
        ),
      );

      const changed = await client.execute({
        type: "run.approval.decide",
        runId: firstApproval.run.id,
        nodeRunId: approvalNode.id,
        expectedRevision: firstApproval.run.revision,
        decision: "request-changes",
        feedback: "Clarify the verification evidence.",
      });
      const secondApproval = await client.execute({
        type: "run.execute-ready",
        runId: changed.run.id,
        expectedRevision: changed.run.revision,
      });
      const approved = await client.execute({
        type: "run.approval.decide",
        runId: secondApproval.run.id,
        nodeRunId: approvalNode.id,
        expectedRevision: secondApproval.run.revision,
        decision: "approve",
      });
      const finalApproval = await client.execute({
        type: "run.execute-ready",
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
      });
      assert.equal(finalApproval.run.status, "waiting-approval");
      const acceptanceNode = finalApproval.nodes.find(
        (node) => node.status === "waiting-approval",
      );
      assert.ok(acceptanceNode);
      const completed = await client.execute({
        type: "run.approval.decide",
        runId: finalApproval.run.id,
        nodeRunId: acceptanceNode.id,
        expectedRevision: finalApproval.run.revision,
        decision: "approve",
      });
      const finished = await client.execute({
        type: "run.execute-ready",
        runId: completed.run.id,
        expectedRevision: completed.run.revision,
      });
      assert.equal(finished.run.status, "completed");

      const artifacts = await client.query({
        type: "artifacts.list",
        projectId: project.id,
      });
      assert.equal(artifacts.length, 2);
      const accepted = await client.execute({
        type: "artifact.version.status",
        versionId: artifacts[0]!.id,
        expectedStatus: artifacts[0]!.status,
        status: "accepted",
      });
      assert.equal(accepted.status, "accepted");
      const candidate = await client.execute({
        type: "memory.candidate.create",
        projectId: project.id,
        scope: "project",
        sourceSessionId: sessionId,
        sourceRunId: finished.run.id,
        sourceArtifactVersionId: accepted.id,
        summary: "The reviewed delivery passed the v1 Runtime E2E.",
      });
      const memory = await client.execute({
        type: "memory.candidate.review",
        candidateId: candidate.id,
        expectedStatus: "pending",
        decision: "approved",
      });
      assert.equal(memory.candidate.status, "approved");
      assert.equal(memory.record?.version, 1);
      const closed = await acp.handle({
        id: "session-cancel",
        method: "session/cancel",
        params: { sessionId },
      });
      assert.equal(closed.result?.status, "closed");

      const audit = await client.query({
        type: "runtime.audit",
        limit: 500,
      });
      assert.equal(
        audit.some((record) => record.action === "approval.request-changes"),
        true,
      );
      assert.equal(
        audit.some((record) => record.action === "artifact.version.status"),
        true,
      );
      assert.equal(
        (await client.query({ type: "run.inspect", runId: finished.run.id }))
          .run.status,
        "completed",
      );
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
});
