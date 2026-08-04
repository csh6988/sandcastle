import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import type { StatisticsInspectInput } from "./statisticsContracts.js";

const hash = "a".repeat(64);
const timestamp = "2026-08-04T00:00:00.000Z";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-statistics-runtime-"));

const baselineQuery = {
  projectId: "project:statistics",
  filters: {
    departmentIds: ["software-rnd", "software-rnd"],
    repositoryIds: [],
  },
  window: {
    kind: "explicit-utc-half-open" as const,
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-02T00:00:00.000Z",
  },
  cohort: {
    id: "cohort:baseline",
    filters: { departmentIds: ["software-rnd", "software-rnd"] },
  },
  comparisonSet: {
    id: "comparison:baseline-quality",
    metricIds: [
      "review-recheck-pass-rate" as const,
      "readiness-blocker-count" as const,
      "product-baseline-confirmation-latency" as const,
      "review-finding-count" as const,
      "review-discussion-round-count" as const,
      "product-baseline-confirmation-count" as const,
    ],
  },
};

const seedBaselineFacts = (path: string): void => {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO projects(id, company_id, name, goal, status, created_at)
    VALUES (
      'project:statistics', 'company', 'Statistics', 'Measure governed facts',
      'active', '${timestamp}'
    );
    INSERT INTO department_runs(
      id, project_id, department_id, status, created_at, revision,
      snapshot_revision_id, pipeline_version_id
    ) VALUES (
      'run:statistics', 'project:statistics', 'software-rnd', 'completed',
      '2026-08-01T00:00:00.000Z', 1, 'snapshot:statistics',
      'software-rnd-pipeline-v1'
    );
    INSERT INTO product_proposals(
      id, project_id, status, revision, current_revision_id, created_at, updated_at
    ) VALUES (
      'product-proposal:statistics', 'project:statistics', 'confirmed', 1,
      'product-proposal-revision:statistics',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:10:00.000Z'
    );
    INSERT INTO product_proposal_revisions(
      id, proposal_id, revision, content_json, content_hash,
      producer_ai_member_id, producer_position_id, producer_session_id,
      edited_by_type, edited_by_id, edited_by_authenticated_by, created_at
    ) VALUES (
      'product-proposal-revision:statistics', 'product-proposal:statistics', 1,
      '{}', '${hash}', 'product-planner-member', 'product-planner',
      'session:statistics', 'runtime-worker', 'runtime-worker:statistics',
      'runtime', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO product_baselines(
      id, project_id, source_proposal_revision_id, source_proposal_hash,
      content_json, canonical_hash, confirmed_by_type, confirmed_by_id,
      confirmed_by_authenticated_by, confirmation_command_id, run_id,
      snapshot_revision_id, confirmed_at
    ) VALUES (
      'product-baseline:statistics', 'project:statistics',
      'product-proposal-revision:statistics', '${hash}', '{}', '${hash}',
      'human', 'human:statistics', 'local-session', 'command:baseline',
      'run:statistics', 'snapshot:statistics', '2026-08-01T00:10:00.000Z'
    );
    INSERT INTO review_topics(
      id, project_id, run_id, title, kind, status, revision, manifest_json,
      manifest_hash, producer_ai_member_id, producer_position_id,
      producer_session_id, quorum, budget_json, rounds_used,
      duration_seconds_used, tokens_used, cost_cents_used, stop_condition,
      escalation_policy, created_at, updated_at
    ) VALUES (
      'review-topic:statistics', 'project:statistics', 'run:statistics',
      'Statistics review', 'product', 'PASS', 1, '{}', '${hash}',
      'product-planner-member', 'product-planner', 'session:statistics', 1,
      '{}', 2, 0, 0, 0, 'blocking-findings-dispositioned',
      'fail-with-evidence', '2026-08-01T00:20:00.000Z',
      '2026-08-01T00:50:00.000Z'
    );
    INSERT INTO review_participants(
      id, topic_id, role, ai_member_id, position_id, session_id, eligible,
      eligibility_reasons_json, eligibility_snapshot_json,
      eligibility_snapshot_hash, created_at
    ) VALUES (
      'review-participant:statistics', 'review-topic:statistics',
      'reviewer-participant', 'reviewer-member', 'reviewer',
      'session:reviewer-statistics', 1, '[]', '{}', '${hash}',
      '2026-08-01T00:20:00.000Z'
    );
    INSERT INTO review_findings(
      id, topic_id, reviewer_participant_id, reviewer_session_id, severity,
      summary, rationale, impact, evidence_refs_json, suggested_owner,
      blocking, created_at, scope_impact
    ) VALUES
      ('finding:1', 'review-topic:statistics', 'review-participant:statistics',
       'session:reviewer-statistics', 'medium', 'First', 'Rationale', 'Impact',
       '[]', 'software-rnd', 0, '2026-08-01T00:25:00.000Z', 'scope-preserving'),
      ('finding:2', 'review-topic:statistics', 'review-participant:statistics',
       'session:reviewer-statistics', 'high', 'Second', 'Rationale', 'Impact',
       '[]', 'software-rnd', 1, '2026-08-01T00:26:00.000Z', 'scope-preserving');
    INSERT INTO review_discussions(
      id, topic_id, round, status, conflict_finding_ids_json, bounded_prompt,
      tokens_used, cost_cents_used, duration_seconds, stop_reason, opened_at,
      closed_at
    ) VALUES
      ('discussion:1', 'review-topic:statistics', 1, 'closed', '[]', 'Discuss',
       0, 0, 0, 'resolved', '2026-08-01T00:30:00.000Z',
       '2026-08-01T00:31:00.000Z'),
      ('discussion:2', 'review-topic:statistics', 2, 'closed', '[]', 'Discuss',
       0, 0, 0, 'resolved', '2026-08-01T00:32:00.000Z',
       '2026-08-01T00:33:00.000Z');
    INSERT INTO review_revisions(
      id, topic_id, subject_kind, subject_id, subject_hash,
      producer_ai_member_id, producer_position_id, producer_session_id,
      evidence_refs_json, created_at
    ) VALUES (
      'review-revision:statistics', 'review-topic:statistics', 'product-spec',
      'subject:statistics', '${hash}', 'product-planner-member',
      'product-planner', 'session:statistics', '[]',
      '2026-08-01T00:40:00.000Z'
    );
    INSERT INTO review_rechecks(
      id, topic_id, revision_id, reviewer_participant_id, reviewer_session_id,
      result, conditions_json, evidence_refs_json, eligibility_snapshot_json,
      eligibility_snapshot_hash, created_at
    ) VALUES
      ('recheck:pass', 'review-topic:statistics', 'review-revision:statistics',
       'review-participant:statistics', 'session:recheck-pass', 'PASS', '[]',
       '[]', '{}', '${hash}', '2026-08-01T00:45:00.000Z'),
      ('recheck:fail', 'review-topic:statistics', 'review-revision:statistics',
       'review-participant:statistics-2', 'session:recheck-fail', 'FAIL', '[]',
       '[]', '{}', '${hash}', '2026-08-01T00:46:00.000Z');
    INSERT INTO product_readiness_evidence(
      id, project_id, run_id, product_baseline_id, product_baseline_hash,
      project_spec_revision_id, project_spec_hash, check_key, status, summary,
      evidence_refs_json, producer_ai_member_id, producer_position_id,
      producer_session_id, created_at
    ) VALUES
      ('readiness:blocked', 'project:statistics', 'run:statistics',
       'product-baseline:statistics', '${hash}', 'project-spec:statistics',
       '${hash}', 'dependencies', 'blocked', 'Dependency is blocked', '[]',
       'product-planner-member', 'product-planner', 'session:statistics',
       '2026-08-01T00:55:00.000Z'),
      ('readiness:ready', 'project:statistics', 'run:statistics',
       'product-baseline:statistics', '${hash}', 'project-spec:statistics',
       '${hash}', 'contracts', 'ready', 'Contracts are ready', '[]',
       'product-planner-member', 'product-planner', 'session:statistics',
       '2026-08-01T00:56:00.000Z');
  `);
  database.close();
};

const seedExecutionReliabilityFacts = (path: string): void => {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO department_runs(
      id, project_id, department_id, status, created_at, revision,
      snapshot_revision_id, pipeline_version_id, updated_at
    ) VALUES
      ('run:reliability:completed', 'project:statistics', 'software-rnd',
       'completed', '2026-08-01T00:00:00.000Z', 1,
       'snapshot:reliability:completed', 'software-rnd-pipeline-v1',
       '2026-08-01T05:00:00.000Z'),
      ('run:reliability:failed', 'project:statistics', 'software-rnd',
       'failed', '2026-08-01T00:00:00.000Z', 1,
       'snapshot:reliability:failed', 'software-rnd-pipeline-v1',
       '2026-08-01T06:00:00.000Z');
    INSERT INTO node_runs(
      id, run_id, pipeline_node_id, node_type, status, attempt_count,
      required_dependency_ids_json, created_at, updated_at
    ) VALUES
      ('node-run:reliability:completed', 'run:reliability:completed',
       'implement', 'ai-task', 'succeeded', 2, '[]',
       '2026-08-01T00:30:00.000Z', '2026-08-01T01:45:00.000Z'),
      ('node-run:reliability:failed', 'run:reliability:failed',
       'recover', 'ai-task', 'failed', 1, '[]',
       '2026-08-01T01:50:00.000Z', '2026-08-01T02:20:00.000Z'),
      ('node-run:approval', 'run:reliability:completed', 'approve',
       'human-approval', 'succeeded', 0, '[]',
       '2026-08-01T04:00:00.000Z', '2026-08-01T04:10:00.000Z');
    INSERT INTO node_attempts(
      id, node_run_id, attempt_number, snapshot_revision_id, reason, status,
      created_at, started_at, completed_at, recoverable,
      execution_operation_key
    ) VALUES
      ('attempt:initial', 'node-run:reliability:completed', 1,
       'snapshot:reliability:completed', 'initial', 'succeeded',
       '2026-08-01T01:00:00.000Z', '2026-08-01T01:00:00.000Z',
       '2026-08-01T01:30:00.000Z', 0, 'operation:initial'),
      ('attempt:retry', 'node-run:reliability:completed', 2,
       'snapshot:reliability:completed', 'retry', 'failed',
       '2026-08-01T01:15:00.000Z', '2026-08-01T01:15:00.000Z',
       '2026-08-01T01:45:00.000Z', 0, 'operation:retry'),
      ('attempt:recovery', 'node-run:reliability:failed', 1,
       'snapshot:reliability:failed', 'recovery', 'interrupted',
       '2026-08-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z',
       '2026-08-01T02:20:00.000Z', 1, 'operation:recovery'),
      ('attempt:boundary', 'node-run:reliability:failed', 2,
       'snapshot:reliability:failed', 'retry', 'failed',
       '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
       '2026-08-02T00:01:00.000Z', 0, 'operation:boundary');
    INSERT INTO execution_leases(
      id, target_kind, target_id, lease_kind, operation_key,
      execution_epoch, fence_token, worker_id, issued_at, expires_at,
      released_at, cancel_requested
    ) VALUES
      ('lease:initial', 'node-attempt', 'attempt:initial', 'execution',
       'operation:initial', 1, 'fence:initial', 'worker:1',
       '2026-08-01T01:00:00.000Z', '2026-08-01T01:40:00.000Z',
       '2026-08-01T01:30:00.000Z', 0),
      ('lease:retry', 'node-attempt', 'attempt:retry', 'execution',
       'operation:retry', 1, 'fence:retry', 'worker:2',
       '2026-08-01T01:15:00.000Z', '2026-08-01T01:55:00.000Z',
       '2026-08-01T01:45:00.000Z', 0),
      ('lease:recovery', 'node-attempt', 'attempt:recovery', 'execution',
       'operation:recovery', 1, 'fence:recovery', 'worker:3',
       '2026-08-01T02:00:00.000Z', '2026-08-01T02:20:00.000Z', NULL, 0);
    INSERT INTO approvals(
      id, run_id, node_run_id, cycle, snapshot_revision_id, status, decision,
      requested_action, input_manifest_hash, eligible_human_policy_json,
      created_at, decided_at, decision_actor_type, decision_actor_id,
      decision_actor_authenticated_by, decision_command_id, decision_hash
    ) VALUES (
      'approval:reliability', 'run:reliability:completed', 'node-run:approval',
      1, 'snapshot:reliability:completed', 'decided', 'approve',
      'Approve reliability evidence', '${hash}', '{}',
      '2026-08-01T04:00:00.000Z', '2026-08-01T04:10:00.000Z',
      'human', 'human:statistics', 'local-session', 'command:approval', '${hash}'
    );
    INSERT INTO governed_interventions(
      id, run_id, node_run_id, attempt_id, snapshot_revision_id, actor_id,
      reason, feedback, outcome, created_at
    ) VALUES
      ('intervention:retry', 'run:reliability:completed',
       'node-run:reliability:completed', 'attempt:retry',
       'snapshot:reliability:completed', 'human:statistics', 'Needs guidance',
       'Use the exact recovery seam.', 'feedback',
       '2026-08-01T01:20:00.000Z'),
      ('intervention:boundary', 'run:reliability:failed',
       'node-run:reliability:failed', 'attempt:boundary',
       'snapshot:reliability:failed', 'human:statistics', 'Boundary',
       'Must not enter the prior window.', 'feedback',
       '2026-08-02T00:00:00.000Z');
  `);
  database.close();
};

const seedQualityDeliveryMemoryFacts = (path: string): void => {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO code_review_manifests(
      id, topic_id, project_id, run_id, snapshot_revision_id, work_package_id,
      work_package_version_id, assignment_id, node_attempt_id,
      workspace_import_id, diff_artifact_version_id, manifest_json,
      manifest_hash, created_at
    ) VALUES
      ('code-review:clean', 'topic:code-review:clean', 'project:statistics',
       'run:statistics', 'snapshot:statistics', 'work-package:clean',
       'work-package-version:clean', 'assignment:clean', 'attempt:clean',
       'workspace-import:clean', 'artifact:diff:clean', '{}', '${hash}',
       '2026-08-01T07:00:00.000Z'),
      ('code-review:defect', 'topic:code-review:defect', 'project:statistics',
       'run:statistics', 'snapshot:statistics', 'work-package:defect',
       'work-package-version:defect', 'assignment:defect', 'attempt:defect',
       'workspace-import:defect', 'artifact:diff:defect', '{}', '${hash}',
       '2026-08-01T07:10:00.000Z');
    INSERT INTO code_review_defects(
      id, code_review_manifest_id, quality_gate_result_id, work_package_id,
      result, finding_ids_json, obligation_json, status, created_at
    ) VALUES (
      'code-review-defect:1', 'code-review:defect', 'quality-gate:code-review',
      'work-package:defect', 'FAIL', '[]', '{}', 'open',
      '2026-08-01T07:15:00.000Z'
    );
    INSERT INTO integration_generations(
      id, project_id, run_id, snapshot_revision_id, node_run_id, generation,
      coverage_id, coverage_node_run_id, coverage_node_attempt_id,
      coverage_hash, manifest_json, manifest_hash, state,
      pass_authority_hash, created_at, updated_at
    ) VALUES (
      'integration-generation:statistics', 'project:statistics',
      'run:statistics', 'snapshot:statistics', 'node-run:integration', 1,
      'coverage:statistics', 'node-run:coverage', 'attempt:coverage', '${hash}',
      '{}', '${hash}', 'passed', '${hash}',
      '2026-08-01T08:00:00.000Z', '2026-08-01T08:30:00.000Z'
    );
    INSERT INTO integration_operations(
      id, generation_id, repository_result_id, work_package_id,
      work_package_version_id, authority_id, quality_gate_result_id, ordinal,
      source_branch, source_commit, diff_hash, expected_tip, request_json,
      request_hash, idempotency_key, state, receipt_json, receipt_hash,
      resulting_commit, created_at, updated_at
    ) VALUES
      ('integration-operation:clean', 'integration-generation:statistics',
       'repository-result:statistics', 'work-package:clean',
       'work-package-version:clean', 'code-review-authority:clean',
       'quality-gate:clean', 0, 'branch:clean', '${"a".repeat(40)}', '${hash}',
       '${"b".repeat(40)}', '{}', '${hash}', 'integration:clean', 'succeeded',
       '{}', '${hash}', '${"c".repeat(40)}',
       '2026-08-01T08:05:00.000Z', '2026-08-01T08:15:00.000Z'),
      ('integration-operation:conflict', 'integration-generation:statistics',
       'repository-result:statistics', 'work-package:defect',
       'work-package-version:defect', 'code-review-authority:defect',
       'quality-gate:defect', 1, 'branch:defect', '${"d".repeat(40)}', '${hash}',
       '${"e".repeat(40)}', '{}', '${hash}', 'integration:conflict', 'failed',
       NULL, NULL, NULL,
       '2026-08-01T08:10:00.000Z', '2026-08-01T08:20:00.000Z');
    INSERT INTO integration_defects(
      id, generation_id, integration_operation_id, kind, responsibility_json,
      evidence_json, status, created_at
    ) VALUES (
      'integration-defect:conflict', 'integration-generation:statistics',
      'integration-operation:conflict', 'git-conflict', '{}', '{}', 'open',
      '2026-08-01T08:12:00.000Z'
    );
    INSERT INTO test_runs(
      id, request_id, project_id, run_id, snapshot_revision_id, node_run_id,
      node_attempt_id, session_id, integration_generation_id,
      integration_manifest_hash, integration_pass_authority_hash,
      manifest_json, manifest_hash, request_hash, state, pass_authority_hash,
      created_at, updated_at
    ) VALUES
      ('test-run:passed', 'test-request:passed', 'project:statistics',
       'run:statistics', 'snapshot:statistics', 'node-run:test:passed',
       'attempt:test:passed', 'session:test:passed',
       'integration-generation:statistics', '${hash}', '${hash}', '{}',
       '${hash}', '${hash}', 'running', NULL,
       '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z'),
      ('test-run:failed', 'test-request:failed', 'project:statistics',
       'run:statistics', 'snapshot:statistics', 'node-run:test:failed',
       'attempt:test:failed', 'session:test:failed',
       'integration-generation:statistics', '${hash}', '${hash}', '{}',
       '${hash}', '${hash}', 'running', NULL,
       '2026-08-01T09:10:00.000Z', '2026-08-01T09:10:00.000Z');
    INSERT INTO test_assertion_results(
      id, test_run_id, operation_id, test_case_revision_id, assertion_id,
      required, ui_status, runtime_status, correlation_json, result_hash,
      created_at, ui_observation_json, runtime_observation_json
    ) VALUES
      ('assertion:matched', 'test-run:passed', 'test-operation:passed',
       'test-case-revision:matched', 'matched', 1, 'passed', 'passed', '{}',
       '${hash}', '2026-08-01T09:15:00.000Z', '{}', '{}'),
      ('assertion:mismatch', 'test-run:failed', 'test-operation:failed',
       'test-case-revision:mismatch', 'mismatch', 1, 'failed', 'passed', '{}',
       '${hash}', '2026-08-01T09:25:00.000Z', '{}', '{}');
    UPDATE test_runs
       SET state = 'passed', pass_authority_hash = '${hash}',
           updated_at = '2026-08-01T09:20:00.000Z'
     WHERE id = 'test-run:passed';
    UPDATE test_runs
       SET state = 'failed', updated_at = '2026-08-01T09:30:00.000Z'
     WHERE id = 'test-run:failed';
    INSERT INTO delivery_candidates(
      id, request_id, project_id, run_id, snapshot_revision_id,
      candidate_input_id, candidate_input_hash, gate_authority_id,
      gate_authority_hash, source_node_run_id, source_node_attempt_id,
      lineage_hash, manifest_json, manifest_hash, request_hash, created_at
    ) VALUES
      ('delivery-candidate:accepted', 'delivery-request:accepted',
       'project:statistics', 'run:statistics', 'snapshot:statistics',
       'candidate-input:accepted', '${hash}', 'gate-authority:accepted',
       '${hash}', 'node-run:delivery:accepted', 'attempt:delivery:accepted',
       '${hash}', '{}', '${hash}', '${hash}',
       '2026-08-01T10:00:00.000Z'),
      ('delivery-candidate:rejected', 'delivery-request:rejected',
       'project:statistics', 'run:statistics', 'snapshot:statistics',
       'candidate-input:rejected', '${hash}', 'gate-authority:rejected',
       '${hash}', 'node-run:delivery:rejected', 'attempt:delivery:rejected',
       '${hash}', '{}', '${hash}', '${hash}',
       '2026-08-01T10:05:00.000Z');
    INSERT INTO human_release_decisions(
      id, candidate_id, candidate_hash, run_id, snapshot_revision_id,
      decision, actor_type, actor_id, authenticated_by, reason,
      evidence_refs_json, decision_hash, created_at
    ) VALUES
      ('release-decision:accepted', 'delivery-candidate:accepted', '${hash}',
       'run:statistics', 'snapshot:statistics', 'accepted', 'human',
       'human:statistics', 'local-session', 'Accepted exact candidate', '[]',
       '${hash}', '2026-08-01T10:10:00.000Z'),
      ('release-decision:rejected', 'delivery-candidate:rejected', '${hash}',
       'run:statistics', 'snapshot:statistics', 'rejected', 'human',
       'human:statistics', 'local-session', 'Rejected exact candidate', '[]',
       '${hash}', '2026-08-01T10:15:00.000Z');
    INSERT INTO release_operations(
      id, idempotency_key, candidate_id, accepted_authority_id, kind,
      authorization_json, authorization_hash, request_json,
      canonical_request_hash, aggregate_state, created_at, updated_at
    ) VALUES (
      'release-operation:statistics', 'release-operation-key:statistics',
      'delivery-candidate:accepted', 'accepted-authority:statistics', 'export',
      '{}', '${hash}', '{}', '${hash}', 'partially-succeeded',
      '2026-08-01T11:00:00.000Z', '2026-08-01T11:30:00.000Z'
    );
    INSERT INTO release_operation_items(
      id, operation_id, item_key, ordinal, kind, request_json, request_hash,
      state, receipt_json, receipt_hash, evidence_json, created_at, updated_at
    ) VALUES
      ('release-item:succeeded:1', 'release-operation:statistics', 'item:1', 0,
       'export', '{}', '${hash}', 'succeeded', '{}', '${hash}', '{}',
       '2026-08-01T11:05:00.000Z', '2026-08-01T11:10:00.000Z'),
      ('release-item:succeeded:2', 'release-operation:statistics', 'item:2', 1,
       'export', '{}', '${hash}', 'succeeded', '{}', '${hash}', '{}',
       '2026-08-01T11:06:00.000Z', '2026-08-01T11:11:00.000Z'),
      ('release-item:failed', 'release-operation:statistics', 'item:3', 2,
       'export', '{}', '${hash}', 'failed', NULL, NULL, '{}',
       '2026-08-01T11:07:00.000Z', '2026-08-01T11:12:00.000Z');
    INSERT INTO reviewed_memory_candidate_revisions(
      id, candidate_id, project_id, scope, revision, content, content_hash,
      redaction_policy_version, redaction_policy_hash,
      source_artifact_versions_json, source_event_ranges_json,
      producer_ai_member_id, producer_position_id, producer_session_id,
      created_at
    ) VALUES
      ('memory-revision:accepted:1', 'memory-candidate:accepted:1',
       'project:statistics', 'project', 1, 'First memory', '${hash}', '1',
       '${hash}', '[]', '[]', 'producer:memory', 'position:memory',
       'session:memory:1', '2026-08-01T12:00:00.000Z'),
      ('memory-revision:accepted:2', 'memory-candidate:accepted:2',
       'project:statistics', 'project', 1, 'Second memory', '${hash}', '1',
       '${hash}', '[]', '[]', 'producer:memory', 'position:memory',
       'session:memory:2', '2026-08-01T12:01:00.000Z'),
      ('memory-revision:rejected', 'memory-candidate:rejected',
       'project:statistics', 'project', 1, 'Rejected memory', '${hash}', '1',
       '${hash}', '[]', '[]', 'producer:memory', 'position:memory',
       'session:memory:3', '2026-08-01T12:02:00.000Z');
    INSERT INTO reviewed_memory_decisions(
      id, candidate_revision_id, candidate_revision_hash, topic_id,
      quality_gate_result_id, decision, actor_type, actor_id,
      authenticated_by, command_id, created_at
    ) VALUES
      ('memory-decision:accepted:1', 'memory-revision:accepted:1', '${hash}',
       'topic:memory:1', 'quality-gate:memory:1', 'accepted', 'human',
       'human:statistics', 'local-session', 'command:memory:1',
       '2026-08-01T12:10:00.000Z'),
      ('memory-decision:accepted:2', 'memory-revision:accepted:2', '${hash}',
       'topic:memory:2', 'quality-gate:memory:2', 'accepted', 'human',
       'human:statistics', 'local-session', 'command:memory:2',
       '2026-08-01T12:11:00.000Z'),
      ('memory-decision:rejected', 'memory-revision:rejected', '${hash}',
       'topic:memory:3', 'quality-gate:memory:3', 'rejected', 'human',
       'human:statistics', 'local-session', 'command:memory:3',
       '2026-08-01T12:12:00.000Z');
    INSERT INTO reviewed_memory_entries(
      id, decision_id, candidate_revision_id, project_id, scope, owner_id,
      version, content, content_hash, redaction_policy_version,
      redaction_policy_hash, quality_gate_result_id, created_at
    ) VALUES
      ('memory-entry:1', 'memory-decision:accepted:1',
       'memory-revision:accepted:1', 'project:statistics', 'project',
       'project:statistics', 1, 'First memory', '${hash}', '1', '${hash}',
       'quality-gate:memory:1', '2026-08-01T12:10:00.000Z'),
      ('memory-entry:2', 'memory-decision:accepted:2',
       'memory-revision:accepted:2', 'project:statistics', 'project',
       'project:statistics', 2, 'Second memory', '${hash}', '1', '${hash}',
       'quality-gate:memory:2', '2026-08-01T12:11:00.000Z');
    INSERT INTO run_memory_selections(
      id, project_id, run_id, source_snapshot_revision_id,
      snapshot_revision_id, entry_id, entry_version, entry_hash,
      selection_reason, policy_hash, created_at
    ) VALUES (
      'memory-selection:1', 'project:statistics', 'run:statistics',
      'snapshot:source', 'snapshot:selected', 'memory-entry:1', 1, '${hash}',
      'Selected exact reviewed memory', '${hash}',
      '2026-08-01T12:20:00.000Z'
    );
  `);
  database.close();
};

describe("Statistics Runtime", () => {
  it("inspects deterministic baseline quality facts without writing", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    const beforeSequence = database.eventSequence();

    const view = database.statistics.inspect(baselineQuery);

    assert.equal(database.eventSequence(), beforeSequence);
    assert.equal(view.asOfSequence, beforeSequence);
    assert.deepEqual(view.query.filters.departmentIds, ["software-rnd"]);
    assert.deepEqual(view.query.cohort.filters.departmentIds, ["software-rnd"]);
    assert.deepEqual(view.query.comparisonSet.metricIds, [
      "product-baseline-confirmation-count",
      "product-baseline-confirmation-latency",
      "readiness-blocker-count",
      "review-discussion-round-count",
      "review-finding-count",
      "review-recheck-pass-rate",
    ]);
    assert.deepEqual(
      view.observations.map((observation) => ({
        metricId: observation.metricId,
        status: observation.status,
        measurement:
          observation.status === "available" ? observation.measurement : null,
      })),
      [
        {
          metricId: "product-baseline-confirmation-count",
          status: "available",
          measurement: { kind: "count", value: 1 },
        },
        {
          metricId: "product-baseline-confirmation-latency",
          status: "available",
          measurement: { kind: "duration", milliseconds: 600_000 },
        },
        {
          metricId: "readiness-blocker-count",
          status: "available",
          measurement: { kind: "count", value: 1 },
        },
        {
          metricId: "review-discussion-round-count",
          status: "available",
          measurement: { kind: "count", value: 2 },
        },
        {
          metricId: "review-finding-count",
          status: "available",
          measurement: { kind: "count", value: 2 },
        },
        {
          metricId: "review-recheck-pass-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
      ],
    );
    assert.deepEqual(view.completeness, {
      status: "complete",
      incompleteMetricIds: [],
      unavailableMetricIds: [],
    });

    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM statistics_evidence_snapshots",
          )
          .get() as { readonly count: number }
      ).count,
      0,
    );
    sqlite.close();
    database.close();
  });

  it("applies canonical cohort filters to Statistics aggregation", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    const sqlite = new DatabaseSync(database.path);
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO department_runs(
        id, project_id, department_id, status, created_at, revision,
        snapshot_revision_id, pipeline_version_id
      ) VALUES (
        'run:statistics:other', 'project:statistics', 'other-department',
        'completed', '2026-08-01T00:00:00.000Z', 1,
        'snapshot:statistics:other', 'other-pipeline-v1'
      );
      INSERT INTO review_topics(
        id, project_id, run_id, title, kind, status, revision, manifest_json,
        manifest_hash, producer_ai_member_id, producer_position_id,
        producer_session_id, quorum, budget_json, rounds_used,
        duration_seconds_used, tokens_used, cost_cents_used, stop_condition,
        escalation_policy, created_at, updated_at
      ) VALUES (
        'review-topic:statistics:other', 'project:statistics',
        'run:statistics:other', 'Other review', 'product', 'PASS', 1, '{}',
        '${hash}', 'product-planner-member', 'product-planner',
        'session:statistics:other', 1, '{}', 0, 0, 0, 0,
        'blocking-findings-dispositioned', 'fail-with-evidence',
        '2026-08-01T00:20:00.000Z', '2026-08-01T00:50:00.000Z'
      );
      INSERT INTO review_participants(
        id, topic_id, role, ai_member_id, position_id, session_id, eligible,
        eligibility_reasons_json, eligibility_snapshot_json,
        eligibility_snapshot_hash, created_at
      ) VALUES (
        'review-participant:statistics:other', 'review-topic:statistics:other',
        'reviewer-participant', 'reviewer-member', 'reviewer',
        'session:reviewer-statistics:other', 1, '[]', '{}', '${hash}',
        '2026-08-01T00:20:00.000Z'
      );
      INSERT INTO review_findings(
        id, topic_id, reviewer_participant_id, reviewer_session_id, severity,
        summary, rationale, impact, evidence_refs_json, suggested_owner,
        blocking, created_at, scope_impact
      ) VALUES (
        'finding:other', 'review-topic:statistics:other',
        'review-participant:statistics:other',
        'session:reviewer-statistics:other', 'medium', 'Other', 'Rationale',
        'Impact', '[]', 'other-department', 0,
        '2026-08-01T00:25:00.000Z', 'scope-preserving'
      );
    `);
    sqlite.close();

    const allDepartments = database.statistics.inspect({
      ...baselineQuery,
      filters: {},
      cohort: { id: "cohort:all" },
      comparisonSet: {
        id: "comparison:review-findings",
        metricIds: ["review-finding-count"],
      },
    });
    const softwareRndCohort = database.statistics.inspect({
      ...baselineQuery,
      filters: {},
      cohort: {
        id: "cohort:software-rnd",
        filters: { departmentIds: ["software-rnd"] },
      },
      comparisonSet: {
        id: "comparison:review-findings",
        metricIds: ["review-finding-count"],
      },
    });
    const disjointCohort = database.statistics.inspect({
      ...baselineQuery,
      filters: { departmentIds: ["other-department"] },
      cohort: {
        id: "cohort:software-rnd",
        filters: { departmentIds: ["software-rnd"] },
      },
      comparisonSet: {
        id: "comparison:review-findings",
        metricIds: ["review-finding-count"],
      },
    });

    assert.deepEqual(allDepartments.observations[0], {
      metricId: "review-finding-count",
      status: "available",
      measurement: { kind: "count", value: 3 },
      sourceFactFamily: "review-finding",
      sourceFactRefs: ["finding:1", "finding:other", "finding:2"],
    });
    assert.deepEqual(softwareRndCohort.observations[0], {
      metricId: "review-finding-count",
      status: "available",
      measurement: { kind: "count", value: 2 },
      sourceFactFamily: "review-finding",
      sourceFactRefs: ["finding:1", "finding:2"],
    });
    assert.deepEqual(disjointCohort.observations[0], {
      metricId: "review-finding-count",
      status: "available",
      measurement: { kind: "count", value: 0 },
      sourceFactFamily: "review-finding",
      sourceFactRefs: [],
    });
    database.close();
  });

  it("keeps exact zero distinct from missing dimensional and denominator facts", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);

    const empty = database.statistics.inspect({
      ...baselineQuery,
      window: {
        kind: "explicit-utc-half-open",
        startInclusive: "2026-08-02T00:00:00.000Z",
        endExclusive: "2026-08-03T00:00:00.000Z",
      },
    });
    assert.deepEqual(
      empty.observations.find(
        (entry) => entry.metricId === "review-finding-count",
      ),
      {
        metricId: "review-finding-count",
        status: "available",
        measurement: { kind: "count", value: 0 },
        sourceFactFamily: "review-finding",
        sourceFactRefs: [],
      },
    );
    assert.equal(
      empty.observations.find(
        (entry) => entry.metricId === "review-recheck-pass-rate",
      )?.status,
      "unavailable",
    );

    const repositoryFiltered = database.statistics.inspect({
      ...baselineQuery,
      filters: { repositoryIds: ["repository:sandcastle"] },
    });
    assert.equal(repositoryFiltered.completeness.status, "unavailable");
    assert.equal(
      repositoryFiltered.observations.every(
        (entry) =>
          entry.status === "unavailable" &&
          entry.unavailableReasonCode === "missing-dimension-attribution",
      ),
      true,
    );
    database.close();
  });

  it("freezes one immutable restart-stable snapshot and replays the exact Command", () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "command:freeze-statistics",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:statistics",
        authenticatedBy: "runtime" as const,
      },
      consumerId: "statistics-runtime-test",
      command: {
        type: "statistics.evidence.freeze" as const,
        evidenceSnapshotId: "statistics-evidence:baseline",
        query: baselineQuery,
      },
    };

    const first = database.commandRegistry.execute(envelope);
    const replay = database.commandRegistry.execute(envelope);
    assert.equal(first.status, "succeeded");
    assert.deepEqual(replay, first);
    if (first.status !== "succeeded") assert.fail("freeze must succeed");
    assert.equal(first.value.id, "statistics-evidence:baseline");
    assert.equal(first.value.frozenBy.type, "runtime-worker");
    assert.deepEqual(
      database.statistics.inspectEvidence("statistics-evidence:baseline"),
      first.value,
    );
    database.close();

    database = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    assert.deepEqual(
      database.statistics.inspectEvidence("statistics-evidence:baseline"),
      first.value,
    );
    const sqlite = new DatabaseSync(database.path);
    assert.throws(
      () =>
        sqlite
          .prepare(
            "UPDATE statistics_evidence_snapshots SET observations_json = '[]' WHERE id = ?",
          )
          .run("statistics-evidence:baseline"),
      /Statistics evidence snapshot is immutable/,
    );
    sqlite.close();
    database.close();
  });

  it("reports literal governed execution reliability facts under one UTC half-open window", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedExecutionReliabilityFacts(database.path);
    const beforeSequence = database.eventSequence();

    const view = database.statistics.inspect({
      ...baselineQuery,
      comparisonSet: {
        id: "comparison:execution-reliability",
        metricIds: [
          "recovery-attempt-count",
          "ordinary-retry-count",
          "node-attempt-failure-rate",
          "lease-interruption-rate",
          "human-approval-wait",
          "governed-intervention-rate",
          "governed-execution-concurrency",
          "department-run-failure-rate",
        ],
      },
    });

    assert.deepEqual(
      view.observations.map((observation) => ({
        metricId: observation.metricId,
        status: observation.status,
        measurement:
          observation.status === "available" ? observation.measurement : null,
      })),
      [
        {
          metricId: "department-run-failure-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "governed-execution-concurrency",
          status: "available",
          measurement: { kind: "concurrency", maximum: 2, intervalCount: 3 },
        },
        {
          metricId: "governed-intervention-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 3,
            value: 1 / 3,
          },
        },
        {
          metricId: "human-approval-wait",
          status: "available",
          measurement: { kind: "duration", milliseconds: 600_000 },
        },
        {
          metricId: "lease-interruption-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 3,
            value: 1 / 3,
          },
        },
        {
          metricId: "node-attempt-failure-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "ordinary-retry-count",
          status: "available",
          measurement: { kind: "count", value: 1 },
        },
        {
          metricId: "recovery-attempt-count",
          status: "available",
          measurement: { kind: "count", value: 1 },
        },
      ],
    );
    assert.equal(view.completeness.status, "complete");
    assert.equal(database.eventSequence(), beforeSequence);
    database.close();
  });

  it("marks governed execution evidence incomplete when exact attempt attribution is missing", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedExecutionReliabilityFacts(database.path);
    const sqlite = new DatabaseSync(database.path);
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO governed_interventions(
        id, run_id, node_run_id, attempt_id, snapshot_revision_id, actor_id,
        reason, feedback, outcome, created_at
      ) VALUES (
        'intervention:missing-attempt', 'run:reliability:completed',
        'node-run:reliability:completed', NULL,
        'snapshot:reliability:completed', 'human:statistics',
        'Missing attempt authority', 'Do not guess the affected attempt.',
        'feedback', '2026-08-01T01:25:00.000Z'
      );
    `);
    sqlite.close();

    const view = database.statistics.inspect({
      ...baselineQuery,
      comparisonSet: {
        id: "comparison:missing-execution-attribution",
        metricIds: ["governed-intervention-rate"],
      },
    });
    assert.deepEqual(view.observations[0], {
      metricId: "governed-intervention-rate",
      status: "incomplete",
      reason:
        "A governed intervention does not identify its affected Node Attempt.",
      missingFactKinds: ["governed-intervention-attempt-attribution"],
      sourceFactFamily: "governed-intervention",
      sourceFactRefs: ["intervention:missing-attempt"],
    });
    assert.equal(view.completeness.status, "incomplete");

    const unavailableDimensionFilters: Array<
      readonly [string, NonNullable<StatisticsInspectInput["filters"]>]
    > = [
      ["ai-member", { aiMemberIds: ["ai-member:missing-attribution"] }],
      ["model", { modelIds: ["model:missing-attribution"] }],
      ["repository", { repositoryIds: ["repository:missing-attribution"] }],
      [
        "work-package",
        { workPackageIds: ["work-package:missing-attribution"] },
      ],
    ];
    for (const [id, filters] of unavailableDimensionFilters) {
      const filtered = database.statistics.inspect({
        ...baselineQuery,
        filters,
        comparisonSet: {
          id: `comparison:${id}-attribution`,
          metricIds: ["governed-execution-concurrency", "ordinary-retry-count"],
        },
      });
      assert.equal(
        filtered.observations.every(
          (observation) =>
            observation.status === "unavailable" &&
            observation.unavailableReasonCode ===
              "missing-dimension-attribution",
        ),
        true,
      );
    }
    const exactLineageFilters: Array<
      readonly [string, NonNullable<StatisticsInspectInput["filters"]>]
    > = [
      ["department", { departmentIds: ["department:outside-cohort"] }],
      ["pipeline", { pipelineVersionIds: ["pipeline:outside-cohort"] }],
    ];
    for (const [id, filters] of exactLineageFilters) {
      const filtered = database.statistics.inspect({
        ...baselineQuery,
        filters,
        comparisonSet: {
          id: `comparison:${id}-filter`,
          metricIds: ["ordinary-retry-count"],
        },
      });
      assert.deepEqual(filtered.observations[0], {
        metricId: "ordinary-retry-count",
        status: "available",
        measurement: { kind: "count", value: 0 },
        sourceFactFamily: "node-attempt",
        sourceFactRefs: [],
      });
    }
    database.close();
  });

  it("keeps frozen execution reliability evidence restart-stable", () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedExecutionReliabilityFacts(database.path);
    const query = {
      ...baselineQuery,
      comparisonSet: {
        id: "comparison:execution-reliability-restart",
        metricIds: [
          "department-run-failure-rate" as const,
          "governed-execution-concurrency" as const,
          "governed-intervention-rate" as const,
          "human-approval-wait" as const,
          "lease-interruption-rate" as const,
          "node-attempt-failure-rate" as const,
          "ordinary-retry-count" as const,
          "recovery-attempt-count" as const,
        ],
      },
    };
    const result = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:freeze-execution-reliability",
      actor: {
        type: "human",
        id: "human:statistics",
        authenticatedBy: "local-session",
      },
      command: {
        type: "statistics.evidence.freeze",
        evidenceSnapshotId: "statistics-evidence:execution-reliability",
        query,
      },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") assert.fail("freeze must succeed");
    database.close();

    database = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    assert.deepEqual(
      database.statistics.inspectEvidence(result.value.id),
      result.value,
    );
    database.close();
  });

  it("reports literal quality, delivery, and governed Memory rates", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedQualityDeliveryMemoryFacts(database.path);
    const beforeSequence = database.eventSequence();

    const view = database.statistics.inspect({
      ...baselineQuery,
      filters: {},
      cohort: { id: "cohort:all" },
      comparisonSet: {
        id: "comparison:quality-delivery-memory",
        metricIds: [
          "test-pass-rate",
          "release-item-success-rate",
          "memory-selection-rate",
          "memory-promotion-rate",
          "integration-conflict-rate",
          "electron-ui-runtime-mismatch-rate",
          "delivery-candidate-acceptance-rate",
          "code-review-defect-incidence",
        ],
      },
    });

    assert.deepEqual(
      view.observations.map((observation) => ({
        metricId: observation.metricId,
        status: observation.status,
        measurement:
          observation.status === "available" ? observation.measurement : null,
      })),
      [
        {
          metricId: "code-review-defect-incidence",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "delivery-candidate-acceptance-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "electron-ui-runtime-mismatch-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "integration-conflict-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "memory-promotion-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 2,
            denominator: 3,
            value: 2 / 3,
          },
        },
        {
          metricId: "memory-selection-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
        {
          metricId: "release-item-success-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 2,
            denominator: 3,
            value: 2 / 3,
          },
        },
        {
          metricId: "test-pass-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
      ],
    );
    assert.equal(view.completeness.status, "complete");
    assert.equal(database.eventSequence(), beforeSequence);
    database.close();
  });

  it("keeps exact zero rates distinct from a missing denominator for every completed metric family", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedQualityDeliveryMemoryFacts(database.path);
    const cases = [
      [
        "code-review-defect-incidence",
        "2026-08-01T07:00:00.000Z",
        "2026-08-01T07:05:00.000Z",
      ],
      [
        "integration-conflict-rate",
        "2026-08-01T08:05:00.000Z",
        "2026-08-01T08:09:00.000Z",
      ],
      [
        "test-pass-rate",
        "2026-08-01T09:29:00.000Z",
        "2026-08-01T09:31:00.000Z",
      ],
      [
        "electron-ui-runtime-mismatch-rate",
        "2026-08-01T09:14:00.000Z",
        "2026-08-01T09:16:00.000Z",
      ],
      [
        "delivery-candidate-acceptance-rate",
        "2026-08-01T10:14:00.000Z",
        "2026-08-01T10:16:00.000Z",
      ],
      [
        "release-item-success-rate",
        "2026-08-01T11:11:30.000Z",
        "2026-08-01T11:12:30.000Z",
      ],
      [
        "memory-promotion-rate",
        "2026-08-01T12:12:00.000Z",
        "2026-08-01T12:13:00.000Z",
      ],
      [
        "memory-selection-rate",
        "2026-08-01T12:11:00.000Z",
        "2026-08-01T12:12:00.000Z",
      ],
    ] as const;

    for (const [metricId, startInclusive, endExclusive] of cases) {
      const observation = database.statistics.inspect({
        ...baselineQuery,
        filters: {},
        cohort: { id: "cohort:all" },
        window: {
          kind: "explicit-utc-half-open",
          startInclusive,
          endExclusive,
        },
        comparisonSet: {
          id: `comparison:exact-zero:${metricId}`,
          metricIds: [metricId],
        },
      }).observations[0];
      if (!observation) assert.fail(`${metricId} observation must exist`);
      if (observation.status !== "available") {
        assert.fail(`${metricId} must be an available exact zero`);
      }
      assert.deepEqual(
        observation.measurement,
        { kind: "rate", numerator: 0, denominator: 1, value: 0 },
        metricId,
      );
    }
    database.close();
  });

  it("fails closed when quality, delivery, or governed Memory source facts are incomplete", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedQualityDeliveryMemoryFacts(database.path);
    const sqlite = new DatabaseSync(database.path);
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO integration_defects(
        id, generation_id, integration_operation_id, kind, responsibility_json,
        evidence_json, status, created_at
      ) VALUES (
        'integration-defect:unbound', 'integration-generation:statistics', NULL,
        'git-conflict', '{}', '{}', 'open', '2026-08-01T08:13:00.000Z'
      );
      INSERT INTO test_runs(
        id, request_id, project_id, run_id, snapshot_revision_id, node_run_id,
        node_attempt_id, session_id, integration_generation_id,
        integration_manifest_hash, integration_pass_authority_hash,
        manifest_json, manifest_hash, request_hash, state, pass_authority_hash,
        created_at, updated_at
      ) VALUES (
        'test-run:incomplete-electron', 'test-request:incomplete-electron',
        'project:statistics', 'run:statistics', 'snapshot:statistics',
        'node-run:test:incomplete-electron', 'attempt:test:incomplete-electron',
        'session:test:incomplete-electron', 'integration-generation:statistics',
        '${hash}', '${hash}', '{}', '${hash}', '${hash}', 'running', NULL,
        '2026-08-01T09:40:00.000Z', '2026-08-01T09:40:00.000Z'
      );
      INSERT INTO test_assertion_results(
        id, test_run_id, operation_id, test_case_revision_id, assertion_id,
        required, ui_status, runtime_status, correlation_json, result_hash,
        created_at, ui_observation_json, runtime_observation_json
      ) VALUES (
        'assertion:missing-ui', 'test-run:incomplete-electron',
        'test-operation:incomplete-electron',
        'test-case-revision:incomplete-electron', 'missing-ui', 1, 'missing',
        'passed', '{}', '${hash}', '2026-08-01T09:41:00.000Z', '{}', '{}'
      );
      INSERT INTO release_operation_items(
        id, operation_id, item_key, ordinal, kind, request_json, request_hash,
        state, receipt_json, receipt_hash, evidence_json, created_at, updated_at
      ) VALUES (
        'release-item:unknown', 'release-operation:statistics', 'item:unknown',
        3, 'export', '{}', '${hash}', 'unknown', NULL, NULL, '{}',
        '2026-08-01T11:08:00.000Z', '2026-08-01T11:13:00.000Z'
      );
      INSERT INTO reviewed_memory_candidate_revisions(
        id, candidate_id, project_id, scope, revision, content, content_hash,
        redaction_policy_version, redaction_policy_hash,
        source_artifact_versions_json, source_event_ranges_json,
        producer_ai_member_id, producer_position_id, producer_session_id,
        created_at
      ) VALUES (
        'memory-revision:accepted-without-entry',
        'memory-candidate:accepted-without-entry', 'project:statistics',
        'project', 1, 'Missing promoted entry', '${hash}', '1', '${hash}', '[]',
        '[]', 'producer:memory', 'position:memory', 'session:memory:missing',
        '2026-08-01T12:03:00.000Z'
      );
      INSERT INTO reviewed_memory_decisions(
        id, candidate_revision_id, candidate_revision_hash, topic_id,
        quality_gate_result_id, decision, actor_type, actor_id,
        authenticated_by, command_id, created_at
      ) VALUES (
        'memory-decision:accepted-without-entry',
        'memory-revision:accepted-without-entry', '${hash}',
        'topic:memory:missing', 'quality-gate:memory:missing', 'accepted',
        'human', 'human:statistics', 'local-session', 'command:memory:missing',
        '2026-08-01T12:13:00.000Z'
      );
    `);
    sqlite.close();

    const inspectOne = (
      metricId: StatisticsInspectInput["comparisonSet"]["metricIds"][number],
    ) =>
      database.statistics.inspect({
        ...baselineQuery,
        filters: {},
        cohort: { id: "cohort:all" },
        comparisonSet: {
          id: `comparison:gap:${metricId}`,
          metricIds: [metricId],
        },
      }).observations[0];

    assert.deepEqual(inspectOne("integration-conflict-rate"), {
      metricId: "integration-conflict-rate",
      status: "incomplete",
      reason:
        "An Integration conflict does not identify its exact Integration operation.",
      missingFactKinds: ["integration-conflict-operation-attribution"],
      sourceFactFamily: "integration-operation",
      sourceFactRefs: ["integration-defect:unbound"],
    });
    assert.deepEqual(inspectOne("electron-ui-runtime-mismatch-rate"), {
      metricId: "electron-ui-runtime-mismatch-rate",
      status: "incomplete",
      reason:
        "An Electron assertion lacks an exact UI and Runtime result pair.",
      missingFactKinds: ["exact-electron-ui-runtime-result-pair"],
      sourceFactFamily: "test-assertion-result",
      sourceFactRefs: ["assertion:missing-ui"],
    });
    assert.deepEqual(inspectOne("release-item-success-rate"), {
      metricId: "release-item-success-rate",
      status: "incomplete",
      reason: "A Release item has an unknown terminal outcome.",
      missingFactKinds: ["release-item-terminal-outcome"],
      sourceFactFamily: "release-operation-item",
      sourceFactRefs: ["release-item:unknown"],
    });
    assert.deepEqual(inspectOne("memory-promotion-rate"), {
      metricId: "memory-promotion-rate",
      status: "incomplete",
      reason:
        "An accepted reviewed Memory decision lacks its promoted Memory entry.",
      missingFactKinds: ["accepted-memory-entry"],
      sourceFactFamily: "reviewed-memory-decision",
      sourceFactRefs: ["memory-decision:accepted-without-entry"],
    });
    database.close();
  });

  it("reports stable unavailable reasons for unsupported catalog metrics and Memory dimensions", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedQualityDeliveryMemoryFacts(database.path);

    const unsupported = database.statistics.inspect({
      ...baselineQuery,
      filters: {},
      comparisonSet: {
        id: "comparison:unsupported-statistics-at-1",
        metricIds: [
          "whole-run-token-cost",
          "security-operability-high-risk-closure-rate",
          "heterogeneous-defect-aggregate-rate",
          "complete-model-attribution",
        ],
      },
    });
    assert.deepEqual(
      unsupported.observations.map((observation) => ({
        metricId: observation.metricId,
        status: observation.status,
        reason:
          observation.status === "unavailable" ? observation.reason : null,
        code:
          observation.status === "unavailable"
            ? observation.unavailableReasonCode
            : null,
      })),
      [
        {
          metricId: "complete-model-attribution",
          status: "unavailable",
          reason:
            "statistics@1 lacks complete exact Model attribution across governed executions.",
          code: "unsupported-by-statistics-at-1",
        },
        {
          metricId: "heterogeneous-defect-aggregate-rate",
          status: "unavailable",
          reason:
            "statistics@1 has no comparable denominator across heterogeneous Defect kinds.",
          code: "unsupported-by-statistics-at-1",
        },
        {
          metricId: "security-operability-high-risk-closure-rate",
          status: "unavailable",
          reason:
            "statistics@1 lacks exact Security and Operability high-risk closure lineage.",
          code: "unsupported-by-statistics-at-1",
        },
        {
          metricId: "whole-run-token-cost",
          status: "unavailable",
          reason:
            "statistics@1 lacks complete immutable whole-Run Token and cost facts.",
          code: "unsupported-by-statistics-at-1",
        },
      ],
    );

    for (const filters of [
      { departmentIds: ["software-rnd"] },
      { pipelineVersionIds: ["software-rnd-pipeline-v1"] },
    ]) {
      const filtered = database.statistics.inspect({
        ...baselineQuery,
        filters,
        comparisonSet: {
          id: "comparison:memory-missing-dimension",
          metricIds: ["memory-promotion-rate", "memory-selection-rate"],
        },
      });
      assert.equal(
        filtered.observations.every(
          (observation) =>
            observation.status === "unavailable" &&
            observation.unavailableReasonCode ===
              "missing-dimension-attribution",
        ),
        true,
      );
    }
    database.close();
  });

  it("excludes every quality, delivery, and governed Memory fact at endExclusive", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedQualityDeliveryMemoryFacts(database.path);
    const sqlite = new DatabaseSync(database.path);
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO code_review_manifests(
        id, topic_id, project_id, run_id, snapshot_revision_id, work_package_id,
        work_package_version_id, assignment_id, node_attempt_id,
        workspace_import_id, diff_artifact_version_id, manifest_json,
        manifest_hash, created_at
      ) VALUES (
        'code-review:end-exclusive', 'topic:code-review:end-exclusive',
        'project:statistics', 'run:statistics', 'snapshot:statistics',
        'work-package:end-exclusive', 'work-package-version:end-exclusive',
        'assignment:end-exclusive', 'attempt:end-exclusive',
        'workspace-import:end-exclusive', 'artifact:diff:end-exclusive', '{}',
        '${hash}', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO integration_operations(
        id, generation_id, repository_result_id, work_package_id,
        work_package_version_id, authority_id, quality_gate_result_id, ordinal,
        source_branch, source_commit, diff_hash, expected_tip, request_json,
        request_hash, idempotency_key, state, receipt_json, receipt_hash,
        resulting_commit, created_at, updated_at
      ) VALUES (
        'integration-operation:end-exclusive',
        'integration-generation:statistics', 'repository-result:statistics',
        'work-package:end-exclusive', 'work-package-version:end-exclusive',
        'code-review-authority:end-exclusive',
        'quality-gate:end-exclusive', 2, 'branch:end-exclusive',
        '${"f".repeat(40)}', '${hash}', '${"1".repeat(40)}', '{}', '${hash}',
        'integration:end-exclusive', 'failed', NULL, NULL, NULL,
        '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO integration_defects(
        id, generation_id, integration_operation_id, kind, responsibility_json,
        evidence_json, status, created_at
      ) VALUES (
        'integration-defect:end-exclusive',
        'integration-generation:statistics',
        'integration-operation:end-exclusive', 'git-conflict', '{}', '{}',
        'open', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO test_runs(
        id, request_id, project_id, run_id, snapshot_revision_id, node_run_id,
        node_attempt_id, session_id, integration_generation_id,
        integration_manifest_hash, integration_pass_authority_hash,
        manifest_json, manifest_hash, request_hash, state, pass_authority_hash,
        created_at, updated_at
      ) VALUES (
        'test-run:end-exclusive', 'test-request:end-exclusive',
        'project:statistics', 'run:statistics', 'snapshot:statistics',
        'node-run:test:end-exclusive', 'attempt:test:end-exclusive',
        'session:test:end-exclusive', 'integration-generation:statistics',
        '${hash}', '${hash}', '{}', '${hash}', '${hash}', 'running', NULL,
        '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO test_assertion_results(
        id, test_run_id, operation_id, test_case_revision_id, assertion_id,
        required, ui_status, runtime_status, correlation_json, result_hash,
        created_at, ui_observation_json, runtime_observation_json
      ) VALUES (
        'assertion:end-exclusive', 'test-run:end-exclusive',
        'test-operation:end-exclusive', 'test-case-revision:end-exclusive',
        'end-exclusive', 1, 'failed', 'passed', '{}', '${hash}',
        '2026-08-02T00:00:00.000Z', '{}', '{}'
      );
      UPDATE test_runs
         SET state = 'failed', updated_at = '2026-08-02T00:00:00.000Z'
       WHERE id = 'test-run:end-exclusive';
      INSERT INTO delivery_candidates(
        id, request_id, project_id, run_id, snapshot_revision_id,
        candidate_input_id, candidate_input_hash, gate_authority_id,
        gate_authority_hash, source_node_run_id, source_node_attempt_id,
        lineage_hash, manifest_json, manifest_hash, request_hash, created_at
      ) VALUES (
        'delivery-candidate:end-exclusive', 'delivery-request:end-exclusive',
        'project:statistics', 'run:statistics', 'snapshot:statistics',
        'candidate-input:end-exclusive', '${hash}',
        'gate-authority:end-exclusive', '${hash}',
        'node-run:delivery:end-exclusive', 'attempt:delivery:end-exclusive',
        '${hash}', '{}', '${hash}', '${hash}', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO human_release_decisions(
        id, candidate_id, candidate_hash, run_id, snapshot_revision_id,
        decision, actor_type, actor_id, authenticated_by, reason,
        evidence_refs_json, decision_hash, created_at
      ) VALUES (
        'release-decision:end-exclusive',
        'delivery-candidate:end-exclusive', '${hash}', 'run:statistics',
        'snapshot:statistics', 'accepted', 'human', 'human:statistics',
        'local-session', 'Boundary decision', '[]', '${hash}',
        '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO release_operation_items(
        id, operation_id, item_key, ordinal, kind, request_json, request_hash,
        state, receipt_json, receipt_hash, evidence_json, created_at, updated_at
      ) VALUES (
        'release-item:end-exclusive', 'release-operation:statistics',
        'item:end-exclusive', 3, 'export', '{}', '${hash}', 'succeeded', '{}',
        '${hash}', '{}', '2026-08-02T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO reviewed_memory_candidate_revisions(
        id, candidate_id, project_id, scope, revision, content, content_hash,
        redaction_policy_version, redaction_policy_hash,
        source_artifact_versions_json, source_event_ranges_json,
        producer_ai_member_id, producer_position_id, producer_session_id,
        created_at
      ) VALUES (
        'memory-revision:end-exclusive', 'memory-candidate:end-exclusive',
        'project:statistics', 'project', 1, 'Boundary memory', '${hash}', '1',
        '${hash}', '[]', '[]', 'producer:memory', 'position:memory',
        'session:memory:end-exclusive', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO reviewed_memory_decisions(
        id, candidate_revision_id, candidate_revision_hash, topic_id,
        quality_gate_result_id, decision, actor_type, actor_id,
        authenticated_by, command_id, created_at
      ) VALUES (
        'memory-decision:end-exclusive', 'memory-revision:end-exclusive',
        '${hash}', 'topic:memory:end-exclusive',
        'quality-gate:memory:end-exclusive', 'rejected', 'human',
        'human:statistics', 'local-session', 'command:memory:end-exclusive',
        '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO reviewed_memory_entries(
        id, decision_id, candidate_revision_id, project_id, scope, owner_id,
        version, content, content_hash, redaction_policy_version,
        redaction_policy_hash, quality_gate_result_id, created_at
      ) VALUES (
        'memory-entry:end-exclusive', 'memory-decision:end-exclusive',
        'memory-revision:end-exclusive', 'project:statistics', 'project',
        'project:statistics', 3, 'Boundary memory', '${hash}', '1', '${hash}',
        'quality-gate:memory:end-exclusive', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO run_memory_selections(
        id, project_id, run_id, source_snapshot_revision_id,
        snapshot_revision_id, entry_id, entry_version, entry_hash,
        selection_reason, policy_hash, created_at
      ) VALUES (
        'memory-selection:end-exclusive', 'project:statistics',
        'run:statistics', 'snapshot:source', 'snapshot:selected:end-exclusive',
        'memory-entry:2', 2, '${hash}', 'Boundary selection', '${hash}',
        '2026-08-02T00:00:00.000Z'
      );
    `);
    sqlite.close();

    const view = database.statistics.inspect({
      ...baselineQuery,
      filters: {},
      cohort: { id: "cohort:all" },
      comparisonSet: {
        id: "comparison:quality-delivery-memory-boundary",
        metricIds: [
          "code-review-defect-incidence",
          "delivery-candidate-acceptance-rate",
          "electron-ui-runtime-mismatch-rate",
          "integration-conflict-rate",
          "memory-promotion-rate",
          "memory-selection-rate",
          "release-item-success-rate",
          "test-pass-rate",
        ],
      },
    });
    assert.deepEqual(
      view.observations.map((observation) =>
        observation.status === "available"
          ? [observation.metricId, observation.measurement]
          : [observation.metricId, observation.status],
      ),
      [
        [
          "code-review-defect-incidence",
          { kind: "rate", numerator: 1, denominator: 2, value: 0.5 },
        ],
        [
          "delivery-candidate-acceptance-rate",
          { kind: "rate", numerator: 1, denominator: 2, value: 0.5 },
        ],
        [
          "electron-ui-runtime-mismatch-rate",
          { kind: "rate", numerator: 1, denominator: 2, value: 0.5 },
        ],
        [
          "integration-conflict-rate",
          { kind: "rate", numerator: 1, denominator: 2, value: 0.5 },
        ],
        [
          "memory-promotion-rate",
          { kind: "rate", numerator: 2, denominator: 3, value: 2 / 3 },
        ],
        [
          "memory-selection-rate",
          { kind: "rate", numerator: 1, denominator: 2, value: 0.5 },
        ],
        [
          "release-item-success-rate",
          { kind: "rate", numerator: 2, denominator: 3, value: 2 / 3 },
        ],
        [
          "test-pass-rate",
          { kind: "rate", numerator: 1, denominator: 2, value: 0.5 },
        ],
      ],
    );
    database.close();
  });

  it("freezes and replays the completed statistics@1 catalog with a restart-stable hash", () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    seedExecutionReliabilityFacts(database.path);
    seedQualityDeliveryMemoryFacts(database.path);
    const completedCatalogQuery: StatisticsInspectInput = {
      ...baselineQuery,
      filters: {},
      cohort: { id: "cohort:all" },
      comparisonSet: {
        id: "comparison:statistics-at-1-complete-catalog",
        metricIds: [
          "code-review-defect-incidence",
          "complete-model-attribution",
          "delivery-candidate-acceptance-rate",
          "department-run-failure-rate",
          "electron-ui-runtime-mismatch-rate",
          "governed-execution-concurrency",
          "governed-intervention-rate",
          "heterogeneous-defect-aggregate-rate",
          "human-approval-wait",
          "integration-conflict-rate",
          "lease-interruption-rate",
          "memory-promotion-rate",
          "memory-selection-rate",
          "node-attempt-failure-rate",
          "ordinary-retry-count",
          "product-baseline-confirmation-count",
          "product-baseline-confirmation-latency",
          "readiness-blocker-count",
          "recovery-attempt-count",
          "release-item-success-rate",
          "review-discussion-round-count",
          "review-finding-count",
          "review-recheck-pass-rate",
          "security-operability-high-risk-closure-rate",
          "test-pass-rate",
          "whole-run-token-cost",
        ],
      },
    };
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "command:freeze-completed-statistics-catalog",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:statistics",
        authenticatedBy: "runtime" as const,
      },
      consumerId: "statistics-runtime-test",
      command: {
        type: "statistics.evidence.freeze" as const,
        evidenceSnapshotId: "statistics-evidence:completed-catalog",
        query: completedCatalogQuery,
      },
    };

    const first = database.commandRegistry.execute(envelope);
    const sameProcessReplay = database.commandRegistry.execute(envelope);
    assert.equal(first.status, "succeeded");
    assert.deepEqual(sameProcessReplay, first);
    if (first.status !== "succeeded") assert.fail("freeze must succeed");
    assert.equal(first.value.observations.length, 26);
    assert.deepEqual(first.value.completeness.unavailableMetricIds, [
      "complete-model-attribution",
      "heterogeneous-defect-aggregate-rate",
      "security-operability-high-risk-closure-rate",
      "whole-run-token-cost",
    ]);
    database.close();

    database = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    const restartReplay = database.commandRegistry.execute(envelope);
    assert.deepEqual(restartReplay, first);
    assert.deepEqual(
      database.statistics.inspectEvidence(first.value.id),
      first.value,
    );
    assert.equal(
      database.statistics.inspectEvidence(first.value.id).hash,
      first.value.hash,
    );
    database.close();
  });
});
