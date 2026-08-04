import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  StatisticsEvidenceSnapshotView,
  StatisticsInspectInput,
  StatisticsView,
} from "../runtime/interface.js";
import { messages } from "./i18n.js";
import { ProjectImprovementsPanel } from "./projectImprovementsPanel.js";

const hash = "a".repeat(64);

const query: StatisticsInspectInput = {
  projectId: "project-1",
  window: {
    kind: "explicit-utc-half-open",
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-02T00:00:00.000Z",
  },
  cohort: { id: "cohort:baseline-quality" },
  comparisonSet: {
    id: "comparison:baseline-quality",
    metricIds: [
      "product-baseline-confirmation-count",
      "product-baseline-confirmation-latency",
      "readiness-blocker-count",
      "review-discussion-round-count",
      "review-finding-count",
      "review-recheck-pass-rate",
    ],
  },
};

const canonicalQuery = {
  ...query,
  catalogVersion: "statistics@1" as const,
  filters: {
    departmentIds: [],
    aiMemberIds: [],
    modelIds: [],
    repositoryIds: [],
    workPackageIds: [],
    pipelineVersionIds: [],
  },
  cohort: {
    id: query.cohort.id,
    filters: {
      departmentIds: [],
      aiMemberIds: [],
      modelIds: [],
      repositoryIds: [],
      workPackageIds: [],
      pipelineVersionIds: [],
    },
  },
};

describe("Project Improvements panel", () => {
  it("renders available zero, incomplete, unavailable, and frozen evidence as distinct authoritative states", () => {
    const view: StatisticsView = {
      query: canonicalQuery,
      asOfSequence: 42,
      observations: [
        {
          metricId: "product-baseline-confirmation-count",
          status: "available",
          measurement: { kind: "count", value: 0 },
          sourceFactFamily: "product-baseline",
          sourceFactRefs: [],
        },
        {
          metricId: "product-baseline-confirmation-latency",
          status: "incomplete",
          reason: "One timestamp pair is invalid.",
          missingFactKinds: ["valid-product-baseline-timestamp-pair"],
          sourceFactFamily: "product-baseline",
          sourceFactRefs: ["product-baseline-1"],
        },
        {
          metricId: "review-recheck-pass-rate",
          status: "unavailable",
          reason: "No authoritative denominator exists.",
          unavailableReasonCode: "missing-denominator-authority",
          sourceFactFamily: "review-recheck",
          sourceFactRefs: [],
        },
      ],
      completeness: {
        status: "incomplete",
        incompleteMetricIds: ["product-baseline-confirmation-latency"],
        unavailableMetricIds: ["review-recheck-pass-rate"],
      },
      generatedAt: "2026-08-04T00:00:00.000Z",
    };
    const evidence: StatisticsEvidenceSnapshotView = {
      id: "statistics-evidence-1",
      query: canonicalQuery,
      queryHash: hash,
      asOfSequence: 42,
      observations: view.observations,
      completeness: view.completeness,
      frozenBy: {
        type: "human",
        id: "verified-local-human",
        authenticatedBy: "local-session",
      },
      hash,
      createdAt: "2026-08-04T00:01:00.000Z",
    };

    const markup = renderToStaticMarkup(
      <ProjectImprovementsPanel
        busy={false}
        diagnostic={null}
        evidence={evidence}
        evidenceSnapshotId={evidence.id}
        onEvidenceSnapshotIdChange={() => undefined}
        onFreeze={() => undefined}
        onInspect={() => undefined}
        onInspectEvidence={() => undefined}
        onWindowChange={() => undefined}
        query={query}
        t={messages.en}
        view={view}
      />,
    );

    assert.match(markup, /data-statistics-catalog="statistics@1"/);
    assert.match(markup, /data-statistics-as-of-sequence="42"/);
    assert.match(
      markup,
      /data-statistics-observation-status="available"[^>]*>[\s\S]*>0</,
    );
    assert.match(markup, /Incomplete: One timestamp pair is invalid\./);
    assert.match(markup, /Unavailable: No authoritative denominator exists\./);
    assert.match(markup, /statistics-evidence-1/);
    assert.match(markup, new RegExp(hash));
    assert.match(markup, /Freeze exact evidence/);
  });

  it("renders the Project Improvements workflow in Chinese", () => {
    const markup = renderToStaticMarkup(
      <ProjectImprovementsPanel
        busy={false}
        diagnostic={null}
        evidence={null}
        evidenceSnapshotId=""
        onEvidenceSnapshotIdChange={() => undefined}
        onFreeze={() => undefined}
        onInspect={() => undefined}
        onInspectEvidence={() => undefined}
        onWindowChange={() => undefined}
        query={query}
        t={messages.zh}
        view={null}
      />,
    );

    assert.match(markup, /统计/);
    assert.match(markup, /检查统计/);
    assert.match(markup, /冻结精确证据/);
    assert.match(markup, /尚未检查统计数据/);
  });
});
