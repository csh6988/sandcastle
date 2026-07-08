import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DesktopProject } from "../renderer/boardApi.js";
import {
  currentStage,
  rdPipelineSteps,
  reviewStatusLabel,
} from "../renderer/projectViewModel.js";

const project = (overrides: Partial<DesktopProject>): DesktopProject => ({
  id: "checkout-redesign",
  name: "Checkout Redesign",
  summary: "Improve checkout.",
  status: "draft",
  prd: { path: "prd/prd.md", status: "draft" },
  design: { path: "design/design.md", status: "draft" },
  rd: { repositories: ["/repo/app"], currentBoardTaskId: null, history: [] },
  ...overrides,
});

describe("Desktop project view model", () => {
  it("shows accepted Review state when the top-level project is accepted", () => {
    assert.equal(
      reviewStatusLabel(project({ status: "accepted" })),
      "accepted",
    );
  });

  it("routes delivery states to the expected workbench stage", () => {
    assert.equal(currentStage(project({ status: "draft" })), "prd");
    assert.equal(currentStage(project({ status: "prd-confirmed" })), "design");
    assert.equal(currentStage(project({ status: "design-ready" })), "rd");
    assert.equal(
      currentStage(project({ status: "ready-for-review" })),
      "review",
    );
    assert.equal(currentStage(project({ status: "accepted" })), "artifacts");
  });

  it("marks R&D verification as active after the project is ready for review", () => {
    assert.deepEqual(rdPipelineSteps(project({ status: "ready-for-review" })), [
      "done",
      "done",
      "done",
      "active",
      "pending",
    ]);
  });
});
