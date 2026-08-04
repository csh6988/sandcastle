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

  const missingDenominator = (
    metricId: StatisticsMetricId,
    sourceFactFamily: string,
    reason: string,
  ): StatisticsMetricObservation => ({
    metricId,
    status: "unavailable",
    reason,
    unavailableReasonCode: "missing-denominator-authority",
    sourceFactFamily,
    sourceFactRefs: [],
  });

  const rateObservation = (
    metricId: StatisticsMetricId,
    sourceFactFamily: string,
    numerator: number,
    denominator: number,
    refs: readonly string[],
  ): StatisticsMetricObservation =>
    StatisticsMetricObservationSchema.parse({
      metricId,
      status: "available",
      measurement: {
        kind: "rate",
        numerator,
        denominator,
        value: numerator / denominator,
      },
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
      case "governed-execution-concurrency": {
        const rows = database
          .prepare(
            `SELECT leases.id, leases.issued_at AS issuedAt,
                    leases.expires_at AS expiresAt,
                    leases.released_at AS releasedAt
               FROM execution_leases AS leases
               JOIN node_attempts AS attempts ON attempts.id = leases.target_id
               JOIN node_runs AS nodes ON nodes.id = attempts.node_run_id
               JOIN department_runs AS runs ON runs.id = nodes.run_id
              WHERE ${run.sql}
                AND leases.target_kind = 'node-attempt'
                AND leases.lease_kind = 'execution'
                AND leases.issued_at < ?
                AND COALESCE(leases.released_at, leases.expires_at) > ?
              ORDER BY leases.issued_at, leases.id`,
          )
          .all(...run.values, endExclusive, startInclusive) as Array<{
          readonly id: string;
          readonly issuedAt: string;
          readonly expiresAt: string;
          readonly releasedAt: string | null;
        }>;
        const windowStart = Date.parse(startInclusive);
        const windowEnd = Date.parse(endExclusive);
        const boundaries = rows.flatMap((row) => {
          const start = Math.max(Date.parse(row.issuedAt), windowStart);
          const end = Math.min(
            Date.parse(row.releasedAt ?? row.expiresAt),
            windowEnd,
          );
          return [
            { at: start, delta: 1 },
            { at: end, delta: -1 },
          ];
        });
        boundaries.sort((left, right) =>
          left.at === right.at ? left.delta - right.delta : left.at - right.at,
        );
        let active = 0;
        let maximum = 0;
        for (const boundary of boundaries) {
          active += boundary.delta;
          maximum = Math.max(maximum, active);
        }
        return {
          metricId,
          status: "available",
          measurement: {
            kind: "concurrency",
            maximum,
            intervalCount: rows.length,
          },
          sourceFactFamily: "execution-lease",
          sourceFactRefs: rows.map((row) => row.id),
        };
      }
      case "ordinary-retry-count":
      case "recovery-attempt-count": {
        const reason =
          metricId === "ordinary-retry-count" ? "retry" : "recovery";
        const rows = database
          .prepare(
            `SELECT attempts.id
               FROM node_attempts AS attempts
               JOIN node_runs AS nodes ON nodes.id = attempts.node_run_id
               JOIN department_runs AS runs ON runs.id = nodes.run_id
              WHERE ${run.sql}
                AND attempts.reason = ?
                AND attempts.created_at >= ?
                AND attempts.created_at < ?
              ORDER BY attempts.created_at, attempts.id`,
          )
          .all(...run.values, reason, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        return countObservation(
          metricId,
          "node-attempt",
          rows.map((row) => row.id),
        );
      }
      case "department-run-failure-rate": {
        const rows = database
          .prepare(
            `SELECT runs.id, runs.status
               FROM department_runs AS runs
              WHERE ${run.sql}
                AND runs.status IN ('completed', 'failed')
                AND runs.updated_at >= ?
                AND runs.updated_at < ?
              ORDER BY runs.updated_at, runs.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly status: string;
        }>;
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "department-run",
            "No completed or failed Department Run denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "department-run",
          rows.filter((row) => row.status === "failed").length,
          rows.length,
          rows.map((row) => row.id),
        );
      }
      case "node-attempt-failure-rate": {
        const rows = database
          .prepare(
            `SELECT attempts.id, attempts.status
               FROM node_attempts AS attempts
               JOIN node_runs AS nodes ON nodes.id = attempts.node_run_id
               JOIN department_runs AS runs ON runs.id = nodes.run_id
              WHERE ${run.sql}
                AND attempts.status IN ('succeeded', 'failed')
                AND attempts.completed_at >= ?
                AND attempts.completed_at < ?
              ORDER BY attempts.completed_at, attempts.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly status: string;
        }>;
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "node-attempt",
            "No succeeded or failed Node Attempt denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "node-attempt",
          rows.filter((row) => row.status === "failed").length,
          rows.length,
          rows.map((row) => row.id),
        );
      }
      case "lease-interruption-rate": {
        const rows = database
          .prepare(
            `SELECT leases.id, leases.expires_at AS expiresAt,
                    leases.released_at AS releasedAt
               FROM execution_leases AS leases
               JOIN node_attempts AS attempts ON attempts.id = leases.target_id
               JOIN node_runs AS nodes ON nodes.id = attempts.node_run_id
               JOIN department_runs AS runs ON runs.id = nodes.run_id
              WHERE ${run.sql}
                AND leases.target_kind = 'node-attempt'
                AND leases.lease_kind = 'execution'
                AND COALESCE(leases.released_at, leases.expires_at) >= ?
                AND COALESCE(leases.released_at, leases.expires_at) < ?
              ORDER BY COALESCE(leases.released_at, leases.expires_at), leases.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly expiresAt: string;
          readonly releasedAt: string | null;
        }>;
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "execution-lease",
            "No ended execution Lease denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "execution-lease",
          rows.filter(
            (row) =>
              row.releasedAt === null ||
              Date.parse(row.releasedAt) >= Date.parse(row.expiresAt),
          ).length,
          rows.length,
          rows.map((row) => row.id),
        );
      }
      case "human-approval-wait": {
        const rows = database
          .prepare(
            `SELECT approvals.id, approvals.created_at AS createdAt,
                    CASE
                      WHEN approvals.status = 'decided' THEN approvals.decided_at
                      WHEN approvals.status = 'expired' THEN approvals.expired_at
                      ELSE NULL
                    END AS terminalAt
               FROM approvals
               JOIN department_runs AS runs ON runs.id = approvals.run_id
              WHERE ${run.sql}
                AND approvals.created_at >= ?
                AND approvals.created_at < ?
              ORDER BY approvals.created_at, approvals.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly createdAt: string;
          readonly terminalAt: string | null;
        }>;
        if (rows.length === 0) {
          return {
            metricId,
            status: "unavailable",
            reason: "No paired human Approval timestamps exist.",
            unavailableReasonCode: "missing-paired-timestamps",
            sourceFactFamily: "approval",
            sourceFactRefs: [],
          };
        }
        const durations = rows.map((row) =>
          row.terminalAt === null
            ? Number.NaN
            : Date.parse(row.terminalAt) - Date.parse(row.createdAt),
        );
        if (
          durations.some(
            (duration) => !Number.isFinite(duration) || duration < 0,
          )
        ) {
          return {
            metricId,
            status: "incomplete",
            reason: "A human Approval lacks a valid terminal timestamp.",
            missingFactKinds: ["valid-human-approval-timestamp-pair"],
            sourceFactFamily: "approval",
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
          sourceFactFamily: "approval",
          sourceFactRefs: rows.map((row) => row.id),
        };
      }
      case "governed-intervention-rate": {
        const unattributed = database
          .prepare(
            `SELECT interventions.id
               FROM governed_interventions AS interventions
               JOIN department_runs AS runs ON runs.id = interventions.run_id
              WHERE ${run.sql}
                AND interventions.attempt_id IS NULL
                AND interventions.created_at >= ?
                AND interventions.created_at < ?
              ORDER BY interventions.created_at, interventions.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        if (unattributed.length > 0) {
          return {
            metricId,
            status: "incomplete",
            reason:
              "A governed intervention does not identify its affected Node Attempt.",
            missingFactKinds: ["governed-intervention-attempt-attribution"],
            sourceFactFamily: "governed-intervention",
            sourceFactRefs: unattributed.map((row) => row.id),
          };
        }
        const attempts = database
          .prepare(
            `SELECT attempts.id
               FROM node_attempts AS attempts
               JOIN node_runs AS nodes ON nodes.id = attempts.node_run_id
               JOIN department_runs AS runs ON runs.id = nodes.run_id
              WHERE ${run.sql}
                AND attempts.created_at >= ?
                AND attempts.created_at < ?
              ORDER BY attempts.created_at, attempts.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        if (attempts.length === 0) {
          return missingDenominator(
            metricId,
            "governed-intervention",
            "No Node Attempt denominator exists for governed interventions.",
          );
        }
        const interventions = database
          .prepare(
            `SELECT interventions.id, interventions.attempt_id AS attemptId
               FROM governed_interventions AS interventions
               JOIN node_attempts AS attempts
                 ON attempts.id = interventions.attempt_id
               JOIN node_runs AS nodes ON nodes.id = attempts.node_run_id
               JOIN department_runs AS runs ON runs.id = nodes.run_id
              WHERE ${run.sql}
                AND attempts.created_at >= ?
                AND attempts.created_at < ?
                AND interventions.created_at >= ?
                AND interventions.created_at < ?
              ORDER BY interventions.created_at, interventions.id`,
          )
          .all(
            ...run.values,
            startInclusive,
            endExclusive,
            startInclusive,
            endExclusive,
          ) as Array<{ readonly id: string; readonly attemptId: string }>;
        const intervenedAttemptIds = new Set(
          interventions.map((row) => row.attemptId),
        );
        return rateObservation(
          metricId,
          "governed-intervention",
          intervenedAttemptIds.size,
          attempts.length,
          [
            ...attempts.map((row) => row.id),
            ...interventions.map((row) => row.id),
          ],
        );
      }
      case "code-review-defect-incidence": {
        const rows = database
          .prepare(
            `SELECT manifests.id AS manifestId, defects.id AS defectId
               FROM code_review_manifests AS manifests
               JOIN department_runs AS runs ON runs.id = manifests.run_id
               LEFT JOIN code_review_defects AS defects
                 ON defects.code_review_manifest_id = manifests.id
              WHERE ${run.sql}
                AND manifests.created_at >= ?
                AND manifests.created_at < ?
              ORDER BY manifests.created_at, manifests.id, defects.created_at,
                       defects.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly manifestId: string;
          readonly defectId: string | null;
        }>;
        const manifestIds = new Set(rows.map((row) => row.manifestId));
        if (manifestIds.size === 0) {
          return missingDenominator(
            metricId,
            "code-review-manifest",
            "No Code Review manifest denominator exists.",
          );
        }
        const defectiveManifestIds = new Set(
          rows
            .filter((row) => row.defectId !== null)
            .map((row) => row.manifestId),
        );
        return rateObservation(
          metricId,
          "code-review-manifest",
          defectiveManifestIds.size,
          manifestIds.size,
          canonicalIds(
            rows.flatMap((row) =>
              row.defectId === null
                ? [row.manifestId]
                : [row.manifestId, row.defectId],
            ),
          ),
        );
      }
      case "integration-conflict-rate": {
        const unattributed = database
          .prepare(
            `SELECT defects.id
               FROM integration_defects AS defects
               JOIN integration_generations AS generations
                 ON generations.id = defects.generation_id
               JOIN department_runs AS runs ON runs.id = generations.run_id
              WHERE ${run.sql}
                AND defects.kind = 'git-conflict'
                AND defects.integration_operation_id IS NULL
                AND defects.created_at >= ?
                AND defects.created_at < ?
              ORDER BY defects.created_at, defects.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
        }>;
        if (unattributed.length > 0) {
          return {
            metricId,
            status: "incomplete",
            reason:
              "An Integration conflict does not identify its exact Integration operation.",
            missingFactKinds: ["integration-conflict-operation-attribution"],
            sourceFactFamily: "integration-operation",
            sourceFactRefs: unattributed.map((row) => row.id),
          };
        }
        const rows = database
          .prepare(
            `SELECT operations.id AS operationId, defects.id AS defectId
               FROM integration_operations AS operations
               JOIN integration_generations AS generations
                 ON generations.id = operations.generation_id
               JOIN department_runs AS runs ON runs.id = generations.run_id
               LEFT JOIN integration_defects AS defects
                 ON defects.integration_operation_id = operations.id
                AND defects.kind = 'git-conflict'
                AND defects.created_at >= ?
                AND defects.created_at < ?
              WHERE ${run.sql}
                AND operations.created_at >= ?
                AND operations.created_at < ?
              ORDER BY operations.created_at, operations.id, defects.created_at,
                       defects.id`,
          )
          .all(
            startInclusive,
            endExclusive,
            ...run.values,
            startInclusive,
            endExclusive,
          ) as Array<{
          readonly operationId: string;
          readonly defectId: string | null;
        }>;
        const operationIds = new Set(rows.map((row) => row.operationId));
        if (operationIds.size === 0) {
          return missingDenominator(
            metricId,
            "integration-operation",
            "No Integration operation denominator exists.",
          );
        }
        const conflictedOperationIds = new Set(
          rows
            .filter((row) => row.defectId !== null)
            .map((row) => row.operationId),
        );
        return rateObservation(
          metricId,
          "integration-operation",
          conflictedOperationIds.size,
          operationIds.size,
          canonicalIds(
            rows.flatMap((row) =>
              row.defectId === null
                ? [row.operationId]
                : [row.operationId, row.defectId],
            ),
          ),
        );
      }
      case "test-pass-rate": {
        const rows = database
          .prepare(
            `SELECT tests.id, tests.state
               FROM test_runs AS tests
               JOIN department_runs AS runs ON runs.id = tests.run_id
              WHERE ${run.sql}
                AND tests.state IN ('passed', 'failed')
                AND tests.updated_at >= ?
                AND tests.updated_at < ?
              ORDER BY tests.updated_at, tests.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly state: string;
        }>;
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "test-run",
            "No passed or failed Test run denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "test-run",
          rows.filter((row) => row.state === "passed").length,
          rows.length,
          rows.map((row) => row.id),
        );
      }
      case "electron-ui-runtime-mismatch-rate": {
        const rows = database
          .prepare(
            `SELECT assertions.id, assertions.ui_status AS uiStatus,
                    assertions.runtime_status AS runtimeStatus
               FROM test_assertion_results AS assertions
               JOIN test_runs AS tests ON tests.id = assertions.test_run_id
               JOIN department_runs AS runs ON runs.id = tests.run_id
              WHERE ${run.sql}
                AND assertions.created_at >= ?
                AND assertions.created_at < ?
              ORDER BY assertions.created_at, assertions.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly uiStatus: "passed" | "failed" | "missing" | "unknown";
          readonly runtimeStatus: "passed" | "failed" | "missing" | "unknown";
        }>;
        const incomplete = rows.filter(
          (row) =>
            row.uiStatus === "missing" ||
            row.uiStatus === "unknown" ||
            row.runtimeStatus === "missing" ||
            row.runtimeStatus === "unknown",
        );
        if (incomplete.length > 0) {
          return {
            metricId,
            status: "incomplete",
            reason:
              "An Electron assertion lacks an exact UI and Runtime result pair.",
            missingFactKinds: ["exact-electron-ui-runtime-result-pair"],
            sourceFactFamily: "test-assertion-result",
            sourceFactRefs: incomplete.map((row) => row.id),
          };
        }
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "test-assertion-result",
            "No exact Electron UI and Runtime assertion denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "test-assertion-result",
          rows.filter((row) => row.uiStatus !== row.runtimeStatus).length,
          rows.length,
          rows.map((row) => row.id),
        );
      }
      case "delivery-candidate-acceptance-rate": {
        const rows = database
          .prepare(
            `SELECT decisions.id, decisions.decision
               FROM human_release_decisions AS decisions
               JOIN delivery_candidates AS candidates
                 ON candidates.id = decisions.candidate_id
               JOIN department_runs AS runs ON runs.id = candidates.run_id
              WHERE ${run.sql}
                AND decisions.created_at >= ?
                AND decisions.created_at < ?
              ORDER BY decisions.created_at, decisions.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly decision: string;
        }>;
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "human-release-decision",
            "No human Release decision denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "human-release-decision",
          rows.filter((row) => row.decision === "accepted").length,
          rows.length,
          rows.map((row) => row.id),
        );
      }
      case "release-item-success-rate": {
        const rows = database
          .prepare(
            `SELECT items.id, items.state
               FROM release_operation_items AS items
               JOIN release_operations AS operations
                 ON operations.id = items.operation_id
               JOIN delivery_candidates AS candidates
                 ON candidates.id = operations.candidate_id
               JOIN department_runs AS runs ON runs.id = candidates.run_id
              WHERE ${run.sql}
                AND items.updated_at >= ?
                AND items.updated_at < ?
              ORDER BY items.updated_at, items.id`,
          )
          .all(...run.values, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly state: string;
        }>;
        const unknown = rows.filter((row) => row.state === "unknown");
        if (unknown.length > 0) {
          return {
            metricId,
            status: "incomplete",
            reason: "A Release item has an unknown terminal outcome.",
            missingFactKinds: ["release-item-terminal-outcome"],
            sourceFactFamily: "release-operation-item",
            sourceFactRefs: unknown.map((row) => row.id),
          };
        }
        const terminal = rows.filter((row) =>
          ["succeeded", "failed", "destination-conflict"].includes(row.state),
        );
        if (terminal.length === 0) {
          return missingDenominator(
            metricId,
            "release-operation-item",
            "No terminal Release item denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "release-operation-item",
          terminal.filter((row) => row.state === "succeeded").length,
          terminal.length,
          terminal.map((row) => row.id),
        );
      }
      case "memory-promotion-rate": {
        if (
          query.filters.departmentIds.length > 0 ||
          query.filters.pipelineVersionIds.length > 0
        ) {
          return dimensionAttributionUnavailable(metricId);
        }
        const rows = database
          .prepare(
            `SELECT decisions.id, decisions.decision, entries.id AS entryId
               FROM reviewed_memory_decisions AS decisions
               JOIN reviewed_memory_candidate_revisions AS revisions
                 ON revisions.id = decisions.candidate_revision_id
               LEFT JOIN reviewed_memory_entries AS entries
                 ON entries.decision_id = decisions.id
              WHERE revisions.project_id = ?
                AND decisions.created_at >= ?
                AND decisions.created_at < ?
              ORDER BY decisions.created_at, decisions.id`,
          )
          .all(query.projectId, startInclusive, endExclusive) as Array<{
          readonly id: string;
          readonly decision: string;
          readonly entryId: string | null;
        }>;
        const missingEntries = rows.filter(
          (row) => row.decision === "accepted" && row.entryId === null,
        );
        if (missingEntries.length > 0) {
          return {
            metricId,
            status: "incomplete",
            reason:
              "An accepted reviewed Memory decision lacks its promoted Memory entry.",
            missingFactKinds: ["accepted-memory-entry"],
            sourceFactFamily: "reviewed-memory-decision",
            sourceFactRefs: missingEntries.map((row) => row.id),
          };
        }
        if (rows.length === 0) {
          return missingDenominator(
            metricId,
            "reviewed-memory-decision",
            "No reviewed Memory decision denominator exists.",
          );
        }
        return rateObservation(
          metricId,
          "reviewed-memory-decision",
          rows.filter((row) => row.decision === "accepted").length,
          rows.length,
          canonicalIds(
            rows.flatMap((row) =>
              row.entryId === null ? [row.id] : [row.id, row.entryId],
            ),
          ),
        );
      }
      case "memory-selection-rate": {
        if (
          query.filters.departmentIds.length > 0 ||
          query.filters.pipelineVersionIds.length > 0
        ) {
          return dimensionAttributionUnavailable(metricId);
        }
        const rows = database
          .prepare(
            `SELECT entries.id AS entryId, selections.id AS selectionId
               FROM reviewed_memory_entries AS entries
               LEFT JOIN run_memory_selections AS selections
                 ON selections.entry_id = entries.id
                AND selections.created_at >= ?
                AND selections.created_at < ?
              WHERE entries.project_id = ?
                AND entries.created_at >= ?
                AND entries.created_at < ?
              ORDER BY entries.created_at, entries.id, selections.created_at,
                       selections.id`,
          )
          .all(
            startInclusive,
            endExclusive,
            query.projectId,
            startInclusive,
            endExclusive,
          ) as Array<{
          readonly entryId: string;
          readonly selectionId: string | null;
        }>;
        const entryIds = new Set(rows.map((row) => row.entryId));
        if (entryIds.size === 0) {
          return missingDenominator(
            metricId,
            "reviewed-memory-entry",
            "No promoted Memory entry denominator exists.",
          );
        }
        const selectedEntryIds = new Set(
          rows
            .filter((row) => row.selectionId !== null)
            .map((row) => row.entryId),
        );
        return rateObservation(
          metricId,
          "reviewed-memory-entry",
          selectedEntryIds.size,
          entryIds.size,
          canonicalIds(
            rows.flatMap((row) =>
              row.selectionId === null
                ? [row.entryId]
                : [row.entryId, row.selectionId],
            ),
          ),
        );
      }
      case "security-operability-high-risk-closure-rate":
        return {
          metricId,
          status: "unavailable",
          reason:
            "statistics@1 lacks exact Security and Operability high-risk closure lineage.",
          unavailableReasonCode: "unsupported-by-statistics-at-1",
          sourceFactFamily: "security-operability-risk",
          sourceFactRefs: [],
        };
      case "whole-run-token-cost":
        return {
          metricId,
          status: "unavailable",
          reason:
            "statistics@1 lacks complete immutable whole-Run Token and cost facts.",
          unavailableReasonCode: "unsupported-by-statistics-at-1",
          sourceFactFamily: "run-token-cost",
          sourceFactRefs: [],
        };
      case "complete-model-attribution":
        return {
          metricId,
          status: "unavailable",
          reason:
            "statistics@1 lacks complete exact Model attribution across governed executions.",
          unavailableReasonCode: "unsupported-by-statistics-at-1",
          sourceFactFamily: "model-attribution",
          sourceFactRefs: [],
        };
      case "heterogeneous-defect-aggregate-rate":
        return {
          metricId,
          status: "unavailable",
          reason:
            "statistics@1 has no comparable denominator across heterogeneous Defect kinds.",
          unavailableReasonCode: "unsupported-by-statistics-at-1",
          sourceFactFamily: "heterogeneous-defect",
          sourceFactRefs: [],
        };
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
