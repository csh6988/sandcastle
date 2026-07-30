import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ArtifactRegistry,
  ArtifactVersionView,
} from "../artifactRegistry.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type {
  IntegrationGenerationView,
  IntegrationRuntime,
} from "../integration/integrationRuntime.js";
import type {
  TestCaseRevisionView,
  TestRuntime,
} from "../testing/testRuntime.js";

export type CandidateRiskTier = "low" | "medium" | "high" | "critical";

export class CandidateInputRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CandidateInputRuntimeError";
  }
}

type TestPassAuthority = ReturnType<TestRuntime["downstreamAuthority"]>;

export type CandidateEvidenceDescriptor = {
  readonly id: string;
  readonly testRunId: string;
  readonly testCaseRevisionId: string | null;
  readonly assertionId: string | null;
  readonly kind: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly artifactVersionId: string | null;
  readonly redactionProfile: string;
  readonly retentionClass: "transient" | "standard" | "durable";
  readonly locator: string | null;
  readonly metadata: unknown;
};

export type DeliveryCandidateInputManifest = {
  readonly schemaVersion: 1;
  readonly candidateInputId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly snapshot: {
    readonly id: string;
    readonly hash: string;
    readonly payload: unknown;
  };
  readonly sourceNode: {
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
  };
  readonly producer: {
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
  };
  readonly product: {
    readonly baselineId: string;
    readonly baselineHash: string;
    readonly sourceProposalRevisionId: string;
    readonly sourceProposalHash: string;
    readonly projectSpecRevisionId: string;
    readonly projectSpecHash: string;
    readonly productQualityGateResultId: string;
    readonly readinessEvidenceIds: readonly string[];
  };
  readonly technical: {
    readonly baselineId: string;
    readonly baselineHash: string;
    readonly proposalRevisionId: string;
    readonly proposalRevisionHash: string;
    readonly technicalQualityGateResultId: string;
    readonly applicationSpecRevisions: readonly {
      readonly id: string;
      readonly applicationId: string;
      readonly revision: number;
      readonly hash: string;
    }[];
    readonly manifest: unknown;
  };
  readonly codeReviewCoverage: IntegrationGenerationView["manifest"]["packages"];
  readonly integration: IntegrationGenerationView;
  readonly repositoryCommits: readonly {
    readonly repositoryReference: string;
    readonly commit: string;
  }[];
  readonly contracts: IntegrationGenerationView["manifest"]["contractVersions"];
  readonly tests: readonly TestPassAuthority[];
  readonly testCaseRevisions: readonly TestCaseRevisionView[];
  readonly evidence: readonly CandidateEvidenceDescriptor[];
  readonly artifacts: readonly ArtifactVersionView[];
  readonly risk: {
    readonly policyRevisionId: "delivery-candidate-risk@1";
    readonly policyHash: string;
    readonly factors: readonly {
      readonly id: string;
      readonly minimumTier: CandidateRiskTier;
      readonly present: boolean;
      readonly evidenceRefs: readonly string[];
    }[];
    readonly tier: CandidateRiskTier;
    readonly inputHash: string;
  };
  readonly environment: {
    readonly platform: string;
    readonly architecture: string;
    readonly electronVersion: string;
    readonly executableHash: string;
    readonly capabilityProfileHash: string;
  };
  readonly evidencePolicy: {
    readonly revisionId: string;
    readonly redactionProfile: string;
    readonly retentionClass: "transient" | "standard" | "durable";
    readonly maxItemBytes: number;
    readonly maxTotalBytes: number;
  };
};

export type DeliveryCandidateInputView = {
  readonly id: string;
  readonly requestId: string;
  readonly manifest: DeliveryCandidateInputManifest;
  readonly manifestHash: string;
  readonly state: "frozen-for-final-gates";
  readonly createdAt: string;
};

export type FreezeCandidateInput = {
  readonly candidateInputId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly nodeRunId: string;
  readonly nodeAttemptId: string;
  readonly producer: DeliveryCandidateInputManifest["producer"];
  readonly requiredTestRunIds: readonly string[];
  readonly environment: DeliveryCandidateInputManifest["environment"];
  readonly evidencePolicy: DeliveryCandidateInputManifest["evidencePolicy"];
};

export interface CandidateInputRuntime {
  readonly freeze: (input: FreezeCandidateInput) => DeliveryCandidateInputView;
  readonly inspect: (candidateInputId: string) => DeliveryCandidateInputView;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
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

const parseJson = <Value>(value: string, label: string): Value => {
  try {
    return JSON.parse(value) as Value;
  } catch (error) {
    throw new CandidateInputRuntimeError(
      "CANDIDATE_INPUT_LINEAGE_INVALID",
      `${label} is invalid JSON: ${String(error)}`,
    );
  }
};

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort();

const tierRank: Readonly<Record<CandidateRiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const maxTier = (values: readonly CandidateRiskTier[]): CandidateRiskTier =>
  values.reduce<CandidateRiskTier>(
    (current, value) => (tierRank[value] > tierRank[current] ? value : current),
    "low",
  );

const compareBy =
  <Value>(
    selector: (value: Value) => string,
  ): ((left: Value, right: Value) => number) =>
  (left, right) =>
    selector(left).localeCompare(selector(right));

export const openCandidateInputRuntime = (
  database: DatabaseSync,
  options: {
    readonly tests: Pick<
      TestRuntime,
      "downstreamAuthority" | "readCaseRevision"
    >;
    readonly integrations: Pick<IntegrationRuntime, "readPassAuthority">;
    readonly artifacts: Pick<ArtifactRegistry, "inspect">;
    readonly events?: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
  },
): CandidateInputRuntime => {
  const clock = options.clock ?? (() => new Date());

  const inspect = (candidateInputId: string): DeliveryCandidateInputView => {
    const row = database
      .prepare(
        `SELECT id, request_id AS requestId, manifest_json AS manifestJson,
                manifest_hash AS manifestHash, state, created_at AS createdAt
           FROM delivery_candidate_inputs WHERE id = ?`,
      )
      .get(candidateInputId) as
      | {
          readonly id: string;
          readonly requestId: string;
          readonly manifestJson: string;
          readonly manifestHash: string;
          readonly state: "frozen-for-final-gates";
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_INPUT_NOT_FOUND",
        `Delivery Candidate Input ${candidateInputId} was not found.`,
      );
    }
    const manifest = parseJson<DeliveryCandidateInputManifest>(
      row.manifestJson,
      `Delivery Candidate Input ${candidateInputId}`,
    );
    if (sha256(manifest) !== row.manifestHash) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_INPUT_HASH_MISMATCH",
        `Delivery Candidate Input ${candidateInputId} no longer matches its immutable manifest hash.`,
      );
    }
    return {
      id: row.id,
      requestId: row.requestId,
      manifest,
      manifestHash: row.manifestHash,
      state: row.state,
      createdAt: row.createdAt,
    };
  };

  const readSnapshot = (input: FreezeCandidateInput) => {
    const row = database
      .prepare(
        `SELECT run_id AS runId, canonical_json AS canonicalJson, hash
           FROM run_snapshot_revisions WHERE id = ?`,
      )
      .get(input.snapshotRevisionId) as
      | {
          readonly runId: string;
          readonly canonicalJson: string;
          readonly hash: string;
        }
      | undefined;
    if (
      !row ||
      row.runId !== input.runId ||
      sha256(row.canonicalJson) !== row.hash
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_SNAPSHOT_AUTHORITY_INVALID",
        "Delivery Candidate Input requires the exact immutable Snapshot Revision authority.",
      );
    }
    return {
      id: input.snapshotRevisionId,
      hash: row.hash,
      payload: parseJson(row.canonicalJson, "Snapshot"),
    };
  };

  const readProduct = (input: FreezeCandidateInput) => {
    const row = database
      .prepare(
        `SELECT baselines.id AS baselineId,
                baselines.project_id AS projectId,
                baselines.source_proposal_revision_id AS sourceProposalRevisionId,
                baselines.source_proposal_hash AS sourceProposalHash,
                baselines.canonical_hash AS baselineHash,
                promotions.quality_gate_result_id AS qualityGateResultId,
                promotions.project_spec_revision_id AS projectSpecRevisionId,
                promotions.project_spec_hash AS projectSpecHash,
                promotions.readiness_evidence_ids_json AS readinessEvidenceIdsJson
           FROM product_baselines AS baselines
           JOIN product_gate_promotions AS promotions
             ON promotions.run_id = baselines.run_id
          WHERE baselines.run_id = ?`,
      )
      .get(input.runId) as
      | {
          readonly baselineId: string;
          readonly projectId: string;
          readonly sourceProposalRevisionId: string;
          readonly sourceProposalHash: string;
          readonly baselineHash: string;
          readonly qualityGateResultId: string;
          readonly projectSpecRevisionId: string;
          readonly projectSpecHash: string;
          readonly readinessEvidenceIdsJson: string;
        }
      | undefined;
    if (!row || row.projectId !== input.projectId) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_PRODUCT_AUTHORITY_INVALID",
        "Delivery Candidate Input requires the accepted Product Baseline and Project Spec authority for the exact Run.",
      );
    }
    return {
      baselineId: row.baselineId,
      baselineHash: row.baselineHash,
      sourceProposalRevisionId: row.sourceProposalRevisionId,
      sourceProposalHash: row.sourceProposalHash,
      projectSpecRevisionId: row.projectSpecRevisionId,
      projectSpecHash: row.projectSpecHash,
      productQualityGateResultId: row.qualityGateResultId,
      readinessEvidenceIds: uniqueSorted(
        parseJson<readonly string[]>(
          row.readinessEvidenceIdsJson,
          "Product readiness evidence",
        ),
      ),
    };
  };

  const readTechnical = (input: FreezeCandidateInput, snapshotHash: string) => {
    const row = database
      .prepare(
        `SELECT promotions.technical_baseline_id AS baselineId,
                promotions.technical_baseline_hash AS baselineHash,
                promotions.proposal_revision_id AS proposalRevisionId,
                promotions.proposal_revision_hash AS proposalRevisionHash,
                promotions.quality_gate_result_id AS qualityGateResultId,
                promotions.snapshot_revision_id AS snapshotRevisionId,
                promotions.snapshot_hash AS snapshotHash,
                baselines.manifest_json AS manifestJson
           FROM technical_gate_promotions AS promotions
           JOIN technical_baselines AS baselines
             ON baselines.id = promotions.technical_baseline_id
          WHERE promotions.run_id = ?`,
      )
      .get(input.runId) as
      | {
          readonly baselineId: string;
          readonly baselineHash: string;
          readonly proposalRevisionId: string;
          readonly proposalRevisionHash: string;
          readonly qualityGateResultId: string;
          readonly snapshotRevisionId: string;
          readonly snapshotHash: string;
          readonly manifestJson: string;
        }
      | undefined;
    if (
      !row ||
      row.snapshotRevisionId !== input.snapshotRevisionId ||
      row.snapshotHash !== snapshotHash ||
      sha256(parseJson(row.manifestJson, "Technical Baseline")) !==
        row.baselineHash
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_TECHNICAL_AUTHORITY_INVALID",
        "Delivery Candidate Input requires the exact accepted Technical Baseline frozen by the Snapshot Revision.",
      );
    }
    const applicationSpecRows = database
      .prepare(
        `SELECT id, application_id AS applicationId, revision,
                content_hash AS hash
           FROM application_spec_revisions
          WHERE run_id = ? ORDER BY application_id, revision, id`,
      )
      .all(input.runId) as Array<{
      readonly id: string;
      readonly applicationId: string;
      readonly revision: number;
      readonly hash: string;
    }>;
    if (applicationSpecRows.length === 0) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_APPLICATION_SPEC_AUTHORITY_MISSING",
        "Delivery Candidate Input requires accepted Application Spec revisions.",
      );
    }
    return {
      baselineId: row.baselineId,
      baselineHash: row.baselineHash,
      proposalRevisionId: row.proposalRevisionId,
      proposalRevisionHash: row.proposalRevisionHash,
      technicalQualityGateResultId: row.qualityGateResultId,
      applicationSpecRevisions: applicationSpecRows,
      manifest: parseJson(row.manifestJson, "Technical Baseline"),
    };
  };

  const readEvidence = (
    testAuthorities: readonly TestPassAuthority[],
    evidencePolicy: FreezeCandidateInput["evidencePolicy"],
  ): readonly CandidateEvidenceDescriptor[] => {
    const descriptors = testAuthorities
      .flatMap((authority) =>
        authority.evidence.map((authorityEvidence) => {
          const row = database
            .prepare(
              `SELECT test_run_id AS testRunId,
                      test_case_revision_id AS testCaseRevisionId,
                      assertion_id AS assertionId, kind, media_type AS mediaType,
                      content_hash AS contentHash, byte_size AS byteSize,
                      artifact_version_id AS artifactVersionId,
                      redaction_profile AS redactionProfile,
                      retention_class AS retentionClass, locator,
                      metadata_json AS metadataJson
                 FROM test_evidence WHERE id = ?`,
            )
            .get(authorityEvidence.id) as
            | {
                readonly testRunId: string;
                readonly testCaseRevisionId: string | null;
                readonly assertionId: string | null;
                readonly kind: string;
                readonly mediaType: string;
                readonly contentHash: string;
                readonly byteSize: number;
                readonly artifactVersionId: string | null;
                readonly redactionProfile: string;
                readonly retentionClass: "transient" | "standard" | "durable";
                readonly locator: string | null;
                readonly metadataJson: string;
              }
            | undefined;
          if (
            !row ||
            row.testRunId !== authority.testRunId ||
            row.contentHash !== authorityEvidence.contentHash ||
            row.artifactVersionId !== authorityEvidence.artifactVersionId ||
            row.locator !== authorityEvidence.locator ||
            row.redactionProfile !== evidencePolicy.redactionProfile ||
            row.byteSize > evidencePolicy.maxItemBytes
          ) {
            throw new CandidateInputRuntimeError(
              "CANDIDATE_EVIDENCE_AUTHORITY_INVALID",
              `Test evidence ${authorityEvidence.id} is missing, stale, oversized, or violates the frozen redaction policy.`,
            );
          }
          return {
            id: authorityEvidence.id,
            ...row,
            metadata: parseJson(
              row.metadataJson,
              `Test evidence ${authorityEvidence.id}`,
            ),
          };
        }),
      )
      .sort(compareBy((entry) => entry.id));
    if (
      descriptors.reduce((total, entry) => total + entry.byteSize, 0) >
      evidencePolicy.maxTotalBytes
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_EVIDENCE_TOO_LARGE",
        "Delivery Candidate Input evidence exceeds the frozen aggregate size policy.",
      );
    }
    return descriptors;
  };

  const readArtifact = (
    versionId: string,
    projectId: string,
    runId: string,
    snapshotRevisionId: string,
  ): ArtifactVersionView => {
    let version: ArtifactVersionView;
    try {
      version = options.artifacts.inspect(versionId).version;
    } catch {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_ARTIFACT_AUTHORITY_INVALID",
        `Artifact Version ${versionId} is unavailable.`,
      );
    }
    if (
      version.projectId !== projectId ||
      version.producer.runId !== runId ||
      version.producer.snapshotRevisionId !== snapshotRevisionId ||
      version.integrityStatus !== "verified" ||
      version.lifecycle !== "finalized" ||
      !["produced", "accepted"].includes(version.status)
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_ARTIFACT_AUTHORITY_INVALID",
        `Artifact Version ${versionId} does not match the exact Run/Snapshot lineage or verified immutable integrity.`,
      );
    }
    return version;
  };

  const buildRisk = (
    tests: readonly TestPassAuthority[],
    contracts: IntegrationGenerationView["manifest"]["contractVersions"],
  ): DeliveryCandidateInputManifest["risk"] => {
    const testTier = maxTier(tests.map((test) => test.risk.computedTier));
    const sourceFactors = tests.flatMap((test) => test.risk.factors);
    const rules = [
      ["auth-permission", "high"],
      ["credential-materialization", "critical"],
      ["cross-application-contract", "high"],
      ["data-migration-pii", "high"],
      ["dependency-supply-chain", "medium"],
      ["destructive-action", "critical"],
      ["network-filesystem-scope", "high"],
      ["no-sandbox", "high"],
      ["production-deployment", "critical"],
      ["public-api", "high"],
      ["rollback-resource-timeout-recovery", "medium"],
      ["sandbox-boundary", "critical"],
      ["secret-environment-boundary", "high"],
      ["user-visible-runtime", "high"],
      ["work-package-risk-tier", testTier],
    ] as const satisfies readonly (readonly [string, CandidateRiskTier])[];
    const factors = rules.map(([id, minimumTier]) => {
      const matches = sourceFactors.filter((factor) => factor.id === id);
      const contractFactor =
        id === "cross-application-contract" && contracts.length > 0;
      const present =
        contractFactor || matches.some((factor) => factor.present);
      return {
        id,
        minimumTier,
        present,
        evidenceRefs: uniqueSorted([
          ...matches.flatMap((factor) => factor.evidenceRefs),
          ...(contractFactor
            ? contracts.map(
                (contract) =>
                  `contract:${contract.id}:${contract.version}:${contract.hash}`,
              )
            : []),
        ]),
      };
    });
    const tier = maxTier([
      testTier,
      ...factors
        .filter((factor) => factor.present)
        .map((factor) => factor.minimumTier),
    ]);
    const policyHash = sha256({
      schemaVersion: 1,
      revisionId: "delivery-candidate-risk@1",
      rules: rules.map(([factorId, minimumTier]) => ({
        factorId,
        minimumTier,
      })),
    });
    return {
      policyRevisionId: "delivery-candidate-risk@1",
      policyHash,
      factors,
      tier,
      inputHash: sha256({ policyHash, factors, tier }),
    };
  };

  const freeze = (input: FreezeCandidateInput): DeliveryCandidateInputView => {
    if (
      input.requiredTestRunIds.length === 0 ||
      uniqueSorted(input.requiredTestRunIds).length !==
        input.requiredTestRunIds.length
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_TEST_AUTHORITY_SET_INVALID",
        "Delivery Candidate Input requires a non-empty, duplicate-free exact Test authority set.",
      );
    }
    if (
      input.evidencePolicy.maxItemBytes <= 0 ||
      input.evidencePolicy.maxTotalBytes < input.evidencePolicy.maxItemBytes
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_EVIDENCE_POLICY_INVALID",
        "Delivery Candidate Input evidence size policy is invalid.",
      );
    }
    const snapshot = readSnapshot(input);
    const product = readProduct(input);
    const technical = readTechnical(input, snapshot.hash);
    const tests = uniqueSorted(input.requiredTestRunIds).map((testRunId) =>
      options.tests.downstreamAuthority(testRunId),
    );
    const integrationIds = uniqueSorted(
      tests.map((test) => test.integrationAuthority.generationId),
    );
    if (integrationIds.length !== 1) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_INTEGRATION_AUTHORITY_CONFLICT",
        "All required Test authorities must bind the same exact PASS Integration Generation.",
      );
    }
    const integration = options.integrations.readPassAuthority(
      integrationIds[0]!,
    );
    const repositoryCommits = integration.repositoryResults
      .map((result) => ({
        repositoryReference: result.repositoryReference,
        commit: result.integratedCommit,
      }))
      .filter(
        (entry): entry is { repositoryReference: string; commit: string } =>
          entry.commit !== null,
      )
      .sort(compareBy((entry) => entry.repositoryReference));
    for (const test of tests) {
      if (
        test.snapshotRevisionId !== input.snapshotRevisionId ||
        test.integrationAuthority.generationId !== integration.id ||
        test.integrationAuthority.manifestHash !== integration.manifestHash ||
        test.integrationAuthority.passAuthorityHash !==
          integration.passAuthorityHash ||
        canonicalJson(test.integrationAuthority.repositoryCommits) !==
          canonicalJson(repositoryCommits) ||
        test.openDefectIds.length > 0 ||
        test.openObligationIds.length > 0
      ) {
        throw new CandidateInputRuntimeError(
          "CANDIDATE_TEST_AUTHORITY_STALE",
          `Test Run ${test.testRunId} does not match the exact Candidate Input lineage.`,
        );
      }
      if (
        !["branch", "git-ref-write-isolation", "runtime-import-only"].every(
          (capability) => test.capabilities.includes(capability),
        )
      ) {
        throw new CandidateInputRuntimeError(
          "CANDIDATE_EXECUTION_ISOLATION_INVALID",
          `Test Run ${test.testRunId} does not prove isolated branch and Runtime-only import authority.`,
        );
      }
    }
    const testCaseRevisions = tests
      .flatMap((test) =>
        test.testCaseRevisions.map((revision) =>
          options.tests.readCaseRevision(revision.id, revision.hash),
        ),
      )
      .sort(compareBy((revision) => revision.id));
    if (
      new Set(testCaseRevisions.map((revision) => revision.id)).size !==
      testCaseRevisions.length
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_TEST_CASE_COVERAGE_CONFLICT",
        "Required Test authorities contain duplicate or conflicting Test Case revisions.",
      );
    }
    const requiredRequirements = uniqueSorted(
      integration.manifest.packages.flatMap(
        (entry) => entry.reviewContext.acceptanceCriteria,
      ),
    );
    const coveredRequirements = new Set(
      testCaseRevisions.flatMap((revision) => revision.manifest.requirementIds),
    );
    const requiredPackages = uniqueSorted(
      integration.manifest.packages.map((entry) => entry.workPackageVersionId),
    );
    const coveredPackages = new Set(
      testCaseRevisions.flatMap((revision) =>
        revision.manifest.workPackageVersions.map(
          (entry) => entry.workPackageVersionId,
        ),
      ),
    );
    if (
      requiredRequirements.some((id) => !coveredRequirements.has(id)) ||
      requiredPackages.some((id) => !coveredPackages.has(id)) ||
      testCaseRevisions.some(
        (revision) =>
          revision.manifest.assertions.length === 0 ||
          revision.manifest.assertions.some(
            (assertion) => !assertion.ui.kind || !assertion.runtime.kind,
          ),
      ) ||
      integration.manifest.requiredValidations.some(
        (validation) =>
          !integration.repositoryResults.some((repository) =>
            repository.validationRecords.some(
              (record) =>
                record.validationId === validation.id &&
                record.status === "passed",
            ),
          ),
      )
    ) {
      throw new CandidateInputRuntimeError(
        "CANDIDATE_TEST_COVERAGE_INCOMPLETE",
        "Required Test authorities do not completely cover requirements, Work Packages, Contracts, public UI, and Runtime scope.",
      );
    }
    const evidence = readEvidence(tests, input.evidencePolicy);
    const artifactIds = uniqueSorted([
      ...tests.map((test) => test.build.artifactVersionId),
      ...integration.manifest.packages.map(
        (entry) => entry.reviewContext.diffArtifactVersionId,
      ),
      ...evidence.flatMap((entry) =>
        entry.artifactVersionId ? [entry.artifactVersionId] : [],
      ),
    ]);
    const artifacts = artifactIds
      .map((id) =>
        readArtifact(
          id,
          input.projectId,
          input.runId,
          input.snapshotRevisionId,
        ),
      )
      .sort(compareBy((entry) => entry.id));
    const risk = buildRisk(tests, integration.manifest.contractVersions);
    const manifest: DeliveryCandidateInputManifest = {
      schemaVersion: 1,
      candidateInputId: input.candidateInputId,
      projectId: input.projectId,
      runId: input.runId,
      snapshot,
      sourceNode: {
        nodeRunId: input.nodeRunId,
        nodeAttemptId: input.nodeAttemptId,
      },
      producer: input.producer,
      product,
      technical,
      codeReviewCoverage: [...integration.manifest.packages].sort(
        compareBy((entry) => entry.workPackageVersionId),
      ),
      integration,
      repositoryCommits,
      contracts: [...integration.manifest.contractVersions].sort(
        compareBy((entry) => `${entry.id}:${entry.version}:${entry.hash}`),
      ),
      tests: [...tests].sort(compareBy((entry) => entry.testRunId)),
      testCaseRevisions,
      evidence,
      artifacts,
      risk,
      environment: input.environment,
      evidencePolicy: input.evidencePolicy,
    };
    const manifestHash = sha256(manifest);
    const requestHash = sha256({
      candidateInputId: input.candidateInputId,
      requestId: input.requestId,
      manifestHash,
    });
    const existing = database
      .prepare(
        `SELECT id, request_hash AS requestHash
           FROM delivery_candidate_inputs
          WHERE id = ? OR request_id = ?`,
      )
      .get(input.candidateInputId, input.requestId) as
      | { readonly id: string; readonly requestHash: string }
      | undefined;
    if (existing) {
      if (
        existing.id !== input.candidateInputId ||
        existing.requestHash !== requestHash
      ) {
        throw new CandidateInputRuntimeError(
          "CANDIDATE_INPUT_CONFLICT",
          "Delivery Candidate Input identity already binds a different immutable authority, evidence, risk, or environment.",
        );
      }
      return inspect(existing.id);
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO delivery_candidate_inputs(
           id, request_id, project_id, run_id, snapshot_revision_id,
           node_run_id, node_attempt_id, producer_json, manifest_json,
           manifest_hash, request_hash, risk_tier, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'frozen-for-final-gates', ?)`,
      )
      .run(
        input.candidateInputId,
        input.requestId,
        input.projectId,
        input.runId,
        input.snapshotRevisionId,
        input.nodeRunId,
        input.nodeAttemptId,
        canonicalJson(input.producer),
        canonicalJson(manifest),
        manifestHash,
        requestHash,
        risk.tier,
        now,
      );
    const context = database
      .prepare(
        `SELECT command_id AS commandId, actor_type AS actorType,
                actor_id AS actorId, authenticated_by AS authenticatedBy,
                consumer_id AS consumerId
           FROM runtime_unit_of_work_context WHERE slot = 1`,
      )
      .get() as
      | {
          readonly commandId: string;
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
        }
      | undefined;
    if (context) {
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'delivery.candidate-input.frozen',
                     'delivery-candidate-input', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.candidateInputId,
          input.runId,
          input.nodeRunId,
          canonicalJson({
            deliveryCandidateInputId: input.candidateInputId,
            manifestHash,
            riskTier: risk.tier,
            state: "frozen-for-final-gates",
          }),
          now,
          context.commandId,
          context.actorType,
          context.actorId,
          context.authenticatedBy,
          context.consumerId,
        );
    }
    options.events?.append({
      type: "delivery.candidate-input.frozen",
      scope: {
        companyId: "company",
        projectId: input.projectId,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeAttemptId: input.nodeAttemptId,
        deliveryCandidateInputId: input.candidateInputId,
      },
      payload: {
        deliveryCandidateInputId: input.candidateInputId,
        manifestHash,
        riskTier: risk.tier,
        state: "frozen-for-final-gates",
      },
      timestamp: now,
    });
    return inspect(input.candidateInputId);
  };

  return { freeze, inspect };
};
