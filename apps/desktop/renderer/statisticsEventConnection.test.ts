import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type { StatisticsInspectInput } from "../runtime/interface.js";
import { connectStatisticsEventStream } from "./statisticsEventConnection.js";

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
    metricIds: ["review-finding-count"],
  },
};

describe("Statistics Runtime event connection", () => {
  it("re-queries authoritative live and frozen views after Statistics evidence invalidation", async () => {
    let queryCount = 0;
    const queryTypes: string[] = [];
    const acknowledgements: unknown[] = [];
    const views: Array<{
      readonly count: number;
      readonly evidenceId: string | null;
    }> = [];
    const invalidationFrame = {
      subscriptionId: "statistics-subscription-1",
      subscriptionGeneration: 3,
      barrierSequence: 10,
      value: {
        kind: "event",
        event: {
          registryVersion: 20,
          schemaVersion: 1,
          sequence: 11,
          eventId: "statistics-event-11",
          type: "statistics.evidence.invalidated",
          companyId: "company",
          projectId: "project-1",
          statisticsEvidenceSnapshotId: "statistics-evidence-1",
          payload: {
            evidenceSnapshotId: "statistics-evidence-1",
            catalogVersion: "statistics@1",
          },
          timestamp: "2026-08-04T00:01:00.000Z",
        },
      },
    } as RuntimeEventFrame;
    const bridge = {
      query: async (input: { readonly type: string }) => {
        queryTypes.push(input.type);
        if (input.type === "statistics.inspect") {
          queryCount += 1;
          return {
            view: {
              query: {
                ...query,
                catalogVersion: "statistics@1",
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
              },
              asOfSequence: queryCount === 1 ? 10 : 11,
              observations: [
                {
                  metricId: "review-finding-count",
                  status: "available",
                  measurement: { kind: "count", value: queryCount },
                  sourceFactFamily: "review-finding",
                  sourceFactRefs: [],
                },
              ],
              completeness: {
                status: "complete",
                incompleteMetricIds: [],
                unavailableMetricIds: [],
              },
              generatedAt: "2026-08-04T00:00:00.000Z",
            },
            asOfSequence: queryCount === 1 ? 10 : 11,
            viewSyncToken:
              queryCount === 1 ? "statistics-token-10" : "statistics-token-11",
          };
        }
        return {
          view: {
            id: "statistics-evidence-1",
            hash: "a".repeat(64),
          },
          asOfSequence: queryCount === 1 ? 10 : 11,
          viewSyncToken:
            queryCount === 1 ? "evidence-token-10" : "evidence-token-11",
        };
      },
      execute: async (input: unknown) => {
        acknowledgements.push(input);
        const command = (
          input as { readonly command: { readonly sequence: number } }
        ).command;
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: acknowledgements.length === 1 ? 2 : 3,
            barrierSequence: command.sequence,
            auditId: `audit-${acknowledgements.length}`,
          },
          effectIds: [],
        };
      },
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        await sink(invalidationFrame);
        return {
          subscriptionId: "statistics-subscription-1",
          subscriptionGeneration: 3,
          barrierSequence: 10,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectStatisticsEventStream({
      bridge,
      evidenceSnapshotId: "statistics-evidence-1",
      onDiagnostic: () => undefined,
      onViews: (next) => {
        const observation = next.statistics.observations[0];
        views.push({
          count:
            observation?.status === "available" &&
            observation.measurement.kind === "count"
              ? observation.measurement.value
              : -1,
          evidenceId: next.evidence?.id ?? null,
        });
      },
      projectId: "project-1",
      query,
    });

    assert.deepEqual(queryTypes, [
      "statistics.inspect",
      "statistics-evidence.inspect",
      "statistics.inspect",
      "statistics-evidence.inspect",
    ]);
    assert.deepEqual(views, [
      { count: 1, evidenceId: "statistics-evidence-1" },
      { count: 2, evidenceId: "statistics-evidence-1" },
    ]);
    assert.equal(acknowledgements.length, 2);
    await connection.close();
  });
});
