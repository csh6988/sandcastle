import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvents } from "../events/subscription.js";
import {
  StatisticsCanonicalQuerySchema,
  StatisticsEvidenceSnapshotViewSchema,
  StatisticsInspectInputSchema,
  StatisticsMetricObservationSchema,
  StatisticsViewSchema,
  type StatisticsAuthorActor,
  type StatisticsCanonicalFilters,
  type StatisticsCanonicalQuery,
  type StatisticsEvidenceSnapshotView,
  type StatisticsInspectInput,
  type StatisticsMetricId,
  type StatisticsMetricObservation,
  type StatisticsView,
} from "./statisticsContracts.js";

export class StatisticsRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StatisticsRuntimeError";
  }
}

export interface StatisticsRuntime {
  readonly inspect: (input: StatisticsInspectInput) => StatisticsView;
  readonly inspectEvidence: (
    evidenceSnapshotId: string,
  ) => StatisticsEvidenceSnapshotView;
  readonly freezeInTransaction: (input: {
    readonly commandId: string;
    readonly evidenceSnapshotId: string;
    readonly query: StatisticsInspectInput;
    readonly actor: StatisticsAuthorActor;
  }) => StatisticsEvidenceSnapshotView;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalIds = (values: readonly string[] | undefined): string[] =>
  [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));

const canonicalFilters = (
  filters:
    | {
        readonly departmentIds?: readonly string[];
        readonly aiMemberIds?: readonly string[];
        readonly modelIds?: readonly string[];
        readonly repositoryIds?: readonly string[];
        readonly workPackageIds?: readonly string[];
        readonly pipelineVersionIds?: readonly string[];
      }
    | undefined,
): StatisticsCanonicalFilters => ({
  departmentIds: canonicalIds(filters?.departmentIds),
  aiMemberIds: canonicalIds(filters?.aiMemberIds),
  modelIds: canonicalIds(filters?.modelIds),
  repositoryIds: canonicalIds(filters?.repositoryIds),
  workPackageIds: canonicalIds(filters?.workPackageIds),
  pipelineVersionIds: canonicalIds(filters?.pipelineVersionIds),
});

const canonicalQuery = (
  input: StatisticsInspectInput,
): StatisticsCanonicalQuery => {
  const parsed = StatisticsInspectInputSchema.parse(input);
  return StatisticsCanonicalQuerySchema.parse({
    catalogVersion: parsed.catalogVersion ?? "statistics@1",
    projectId: parsed.projectId,
    filters: canonicalFilters(parsed.filters),
    window: parsed.window,
    cohort: {
      id: parsed.cohort.id,
      filters: canonicalFilters(parsed.cohort.filters),
    },
    comparisonSet: {
      id: parsed.comparisonSet.id,
      metricIds: canonicalIds(parsed.comparisonSet.metricIds),
    },
  });
};

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StatisticsRuntimeError(
      "STATISTICS_EVIDENCE_INVALID",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

const dimensionAttributionUnavailable = (
  metricId: StatisticsMetricId,
): StatisticsMetricObservation => ({
  metricId,
  status: "unavailable",
  reason:
    "The selected Statistics dimensions are not present on the authoritative source facts.",
  unavailableReasonCode: "missing-dimension-attribution",
  sourceFactFamily: "statistics-dimension-attribution",
  sourceFactRefs: [],
});

export const openStatisticsRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append" | "latestSequence">;
    readonly clock?: () => Date;
  },
): StatisticsRuntime => {
  const clock = options.clock ?? (() => new Date());

  const runPredicate = (
    query: StatisticsCanonicalQuery,
    alias: string,
  ): { readonly sql: string; readonly values: readonly string[] } => {
    const clauses = [`${alias}.project_id = ?`];
    const values: string[] = [query.projectId];
    if (query.filters.departmentIds.length > 0) {
      clauses.push(
        `${alias}.department_id IN (${query.filters.departmentIds.map(() => "?").join(", ")})`,
      );
      values.push(...query.filters.departmentIds);
    }
    if (query.filters.pipelineVersionIds.length > 0) {
      clauses.push(
        `${alias}.pipeline_version_id IN (${query.filters.pipelineVersionIds.map(() => "?").join(", ")})`,
      );
      values.push(...query.filters.pipelineVersionIds);
    }
    return { sql: clauses.join(" AND "), values };
  };

  const unsupportedDimensionSelected = (
    query: StatisticsCanonicalQuery,
  ): boolean =>
    query.filters.aiMemberIds.length > 0 ||
    query.filters.modelIds.length > 0 ||
    query.filters.repositoryIds.length > 0 ||
    query.filters.workPackageIds.length > 0;

  const countObservation = (
    metricId: StatisticsMetricId,
    sourceFactFamily: string,
    refs: readonly string[],
  ): StatisticsMetricObservation =>
    StatisticsMetricObservationSchema.parse({
      metricId,
      status: "available",
      measurement: { kind: "count", value: refs.length },
      sourceFactFamily,
      sourceFactRefs: refs,
    });

  const observe = (
    metricId: StatisticsMetricId,
    query: StatisticsCanonicalQuery,
  ): StatisticsMetricObservation => {
    if (unsupportedDimensionSelected(query)) {
      return dimensionAttributionUnavailable(metricId);
    }
    const run = runPredicate(query, "runs");
    const { startInclusive, endExclusive } = query.window;
    switch (metricId) {
      case "product-baseline-confirmation-count": {
        const rows = database
          .prepare(
            `SELECT baselines.id
               FROM product_baselines AS baselines
               JOIN department_runs AS runs ON runs.id = baselines.run_id
              WHERE ${run.sql}
                AND baselines.confirmed_at >= ?
                AND baselines.confirmed_at < ?
              ORDER BY baselines.confirmed_at, baselines.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        return countObservation(
          metricId,
          "product-baseline",
          rows.map((row) => row.id),
        );
      }
      case "product-baseline-confirmation-latency": {
        const rows = database
          .prepare(
            `SELECT baselines.id,
                    proposals.created_at AS proposedAt,
                    baselines.confirmed_at AS confirmedAt
               FROM product_baselines AS baselines
               JOIN department_runs AS runs ON runs.id = baselines.run_id
               JOIN product_proposal_revisions AS proposals
                 ON proposals.id = baselines.source_proposal_revision_id
              WHERE ${run.sql}
                AND baselines.confirmed_at >= ?
                AND baselines.confirmed_at < ?
              ORDER BY baselines.confirmed_at, baselines.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly proposedAt: string;
          readonly confirmedAt: string;
        }>;
        if (rows.length === 0) {
          return {
            metricId,
            status: "unavailable",
            reason:
              "No paired Product proposal and confirmation timestamps exist.",
            unavailableReasonCode: "missing-paired-timestamps",
            sourceFactFamily: "product-baseline",
            sourceFactRefs: [],
          };
        }
        const durations = rows.map(
          (row) => Date.parse(row.confirmedAt) - Date.parse(row.proposedAt),
        );
        if (
          durations.some(
            (duration) => !Number.isFinite(duration) || duration < 0,
          )
        ) {
          return {
            metricId,
            status: "incomplete",
            reason: "A Product Baseline has invalid paired timestamps.",
            missingFactKinds: ["valid-product-baseline-timestamp-pair"],
            sourceFactFamily: "product-baseline",
            sourceFactRefs: rows.map((row) => row.id),
          };
        }
        return {
          metricId,
          status: "available",
          measurement: {
            kind: "duration",
            milliseconds:
              durations.reduce((total, duration) => total + duration, 0) /
              durations.length,
          },
          sourceFactFamily: "product-baseline",
          sourceFactRefs: rows.map((row) => row.id),
        };
      }
      case "review-finding-count": {
        const rows = database
          .prepare(
            `SELECT findings.id
               FROM review_findings AS findings
               JOIN review_topics AS topics ON topics.id = findings.topic_id
               JOIN department_runs AS runs ON runs.id = topics.run_id
              WHERE ${run.sql}
                AND findings.created_at >= ?
                AND findings.created_at < ?
              ORDER BY findings.created_at, findings.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        return countObservation(
          metricId,
          "review-finding",
          rows.map((row) => row.id),
        );
      }
      case "review-discussion-round-count": {
        const rows = database
          .prepare(
            `SELECT discussions.id
               FROM review_discussions AS discussions
               JOIN review_topics AS topics ON topics.id = discussions.topic_id
               JOIN department_runs AS runs ON runs.id = topics.run_id
              WHERE ${run.sql}
                AND discussions.opened_at >= ?
                AND discussions.opened_at < ?
              ORDER BY discussions.opened_at, discussions.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        return countObservation(
          metricId,
          "review-discussion",
          rows.map((row) => row.id),
        );
      }
      case "review-recheck-pass-rate": {
        const rows = database
          .prepare(
            `SELECT rechecks.id, rechecks.result
               FROM review_rechecks AS rechecks
               JOIN review_topics AS topics ON topics.id = rechecks.topic_id
               JOIN department_runs AS runs ON runs.id = topics.run_id
              WHERE ${run.sql}
                AND rechecks.created_at >= ?
                AND rechecks.created_at < ?
              ORDER BY rechecks.created_at, rechecks.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly result: string;
        }>;
        if (rows.length === 0) {
          return {
            metricId,
            status: "unavailable",
            reason: "No authoritative Review recheck denominator exists.",
            unavailableReasonCode: "missing-denominator-authority",
            sourceFactFamily: "review-recheck",
            sourceFactRefs: [],
          };
        }
        const numerator = rows.filter((row) => row.result === "PASS").length;
        return {
          metricId,
          status: "available",
          measurement: {
            kind: "rate",
            numerator,
            denominator: rows.length,
            value: numerator / rows.length,
          },
          sourceFactFamily: "review-recheck",
          sourceFactRefs: rows.map((row) => row.id),
        };
      }
      case "readiness-blocker-count": {
        const rows = database
          .prepare(
            `SELECT readiness.id
               FROM product_readiness_evidence AS readiness
               JOIN department_runs AS runs ON runs.id = readiness.run_id
              WHERE ${run.sql}
                AND readiness.status = 'blocked'
                AND readiness.created_at >= ?
                AND readiness.created_at < ?
              ORDER BY readiness.created_at, readiness.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        return countObservation(
          metricId,
          "product-readiness",
          rows.map((row) => row.id),
        );
      }
      default:
        return {
          metricId,
          status: "unavailable",
          reason: `${metricId} is not implemented by this Statistics Runtime slice.`,
          unavailableReasonCode: "unsupported-by-statistics-at-1",
          sourceFactFamily: "statistics@1",
          sourceFactRefs: [],
        };
    }
  };

  const inspect = (input: StatisticsInspectInput): StatisticsView => {
    const query = canonicalQuery(input);
    const project = database
      .prepare("SELECT 1 AS present FROM projects WHERE id = ?")
      .get(query.projectId);
    if (!project) {
      throw new StatisticsRuntimeError(
        "PROJECT_NOT_FOUND",
        `Project ${query.projectId} was not found.`,
      );
    }
    const observations = query.comparisonSet.metricIds.map((metricId) =>
      observe(metricId, query),
    );
    const incompleteMetricIds = observations
      .filter((observation) => observation.status === "incomplete")
      .map((observation) => observation.metricId);
    const unavailableMetricIds = observations
      .filter((observation) => observation.status === "unavailable")
      .map((observation) => observation.metricId);
    return StatisticsViewSchema.parse({
      query,
      asOfSequence: options.events.latestSequence(),
      observations,
      completeness: {
        status:
          unavailableMetricIds.length > 0
            ? "unavailable"
            : incompleteMetricIds.length > 0
              ? "incomplete"
              : "complete",
        incompleteMetricIds,
        unavailableMetricIds,
      },
      generatedAt: clock().toISOString(),
    });
  };

  const inspectEvidence = (
    evidenceSnapshotId: string,
  ): StatisticsEvidenceSnapshotView => {
    const row = database
      .prepare(
        `SELECT id, canonical_query_json AS queryJson, query_hash AS queryHash,
                as_of_sequence AS asOfSequence,
                observations_json AS observationsJson,
                completeness_json AS completenessJson,
                frozen_by_actor_type AS actorType,
                frozen_by_actor_id AS actorId,
                frozen_by_authenticated_by AS authenticatedBy,
                snapshot_hash AS hash, created_at AS createdAt
           FROM statistics_evidence_snapshots WHERE id = ?`,
      )
      .get(evidenceSnapshotId) as
      | {
          readonly id: string;
          readonly queryJson: string;
          readonly queryHash: string;
          readonly asOfSequence: number;
          readonly observationsJson: string;
          readonly completenessJson: string;
          readonly actorType: "human" | "runtime-worker";
          readonly actorId: string;
          readonly authenticatedBy: "local-session" | "runtime";
          readonly hash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new StatisticsRuntimeError(
        "STATISTICS_EVIDENCE_NOT_FOUND",
        `Statistics evidence snapshot ${evidenceSnapshotId} was not found.`,
      );
    }
    return StatisticsEvidenceSnapshotViewSchema.parse({
      id: row.id,
      query: parseJson(row.queryJson, "Statistics evidence query"),
      queryHash: row.queryHash,
      asOfSequence: row.asOfSequence,
      observations: parseJson(
        row.observationsJson,
        "Statistics evidence observations",
      ),
      completeness: parseJson(
        row.completenessJson,
        "Statistics evidence completeness",
      ),
      frozenBy: {
        type: row.actorType,
        id: row.actorId,
        authenticatedBy: row.authenticatedBy,
      },
      hash: row.hash,
      createdAt: row.createdAt,
    });
  };

  const freezeInTransaction: StatisticsRuntime["freezeInTransaction"] = (
    input,
  ) => {
    const existing = database
      .prepare(
        "SELECT command_id AS commandId FROM statistics_evidence_snapshots WHERE id = ?",
      )
      .get(input.evidenceSnapshotId) as
      | { readonly commandId: string }
      | undefined;
    if (existing) {
      if (existing.commandId !== input.commandId) {
        throw new StatisticsRuntimeError(
          "STATISTICS_EVIDENCE_STALE",
          `Statistics evidence snapshot ${input.evidenceSnapshotId} already exists.`,
        );
      }
      return inspectEvidence(input.evidenceSnapshotId);
    }
    const live = inspect(input.query);
    const queryJson = canonicalJson(live.query);
    const observationsJson = canonicalJson(live.observations);
    const completenessJson = canonicalJson(live.completeness);
    const queryHash = sha256(queryJson);
    const createdAt = clock().toISOString();
    const snapshotWithoutHash = {
      id: input.evidenceSnapshotId,
      query: live.query,
      queryHash,
      asOfSequence: live.asOfSequence,
      observations: live.observations,
      completeness: live.completeness,
      frozenBy: input.actor,
      createdAt,
    };
    const snapshot = StatisticsEvidenceSnapshotViewSchema.parse({
      ...snapshotWithoutHash,
      hash: sha256(canonicalJson(snapshotWithoutHash)),
    });
    database
      .prepare(
        `INSERT INTO statistics_evidence_snapshots(
           id, project_id, catalog_version, canonical_query_json, query_hash,
           as_of_sequence, observations_json, completeness_json,
           frozen_by_actor_type, frozen_by_actor_id, frozen_by_authenticated_by,
           snapshot_hash, command_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.query.projectId,
        snapshot.query.catalogVersion,
        queryJson,
        snapshot.queryHash,
        snapshot.asOfSequence,
        observationsJson,
        completenessJson,
        snapshot.frozenBy.type,
        snapshot.frozenBy.id,
        snapshot.frozenBy.authenticatedBy,
        snapshot.hash,
        input.commandId,
        snapshot.createdAt,
      );
    const auditId = randomUUID();
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, 'statistics.evidence.freeze', 'statistics-evidence', ?,
                   NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        auditId,
        snapshot.id,
        canonicalJson({ hash: snapshot.hash, queryHash: snapshot.queryHash }),
        createdAt,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    options.events.append({
      type: "statistics.evidence.invalidated",
      scope: {
        companyId: "company",
        projectId: snapshot.query.projectId,
        statisticsEvidenceSnapshotId: snapshot.id,
        commandId: input.commandId,
      },
      payload: {
        evidenceSnapshotId: snapshot.id,
        catalogVersion: snapshot.query.catalogVersion,
      },
      timestamp: createdAt,
    });
    return snapshot;
  };

  return { inspect, inspectEvidence, freezeInTransaction };
};
