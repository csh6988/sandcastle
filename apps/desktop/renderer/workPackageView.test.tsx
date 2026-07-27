import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkPackageGraphView } from "../runtime/interface.js";
import { WorkPackageGraphPanel } from "./workPackageView.js";

describe("WorkPackageGraphPanel", () => {
  it("renders only the plain Work Package Query View", () => {
    const graph = {
      projectId: "project-1",
      runId: "run-1",
      technicalBaselineId: "technical-baseline-1",
      packages: [
        {
          id: "package-api",
          projectId: "project-1",
          runId: "run-1",
          technicalBaselineId: "technical-baseline-1",
          state: "ready",
          revision: 0,
          versions: [
            {
              id: "package-api-v1",
              version: 1,
              applicationId: "orders-api",
              repositoryReference: "/work/orders-api",
              nodeRunId: "node-api",
              manifest: {
                objective: "Implement the Orders API.",
                acceptanceCriteria: ["Contract tests pass."],
                moduleScope: ["src/orders.ts"],
                allowedPermissions: ["repository.write"],
                specRefs: ["application-spec:r1"],
                harnessRefs: ["tdd@1"],
                assignmentCriteria: { positionIds: ["engineer"] },
                expectedArtifacts: ["source-commit"],
                selfCheckCommands: ["npm test"],
                codeReviewConditions: ["Independent review"],
                integrationConditions: ["Contract compatible"],
                riskTier: "medium",
                recoveryPolicy: "Create a new Attempt.",
                execution: {
                  profileId: "software-rnd-local-isolated-git",
                  branchStrategy: "branch",
                  gitRefWriteIsolation: true,
                  runtimeImportOnly: true,
                },
              },
              manifestHash: "a".repeat(64),
              status: "ready",
              dependencies: [
                {
                  predecessorWorkPackageVersionId: "package-contract-v1",
                  kind: "contract",
                  contractId: "checkout-submit-v1",
                  contractVersion: "1",
                  evidenceRef: null,
                },
              ],
              assignments: [],
              createdAt: "2026-07-27T08:00:00.000Z",
            },
          ],
          createdAt: "2026-07-27T08:00:00.000Z",
          updatedAt: "2026-07-27T08:00:00.000Z",
        },
      ],
    } satisfies WorkPackageGraphView;

    const markup = renderToStaticMarkup(
      <WorkPackageGraphPanel graph={graph} />,
    );

    assert.match(markup, /data-work-package-graph/);
    assert.match(markup, /Technical Baseline technical-baseline-1/);
    assert.match(markup, /package-contract-v1 \(contract\)/);
    assert.match(markup, /Unassigned/);
    assert.doesNotMatch(markup, /approve|approval/i);
  });
});
