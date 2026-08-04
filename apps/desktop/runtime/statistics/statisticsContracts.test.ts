import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StatisticsAuthorActorSchema,
  StatisticsCanonicalFiltersSchema,
  StatisticsEvidenceSnapshotViewSchema,
  StatisticsMetricIdSchema,
  StatisticsProjectReaderSchema,
  StatisticsViewSchema,
} from "./statisticsContracts.js";

const hash = "a".repeat(64);
const createdAt = "2026-08-04T00:00:00.000Z";

const canonicalQuery = {
  catalogVersion: "statistics@1" as const,
  projectId: "project:sandcastle",
  filters: {
    departmentIds: ["department:software-rnd"],
    aiMemberIds: [],
    modelIds: [],
    repositoryIds: ["repository:sandcastle"],
    workPackageIds: [],
    pipelineVersionIds: ["pipeline:7"],
  },
  window: {
    kind: "explicit-utc-half-open" as const,
    startInclusive: "2026-07-01T00:00:00.000Z",
    endExclusive: "2026-08-01T00:00:00.000Z",
  },
  cohort: {
    id: "cohort:software-rnd-july",
    filters: {
      departmentIds: ["department:software-rnd"],
      aiMemberIds: [],
      modelIds: [],
      repositoryIds: ["repository:sandcastle"],
      workPackageIds: [],
      pipelineVersionIds: ["pipeline:7"],
    },
  },
  comparisonSet: {
    id: "comparison:quality-baseline",
    metricIds: [
      "product-baseline-confirmation-count",
      "review-recheck-pass-rate",
    ],
  },
};

const observations = [
  {
    metricId: "product-baseline-confirmation-count" as const,
    status: "available" as const,
    measurement: { kind: "count" as const, value: 0 },
    sourceFactFamily: "product-baseline",
    sourceFactRefs: [],
  },
  {
    metricId: "review-recheck-pass-rate" as const,
    status: "incomplete" as const,
    reason: "One reviewed revision has no exact fresh recheck terminal fact.",
    sourceFactFamily: "review-recheck",
    sourceFactRefs: ["review-revision:1"],
    missingFactKinds: ["review-recheck-terminal"],
  },
];

describe("Statistics contracts", () => {
  it("freezes the closed statistics@1 catalog and exact evidence snapshot", () => {
    assert.equal(
      StatisticsMetricIdSchema.parse("release-item-success-rate"),
      "release-item-success-rate",
    );
    assert.equal(
      StatisticsMetricIdSchema.parse("whole-run-token-cost"),
      "whole-run-token-cost",
    );
    assert.throws(() => StatisticsMetricIdSchema.parse("invented-metric"));

    const view = StatisticsViewSchema.parse({
      query: canonicalQuery,
      asOfSequence: 42,
      observations,
      completeness: {
        status: "incomplete",
        incompleteMetricIds: ["review-recheck-pass-rate"],
        unavailableMetricIds: [],
      },
      generatedAt: createdAt,
    });
    assert.equal(view.observations[0]?.status, "available");
    assert.deepEqual(view.observations[0]?.measurement, {
      kind: "count",
      value: 0,
    });

    assert.doesNotThrow(() =>
      StatisticsEvidenceSnapshotViewSchema.parse({
        id: "statistics-evidence:1",
        query: canonicalQuery,
        queryHash: hash,
        asOfSequence: 42,
        observations,
        completeness: {
          status: "incomplete",
          incompleteMetricIds: ["review-recheck-pass-rate"],
          unavailableMetricIds: [],
        },
        frozenBy: {
          type: "runtime-worker",
          id: "runtime-worker:statistics",
          authenticatedBy: "runtime",
        },
        hash,
        createdAt,
      }),
    );
  });

  it("requires canonical filters and explicit UTC half-open windows", () => {
    assert.doesNotThrow(() =>
      StatisticsCanonicalFiltersSchema.parse(canonicalQuery.filters),
    );
    assert.throws(() =>
      StatisticsCanonicalFiltersSchema.parse({
        ...canonicalQuery.filters,
        departmentIds: ["department:z", "department:a"],
      }),
    );
    assert.throws(() =>
      StatisticsEvidenceSnapshotViewSchema.parse({
        id: "statistics-evidence:1",
        query: {
          ...canonicalQuery,
          window: {
            ...canonicalQuery.window,
            startInclusive: canonicalQuery.window.endExclusive,
          },
        },
        queryHash: hash,
        asOfSequence: 42,
        observations,
        completeness: {
          status: "incomplete",
          incompleteMetricIds: ["review-recheck-pass-rate"],
          unavailableMetricIds: [],
        },
        frozenBy: {
          type: "human",
          id: "human:1",
          authenticatedBy: "local-session",
        },
        hash,
        createdAt,
      }),
    );
  });

  it("constrains authenticated reader and author actor pairs", () => {
    assert.doesNotThrow(() =>
      StatisticsProjectReaderSchema.parse({
        type: "acp-client",
        id: "acp:reader",
        authenticatedBy: "acp-connection",
        projectReadAuthority: ["project:sandcastle"],
      }),
    );
    assert.doesNotThrow(() =>
      StatisticsAuthorActorSchema.parse({
        type: "human",
        id: "human:1",
        authenticatedBy: "local-session",
      }),
    );
    assert.throws(() =>
      StatisticsAuthorActorSchema.parse({
        type: "human",
        id: "human:1",
        authenticatedBy: "runtime",
      }),
    );
    assert.throws(() =>
      StatisticsProjectReaderSchema.parse({
        type: "test-driver",
        id: "fixture",
        authenticatedBy: "runtime",
        projectReadAuthority: ["project:sandcastle"],
      }),
    );
  });
});
