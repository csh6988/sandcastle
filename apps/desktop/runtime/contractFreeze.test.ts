import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { companyCommandDefinitions } from "./commandRegistry.js";
import { CompanyCommandSchema, CompanyQuerySchema } from "./interface.js";
import { ReleaseOperationErrorCodeSchema } from "./release/releaseOperationContracts.js";
import { RUNTIME_EVENT_REGISTRY_VERSION } from "./events/registry.js";
import { CURRENT_SCHEMA_VERSION } from "./storage/migrations.js";
import { openCompanyDatabase } from "./storage/sqlite.js";

/**
 * T27 contract-freeze baseline (prefactor — ticket 01).
 *
 * This suite freezes the T26/T22 public surface at schema v52 / Runtime Event
 * Registry v20 so every later T27 phase can prove strict zero regression. It is
 * a characterization ("golden") test over surfaces that are otherwise enumerated
 * nowhere: the typed Command/Query name sets, the aggregate-routed command
 * catalog, the Release error-code enum, and the append-only storage guarantees.
 *
 * When a later phase deliberately extends one of these surfaces (e.g. Phase B
 * behavior on the already-registered `runtime.events.compact` Command), the
 * intended response is a DELIBERATE edit here plus a changeset — the diff on
 * this file is the forcing function that makes an accidental contract change
 * impossible to merge silently.
 *
 * Non-goals (documented, not asserted as a single frozen set): there is no
 * canonical `CompanyView` union to freeze (views are ~40 individually exported
 * schemas), and the AG-UI (`AG_UI_*`) and inline delivery `RELEASE_*` codes are
 * not a single enum. Those surfaces are frozen indirectly by their own suites.
 */

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-contract-freeze-"));

const commandUnionTypes = (): readonly string[] =>
  CompanyCommandSchema.options.map((option) => option.shape.type.value).sort();

const queryUnionTypes = (): readonly string[] =>
  CompanyQuerySchema.options.map((option) => option.shape.type.value).sort();

// Frozen typed Command envelope surface (CompanyCommandSchema discriminated union).
const FROZEN_COMMAND_UNION_TYPES: readonly string[] = [
  "ack-runtime-events",
  "agent.catalog.discover",
  "agent.test",
  "application-spec.revise",
  "application.register",
  "artifact.version.finalize",
  "artifact.version.register",
  "artifact.version.status",
  "artifact.version.supersede",
  "confirm-product-baseline",
  "department.archive",
  "department.copy",
  "department.create",
  "department.pipeline.draft.save",
  "department.pipeline.publish",
  "department.update",
  "execution-profile.archive",
  "execution-profile.save",
  "fork-department-run",
  "interaction.message.add",
  "interaction.participant.add",
  "interaction.prompt",
  "interaction.session.close",
  "interaction.session.create",
  "permission.decide",
  "permission.request",
  "position.archive",
  "position.configure",
  "position.create",
  "position.skills.set",
  "position.update",
  "product.proposal.mark-awaiting-confirmation",
  "product.proposal.revise",
  "project.archive",
  "project.create",
  "project.update",
  "run.approval.decide",
  "run.approval.retry",
  "run.cancel",
  "run.execute-ready",
  "run.fork",
  "run.node.retry",
  "run.pause",
  "run.recover",
  "run.resume",
  "run.start",
  "runtime.backup",
  "runtime.events.ack",
  "runtime.events.compact",
  "runtime.shutdown",
  "secret-reference.archive",
  "secret-reference.create",
  "skill-flow.archive",
  "skill-flow.save",
  "skill.catalog.archive",
  "skill.catalog.save",
  "skill.discovery.archive",
  "skill.discovery.enable",
  "skill.discovery.refresh",
  "technical-baseline-proposal.revise",
  "technical-gate.promote",
  "technical-review.start",
];

// Frozen aggregate-routed domain command catalog (companyCommandDefinitions keys).
// Deliberately distinct from the typed envelope union above: this catalog carries
// per-command routing metadata (primaryAggregate / expectedRevisionRequired).
const FROZEN_COMMAND_DEFINITION_KEYS: readonly string[] = [
  "application-spec.revise",
  "application.register",
  "artifact.version.finalize",
  "artifact.version.register",
  "artifact.version.supersede",
  "code-review.converge",
  "code-review.start",
  "confirm-product-baseline",
  "delivery.candidate-input.authorize",
  "delivery.candidate-input.freeze",
  "delivery.candidate.assemble",
  "delivery.release.decide",
  "delivery.release.recover",
  "fork-department-run",
  "improvement.application.apply",
  "improvement.application.rollback",
  "improvement.application.validate",
  "improvement.proposal.create",
  "improvement.proposal.decide",
  "improvement.proposal.propose",
  "improvement.proposal.request-decision",
  "improvement.proposal.revise",
  "integration.aggregate-review.record",
  "integration.generation.start",
  "integration.validation.record",
  "memory.candidate.decide",
  "memory.candidate.propose",
  "memory.entry.select-for-run",
  "memory.review.start",
  "product-gate.promote",
  "product-readiness.record",
  "product-review.start",
  "product.proposal.mark-awaiting-confirmation",
  "product.proposal.revise",
  "project-spec.revise",
  "project.update",
  "quality-gate.critical-escalation.decide",
  "quality-gate.execution.accept",
  "quality-gate.execution.reconcile",
  "quality-gate.input.prepare",
  "quality-gate.result.finalize",
  "review.discussion.close",
  "review.discussion.open",
  "review.finding.disposition",
  "review.finding.submit",
  "review.recheck.submit",
  "review.revision.submit",
  "review.topic.create",
  "source-import.execute",
  "statistics.evidence.freeze",
  "technical-baseline-proposal.revise",
  "technical-gate.promote",
  "technical-review.start",
  "work-package.assign",
  "work-package.generate",
  "work-package.rework",
  "work-package.self-check",
  "work-package.start",
  "work-package.version",
  "workspace-allocation.cleanup",
  "workspace-allocation.provision",
];

// Frozen typed Query envelope surface (CompanyQuerySchema discriminated union).
const FROZEN_QUERY_UNION_TYPES: readonly string[] = [
  "accepted-delivery-authority.inspect",
  "ag-ui.events",
  "agent.catalog.inspect",
  "applications.list",
  "artifact.inspect",
  "artifact.lineage.inspect",
  "artifacts.list",
  "code-reviews.inspect",
  "company.overview",
  "delivery-candidate-input.inspect",
  "delivery-candidates.inspect",
  "delivery-candidates.list",
  "department.inspect",
  "department.pipeline.inspect",
  "department.pipeline.validate",
  "department.skill-configuration.inspect",
  "departments.list",
  "execution.inspect",
  "improvement-application.inspect",
  "improvement-applications.list",
  "improvement-proposal.inspect",
  "improvement-proposals.list",
  "integration-generations.inspect",
  "interaction.inspect",
  "interactions.list",
  "memory.candidates.list",
  "memory.entries.list",
  "memory.legacy-records.list",
  "memory.records.list",
  "memory.selections.list",
  "product-review.inspect",
  "product.discovery.inspect",
  "project.inspect",
  "projects.list",
  "quality-gates.inspect",
  "release-operations.inspect",
  "release-operations.list",
  "review.topic.inspect",
  "review.topics.list",
  "run.inspect",
  "run.supervision.inspect",
  "runs.list",
  "runtime.audit",
  "runtime.diagnostics",
  "runtime.events",
  "runtime.events.consumer",
  "runtime.health",
  "skill.discovery.inspect",
  "statistics-evidence.inspect",
  "statistics.inspect",
  "technical-review.inspect",
  "test-pass-authority.inspect",
  "test-runs.inspect",
  "work-packages.inspect",
  "workspace-allocation.inspect",
];

// Frozen closed Release operation error-code enum.
const FROZEN_RELEASE_ERROR_CODES: readonly string[] = [
  "RELEASE_ARTIFACT_NOT_AUTHORIZED",
  "RELEASE_ARTIFACT_UNREADABLE",
  "RELEASE_AUTHORITY_CONFLICT",
  "RELEASE_DESTINATION_CONFLICT",
  "RELEASE_DESTINATION_INVALID",
  "RELEASE_FAST_FORWARD_REQUIRED",
  "RELEASE_OPERATION_BLOCKED",
  "RELEASE_OPERATION_ID_REUSE",
  "RELEASE_OPERATION_NOT_FOUND",
  "RELEASE_RECONCILIATION_INVALID",
  "RELEASE_TARGET_CHECKED_OUT",
  "RELEASE_TARGET_INVALID",
];

// Number of append-only immutability triggers in a fresh company database. Each
// guarded fact family contributes an `_immutable_update` and `_immutable_delete`
// trigger; freezing the count catches both silent removal of a guard and
// accidental introduction of a new mutable-history table. T27 Phase B (schema
// v53) adds the append-only runtime-event compaction-checkpoint table, whose two
// immutability triggers raise the T26 baseline of 150 to 152.
const FROZEN_IMMUTABLE_TRIGGER_COUNT = 152;

describe("T27 contract freeze baseline (Company Command/Query/error surface)", () => {
  it("pins the schema and Runtime Event Registry versions", () => {
    // Schema advances one forward-only step per T27 phase that needs it; Phase B
    // took it to v53. The Runtime Event Registry stays v20 (no event change).
    assert.equal(CURRENT_SCHEMA_VERSION, 53);
    assert.equal(RUNTIME_EVENT_REGISTRY_VERSION, 20);
  });

  it("freezes the typed Company Command envelope surface", () => {
    assert.deepEqual(commandUnionTypes(), FROZEN_COMMAND_UNION_TYPES);
  });

  it("freezes the aggregate-routed Company Command catalog", () => {
    assert.deepEqual(
      Object.keys(companyCommandDefinitions).sort(),
      FROZEN_COMMAND_DEFINITION_KEYS,
    );
  });

  it("freezes the typed Company Query envelope surface", () => {
    assert.deepEqual(queryUnionTypes(), FROZEN_QUERY_UNION_TYPES);
  });

  it("freezes the closed Release operation error-code enum", () => {
    assert.deepEqual(
      [...ReleaseOperationErrorCodeSchema.options].sort(),
      FROZEN_RELEASE_ERROR_CODES,
    );
  });

  it("freezes the append-only immutability trigger count and audit-by-construction guarantee", () => {
    const companyDir = tempCompanyDir();
    const opened = openCompanyDatabase(companyDir);
    assert.equal(opened.schemaVersion(), CURRENT_SCHEMA_VERSION);
    opened.close();

    const database = new DatabaseSync(
      join(companyDir, ".sandcastle", "company.sqlite"),
    );
    try {
      const immutableTriggerCount = (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%immutable%'",
          )
          .get() as { readonly count: number }
      ).count;
      assert.equal(immutableTriggerCount, FROZEN_IMMUTABLE_TRIGGER_COUNT);

      // Runtime audit records are append-only by construction (INSERT-only), not
      // by trigger. Freeze that fact so retention work never assumes a guard that
      // does not exist and never adds an update/delete path.
      const auditTriggerCount = (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'runtime_audit_records%'",
          )
          .get() as { readonly count: number }
      ).count;
      assert.equal(auditTriggerCount, 0);
    } finally {
      database.close();
    }
  });
});
