import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewerRecheckOutputSchema } from "./reviewerExecution.js";

describe("Reviewer execution output", () => {
  it("validates exact Candidate Gate check observations from the Reviewer terminal output", () => {
    const parsed = ReviewerRecheckOutputSchema.parse({
      result: "PASS",
      conditions: [],
      evidenceRefs: ["artifact-version:review-evidence"],
      gateExecution: {
        schemaVersion: 1,
        gateInputId: "gate-input-1",
        checks: [
          {
            checkId: "startup-build",
            status: "passed",
            evidence: [
              {
                kind: "artifact",
                ref: "artifact-version:review-evidence",
              },
            ],
            responsibility: {
              kind: "aggregate",
              candidateIds: ["candidate-input-1"],
            },
          },
        ],
        resolutions: [],
      },
    });

    assert.equal(parsed.gateExecution?.gateInputId, "gate-input-1");
    assert.equal(parsed.gateExecution?.checks[0]?.status, "passed");
    assert.equal(
      parsed.gateExecution?.checks[0]?.evidence[0]?.ref,
      "artifact-version:review-evidence",
    );
  });

  it("rejects Candidate Gate evidence with missing or undefined references", () => {
    const result = ReviewerRecheckOutputSchema.safeParse({
      result: "PASS",
      conditions: [],
      evidenceRefs: ["artifact-version:review-evidence"],
      gateExecution: {
        schemaVersion: 1,
        gateInputId: "gate-input-1",
        checks: [
          {
            checkId: "startup-build",
            status: "passed",
            evidence: [{ kind: "artifact", ref: "undefined" }],
            responsibility: {
              kind: "aggregate",
              candidateIds: ["candidate-input-1"],
            },
          },
        ],
        resolutions: [],
      },
    });

    assert.equal(result.success, false);
  });
});
