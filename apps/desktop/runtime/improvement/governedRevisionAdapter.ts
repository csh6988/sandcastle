import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ImprovementTargetSchema,
  type GovernedHead,
  type GovernedRevisionRef,
  type ImprovementApplicationEffectAdapter,
  type ImprovementTarget,
} from "./improvementProposalContracts.js";

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
const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");

export const deterministicGovernedRevisionId = (input: {
  readonly operationId: string;
  readonly targetKind: ImprovementTarget["targetKind"];
  readonly phase: "apply" | "rollback";
}): string => `improvement-revision:${sha256(input).slice(0, 48)}`;

export class GovernedRevisionAdapterError extends Error {
  constructor(
    readonly code:
      | "IMPROVEMENT_TARGET_CONFLICT"
      | "IMPROVEMENT_TARGET_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "GovernedRevisionAdapterError";
  }
}

const sameHead = (
  actual: GovernedRevisionRef | null,
  expected: GovernedHead,
): boolean =>
  actual === null
    ? expected.revisionId === null && expected.revisionHash === null
    : actual.revisionId === expected.revisionId &&
      actual.revisionHash === expected.revisionHash;

export const openSqliteGovernedRevisionAdapter = (
  database: DatabaseSync,
  options: { readonly clock?: () => Date } = {},
): ImprovementApplicationEffectAdapter => {
  const clock = options.clock ?? (() => new Date());

  const requireSupportedTarget = (target: ImprovementTarget) => {
    const parsed = ImprovementTargetSchema.parse(target);
    if (
      parsed.targetKind === "template" ||
      parsed.targetKind === "skill-flow"
    ) {
      throw new GovernedRevisionAdapterError(
        "IMPROVEMENT_TARGET_UNSUPPORTED",
        `Target kind ${parsed.targetKind} is not supported by this governed revision Adapter slice.`,
      );
    }
    return parsed;
  };

  const revisionHash = (
    target: ReturnType<typeof requireSupportedTarget>,
  ): string =>
    target.targetKind === "application-spec"
      ? sha256({
          applicationId: target.content.lineage.applicationId,
          promotedProjectSpecRevisionId:
            target.content.lineage.promotedProjectSpecRevisionId,
          promotedProjectSpecHash:
            target.content.lineage.promotedProjectSpecHash,
          content: target.content.content,
        })
      : sha256(target.content);

  const currentHead = (
    target: ReturnType<typeof requireSupportedTarget>,
  ): GovernedRevisionRef | null => {
    const source =
      target.targetKind === "harness"
        ? {
            table: "governed_harness_revisions",
            ownerColumn: "owner_id",
          }
        : target.targetKind === "project-spec"
          ? { table: "project_spec_revisions", ownerColumn: "project_spec_id" }
          : {
              table: "application_spec_revisions",
              ownerColumn: "application_spec_id",
            };
    const row = database
      .prepare(
        `SELECT id AS revisionId, content_hash AS revisionHash
           FROM ${source.table}
          WHERE ${source.ownerColumn} = ?
          ORDER BY revision DESC, id DESC LIMIT 1`,
      )
      .get(target.ownerId) as GovernedRevisionRef | undefined;
    return row ?? null;
  };

  const evidenceRef = (
    target: ReturnType<typeof requireSupportedTarget>,
    revisionId: string,
    suffix = "",
  ): string => `governed-${target.targetKind}-revision:${revisionId}${suffix}`;

  const inspectEffect: ImprovementApplicationEffectAdapter["inspectEffect"] =
    async (input) => {
      const target = requireSupportedTarget(input.target);
      const revisionId = deterministicGovernedRevisionId({
        operationId: input.operationId,
        targetKind: target.targetKind,
        phase: input.phase,
      });
      const source =
        target.targetKind === "harness"
          ? {
              table: "governed_harness_revisions",
              ownerColumn: "owner_id",
              operationColumns: true,
            }
          : target.targetKind === "project-spec"
            ? {
                table: "project_spec_revisions",
                ownerColumn: "project_spec_id",
                operationColumns: false,
              }
            : {
                table: "application_spec_revisions",
                ownerColumn: "application_spec_id",
                operationColumns: false,
              };
      const row = database
        .prepare(
          `SELECT id AS revisionId, ${source.ownerColumn} AS ownerId,
                  content_hash AS revisionHash${
                    source.operationColumns
                      ? ", operation_id AS operationId, phase"
                      : ""
                  }
             FROM ${source.table} WHERE id = ?`,
        )
        .get(revisionId) as
        | (GovernedRevisionRef & {
            readonly ownerId: string;
            readonly operationId?: string;
            readonly phase?: "apply" | "rollback";
          })
        | undefined;
      if (!row) {
        return {
          outcome: "proven-absent",
          evidenceRefs: [evidenceRef(target, revisionId, ":absent")],
        };
      }
      const expectedHash = revisionHash(target);
      if (
        row.ownerId === target.ownerId &&
        (!source.operationColumns ||
          (row.operationId === input.operationId &&
            row.phase === input.phase)) &&
        row.revisionHash === expectedHash
      ) {
        return {
          outcome: "exact-match",
          revision: {
            revisionId: row.revisionId,
            revisionHash: row.revisionHash,
          },
          evidenceRefs: [evidenceRef(target, row.revisionId)],
        };
      }
      return {
        outcome: "conflict",
        evidenceRefs: [evidenceRef(target, revisionId, ":conflict")],
      };
    };

  const appendRevision: ImprovementApplicationEffectAdapter["appendRevision"] =
    async (input) => {
      const target = requireSupportedTarget(input.target);
      const revisionId = deterministicGovernedRevisionId({
        operationId: input.operationId,
        targetKind: target.targetKind,
        phase: input.phase,
      });
      const existing = await inspectEffect(input);
      if (existing.outcome === "exact-match") {
        return {
          revision: existing.revision,
          disposition: "no-op",
          evidenceRefs: existing.evidenceRefs,
        };
      }
      if (existing.outcome !== "proven-absent") {
        throw new GovernedRevisionAdapterError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Governed ${target.targetKind} effect ${revisionId} conflicts with the requested operation.`,
        );
      }
      const head = currentHead(target);
      if (!sameHead(head, input.expectedGovernedHead)) {
        throw new GovernedRevisionAdapterError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Governed ${target.targetKind} ${target.ownerId} no longer has the expected head.`,
        );
      }
      const contentHash = revisionHash(target);
      const createdAt = clock().toISOString();
      if (target.targetKind === "harness") {
        const revision = (
          database
            .prepare(
              `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
                 FROM governed_harness_revisions WHERE owner_id = ?`,
            )
            .get(target.ownerId) as { readonly revision: number }
        ).revision;
        database
          .prepare(
            `INSERT INTO governed_harness_revisions(
               id, owner_id, revision, supersedes_revision_id, content_json,
               content_hash, operation_id, phase, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revisionId,
            target.ownerId,
            revision,
            head?.revisionId ?? null,
            canonicalJson(target.content),
            contentHash,
            input.operationId,
            input.phase,
            createdAt,
          );
      } else if (target.targetKind === "project-spec") {
        if (!head) {
          throw new GovernedRevisionAdapterError(
            "IMPROVEMENT_TARGET_CONFLICT",
            `Project Spec ${target.ownerId} has no exact source revision lineage.`,
          );
        }
        const lineage = database
          .prepare(
            `SELECT specs.project_id AS projectId, specs.run_id AS runId,
                    specs.product_baseline_id AS productBaselineId,
                    revisions.product_baseline_hash AS productBaselineHash,
                    revisions.producer_ai_member_id AS producerAiMemberId,
                    revisions.producer_position_id AS producerPositionId,
                    revisions.producer_session_id AS producerSessionId
               FROM project_specs AS specs
               JOIN project_spec_revisions AS revisions
                 ON revisions.id = ? AND revisions.project_spec_id = specs.id
              WHERE specs.id = ?`,
          )
          .get(head.revisionId, target.ownerId) as
          | {
              readonly projectId: string;
              readonly runId: string;
              readonly productBaselineId: string;
              readonly productBaselineHash: string;
              readonly producerAiMemberId: string;
              readonly producerPositionId: string;
              readonly producerSessionId: string;
            }
          | undefined;
        if (!lineage) {
          throw new GovernedRevisionAdapterError(
            "IMPROVEMENT_TARGET_CONFLICT",
            `Project Spec ${target.ownerId} lineage is unavailable.`,
          );
        }
        const revision = (
          database
            .prepare(
              `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
                 FROM project_spec_revisions WHERE project_spec_id = ?`,
            )
            .get(target.ownerId) as { readonly revision: number }
        ).revision;
        database
          .prepare(
            `INSERT INTO project_spec_revisions(
               id, project_spec_id, project_id, run_id, product_baseline_id,
               product_baseline_hash, revision, supersedes_revision_id,
               content_json, content_hash, producer_ai_member_id,
               producer_position_id, producer_session_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revisionId,
            target.ownerId,
            lineage.projectId,
            lineage.runId,
            lineage.productBaselineId,
            lineage.productBaselineHash,
            revision,
            head.revisionId,
            canonicalJson(target.content),
            contentHash,
            lineage.producerAiMemberId,
            lineage.producerPositionId,
            lineage.producerSessionId,
            createdAt,
          );
      } else {
        if (!head) {
          throw new GovernedRevisionAdapterError(
            "IMPROVEMENT_TARGET_CONFLICT",
            `Application Spec ${target.ownerId} has no exact source revision lineage.`,
          );
        }
        const lineage = database
          .prepare(
            `SELECT specs.application_id AS applicationId,
                    specs.project_id AS projectId, specs.run_id AS runId,
                    revisions.promoted_project_spec_revision_id AS promotedProjectSpecRevisionId,
                    revisions.promoted_project_spec_hash AS promotedProjectSpecHash,
                    revisions.producer_ai_member_id AS producerAiMemberId,
                    revisions.producer_position_id AS producerPositionId,
                    revisions.producer_session_id AS producerSessionId
               FROM application_specs AS specs
               JOIN application_spec_revisions AS revisions
                 ON revisions.id = ? AND revisions.application_spec_id = specs.id
              WHERE specs.id = ?`,
          )
          .get(head.revisionId, target.ownerId) as
          | {
              readonly applicationId: string;
              readonly projectId: string;
              readonly runId: string;
              readonly promotedProjectSpecRevisionId: string;
              readonly promotedProjectSpecHash: string;
              readonly producerAiMemberId: string;
              readonly producerPositionId: string;
              readonly producerSessionId: string;
            }
          | undefined;
        const requestedLineage = target.content.lineage;
        const promotedProjectSpec = database
          .prepare(
            `SELECT project_id AS projectId, content_hash AS revisionHash
               FROM project_spec_revisions WHERE id = ?`,
          )
          .get(requestedLineage.promotedProjectSpecRevisionId) as
          | { readonly projectId: string; readonly revisionHash: string }
          | undefined;
        if (
          !lineage ||
          lineage.applicationId !== requestedLineage.applicationId ||
          lineage.projectId !== requestedLineage.projectId ||
          lineage.promotedProjectSpecRevisionId !==
            requestedLineage.promotedProjectSpecRevisionId ||
          lineage.promotedProjectSpecHash !==
            requestedLineage.promotedProjectSpecHash ||
          !promotedProjectSpec ||
          promotedProjectSpec.projectId !== requestedLineage.projectId ||
          promotedProjectSpec.revisionHash !==
            requestedLineage.promotedProjectSpecHash
        ) {
          throw new GovernedRevisionAdapterError(
            "IMPROVEMENT_TARGET_CONFLICT",
            `Application Spec ${target.ownerId} does not preserve exact Project/Application lineage.`,
          );
        }
        const revision = (
          database
            .prepare(
              `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
                 FROM application_spec_revisions WHERE application_spec_id = ?`,
            )
            .get(target.ownerId) as { readonly revision: number }
        ).revision;
        database
          .prepare(
            `INSERT INTO application_spec_revisions(
               id, application_spec_id, application_id, project_id, run_id,
               promoted_project_spec_revision_id, promoted_project_spec_hash,
               revision, supersedes_revision_id, content_json, content_hash,
               producer_ai_member_id, producer_position_id,
               producer_session_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revisionId,
            target.ownerId,
            lineage.applicationId,
            lineage.projectId,
            lineage.runId,
            lineage.promotedProjectSpecRevisionId,
            lineage.promotedProjectSpecHash,
            revision,
            head.revisionId,
            canonicalJson(target.content.content),
            contentHash,
            lineage.producerAiMemberId,
            lineage.producerPositionId,
            lineage.producerSessionId,
            createdAt,
          );
      }
      return {
        revision: { revisionId, revisionHash: contentHash },
        disposition: "applied",
        evidenceRefs: [evidenceRef(target, revisionId)],
      };
    };

  return { inspectEffect, appendRevision };
};
