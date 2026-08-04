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

  const requireHarness = (target: ImprovementTarget) => {
    const parsed = ImprovementTargetSchema.parse(target);
    if (parsed.targetKind !== "harness") {
      throw new GovernedRevisionAdapterError(
        "IMPROVEMENT_TARGET_UNSUPPORTED",
        `Target kind ${parsed.targetKind} is not supported by the Harness Adapter.`,
      );
    }
    return parsed;
  };

  const currentHarnessHead = (ownerId: string): GovernedRevisionRef | null => {
    const row = database
      .prepare(
        `SELECT id AS revisionId, content_hash AS revisionHash
           FROM governed_harness_revisions
          WHERE owner_id = ? ORDER BY revision DESC, id DESC LIMIT 1`,
      )
      .get(ownerId) as GovernedRevisionRef | undefined;
    return row ?? null;
  };

  const inspectEffect: ImprovementApplicationEffectAdapter["inspectEffect"] =
    async (input) => {
      const target = requireHarness(input.target);
      const revisionId = deterministicGovernedRevisionId({
        operationId: input.operationId,
        targetKind: target.targetKind,
        phase: input.phase,
      });
      const row = database
        .prepare(
          `SELECT id AS revisionId, owner_id AS ownerId,
                  content_hash AS revisionHash, operation_id AS operationId,
                  phase
             FROM governed_harness_revisions WHERE id = ?`,
        )
        .get(revisionId) as
        | (GovernedRevisionRef & {
            readonly ownerId: string;
            readonly operationId: string;
            readonly phase: "apply" | "rollback";
          })
        | undefined;
      if (!row) {
        return {
          outcome: "proven-absent",
          evidenceRefs: [`governed-harness-revision:${revisionId}:absent`],
        };
      }
      const expectedHash = sha256(target.content);
      if (
        row.ownerId === target.ownerId &&
        row.operationId === input.operationId &&
        row.phase === input.phase &&
        row.revisionHash === expectedHash
      ) {
        return {
          outcome: "exact-match",
          revision: {
            revisionId: row.revisionId,
            revisionHash: row.revisionHash,
          },
          evidenceRefs: [`governed-harness-revision:${row.revisionId}`],
        };
      }
      return {
        outcome: "conflict",
        evidenceRefs: [`governed-harness-revision:${revisionId}:conflict`],
      };
    };

  const appendRevision: ImprovementApplicationEffectAdapter["appendRevision"] =
    async (input) => {
      const target = requireHarness(input.target);
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
          `Governed Harness effect ${revisionId} conflicts with the requested operation.`,
        );
      }
      const head = currentHarnessHead(target.ownerId);
      if (!sameHead(head, input.expectedGovernedHead)) {
        throw new GovernedRevisionAdapterError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Governed Harness ${target.ownerId} no longer has the expected head.`,
        );
      }
      const contentJson = canonicalJson(target.content);
      const contentHash = sha256(target.content);
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
          contentJson,
          contentHash,
          input.operationId,
          input.phase,
          clock().toISOString(),
        );
      return {
        revision: { revisionId, revisionHash: contentHash },
        disposition: "applied",
        evidenceRefs: [`governed-harness-revision:${revisionId}`],
      };
    };

  return { inspectEffect, appendRevision };
};
