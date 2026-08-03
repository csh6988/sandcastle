import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createScriptedExecutionAdapter } from "../adapters/scriptedExecutionAdapter.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";
import type { IntegrationValidationProvider } from "../integration/integrationValidationExecutor.js";
import type {
  DeliveryQualityNodePlan,
  DeliveryQualityNodePlanProvider,
  PlannedDeliveryQualityCommandContext,
} from "../quality/qualityGateNodeHandler.js";
import type { CandidateGateInputView } from "../quality/qualityGateRuntime.js";
import {
  createScriptedReviewerExecutionAdapter,
  ReviewerRecheckOutputSchema,
  type ReviewerExecutionAdapter,
  type ReviewerExecutionInput,
} from "../review/reviewerExecution.js";
import type { CompanyDatabase } from "../storage/sqlite.js";
import type { TestRuntime } from "./testRuntime.js";

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

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const requireSucceeded = <Value>(
  result:
    | { readonly status: "succeeded"; readonly value: Value }
    | {
        readonly status: "rejected";
        readonly error: { readonly code: string; readonly message: string };
      },
): Value => {
  if (result.status === "rejected") {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

export interface IntegrationAuthorityFixtureResult {
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly technicalBaselineId: string;
  readonly technicalBaselineHash: string;
  readonly testNodeRunId: string;
  readonly testNodeAttemptId: string;
  readonly testSessionId: string;
  readonly interactionSessionId: string;
  readonly interactionHumanParticipantId: string;
  readonly testOwnerPositionId: string;
  readonly testOwnerAiMemberId: string;
  readonly gateReview: {
    readonly moderator: {
      readonly aiMemberId: string;
      readonly positionId: string;
      readonly sessionId: string;
    };
    readonly reviewer: {
      readonly aiMemberId: string;
      readonly positionId: string;
      readonly sessionId: string;
      readonly freshSessionId: string;
    };
  };
  readonly workPackageCoverage: readonly {
    readonly workPackageId: string;
    readonly workPackageVersionId: string;
    readonly manifestHash: string;
    readonly riskTier: "low" | "medium" | "high" | "critical";
  }[];
  readonly testExecutionProfile: {
    readonly id: string;
    readonly hash: string;
  };
  readonly build: {
    readonly artifactVersionId: string;
    readonly digest: string;
  };
  readonly deliveryQuality: {
    readonly candidateInputNodeRunId: string;
    readonly candidateInputSessionId: string;
    readonly securityNodeRunId: string;
    readonly operabilityNodeRunId: string;
    readonly candidateNodeRunId: string;
    readonly humanReleaseNodeRunId: string;
    readonly producer: {
      readonly aiMemberId: string;
      readonly positionId: string;
    };
  };
  readonly integrationAuthority: IntegrationGenerationView;
}

export interface IntegrationAuthorityFixtureInput {
  readonly companyDirectory: string;
  readonly companyDirectoryFingerprint: string;
  readonly fixtureId: string;
  readonly repositoryDirectory: string;
  readonly worktreeDirectory: string;
  readonly fakeClock: string;
  readonly repeatableIdSeed: string;
}

export interface IntegrationAuthorityFixturePreparation {
  readonly projectId: string;
  readonly departmentId: string;
  readonly productSessionId: string;
  readonly developerPositionId: string;
  readonly productManagerPositionId: string;
  readonly reviewerPositionId: string;
  readonly freshReviewerPositionId: string;
  readonly testerPositionId: string;
  readonly deliveryCoordinatorPositionId: string;
  readonly producerExecutionProfileId: string;
  readonly isolatedExecutionProfileId: string;
}

export interface ConfirmedFixtureProductAuthority {
  readonly productBaselineId: string;
  readonly productBaselineHash: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
}

export const createIntegrationAuthorityFixtureRuntimeOptions = (
  input: IntegrationAuthorityFixtureInput,
) => {
  const clock = () => new Date(input.fakeClock);

  /** Test-build-only execution adapters for the formal prerequisite flow. */
  const reviewerExecutionAdapter = createScriptedReviewerExecutionAdapter({
    execute: (request) => {
      const manifest = request.manifest as unknown as Record<string, unknown>;
      const integrationGenerationId = manifest.integrationGenerationId;
      const integrationManifestHash = manifest.integrationManifestHash;
      const repositoryCommits = manifest.repositoryCommits;
      const supportingEvidenceRefs = Array.isArray(
        manifest.supportingEvidenceRefs,
      )
        ? manifest.supportingEvidenceRefs.filter(
            (entry): entry is string =>
              typeof entry === "string" &&
              entry.trim() !== "" &&
              entry !== "undefined",
          )
        : [];
      const diffArtifactVersionId = manifest.diffArtifactVersionId;
      const evidenceRefs = [
        ...new Set(
          supportingEvidenceRefs.length > 0
            ? supportingEvidenceRefs
            : typeof integrationGenerationId === "string" &&
                typeof integrationManifestHash === "string" &&
                Array.isArray(repositoryCommits)
              ? [
                  `integration-generation:${integrationGenerationId}`,
                  `integration-manifest:${integrationManifestHash}`,
                  ...repositoryCommits.map((entry) => {
                    const commit = entry as {
                      readonly repositoryId: string;
                      readonly commit: string;
                    };
                    return `repository-commit:${commit.repositoryId}:${commit.commit}`;
                  }),
                ]
              : typeof diffArtifactVersionId === "string" &&
                  diffArtifactVersionId.trim() !== ""
                ? [diffArtifactVersionId]
                : [],
        ),
      ].sort();
      if (evidenceRefs.length === 0) {
        return {
          status: "blocked" as const,
          code: "REVIEWER_OUTPUT_INVALID" as const,
          message:
            "The scripted Reviewer received no authoritative evidence references.",
          evidence: [],
        };
      }
      const candidateGate = manifest.candidateGate as
        | {
            readonly gateInputId?: unknown;
            readonly candidateInputId?: unknown;
            readonly checks?: unknown;
          }
        | undefined;
      const gateExecution = candidateGate
        ? (() => {
            if (
              typeof candidateGate.gateInputId !== "string" ||
              typeof candidateGate.candidateInputId !== "string" ||
              !Array.isArray(candidateGate.checks)
            ) {
              throw new Error(
                "The scripted Reviewer Candidate Gate manifest is invalid.",
              );
            }
            const evidenceRefFor = (kind: string): string => {
              const prefixes =
                kind === "artifact" || kind === "static-analysis"
                  ? ["artifact-version:"]
                  : kind === "runtime-fact"
                    ? ["test-pass-authority:", "integration-pass-authority:"]
                    : kind === "dynamic-analysis"
                      ? ["test-evidence:", "artifact-version:"]
                      : [
                          "test-evidence:",
                          "test-pass-authority:",
                          "integration-pass-authority:",
                          "artifact-version:",
                        ];
              const reference = evidenceRefs.find((entry) =>
                prefixes.some((prefix) => entry.startsWith(prefix)),
              );
              if (!reference) {
                throw new Error(
                  `The scripted Reviewer has no authoritative ${kind} evidence reference.`,
                );
              }
              return reference;
            };
            return {
              schemaVersion: 1 as const,
              gateInputId: candidateGate.gateInputId,
              checks: candidateGate.checks.map((entry) => {
                const check = entry as {
                  readonly id?: unknown;
                  readonly requiredEvidenceKinds?: unknown;
                };
                if (
                  typeof check.id !== "string" ||
                  !Array.isArray(check.requiredEvidenceKinds)
                ) {
                  throw new Error(
                    "The scripted Reviewer Candidate Gate check catalog is invalid.",
                  );
                }
                return {
                  checkId: check.id,
                  status: "passed" as const,
                  evidence: check.requiredEvidenceKinds.map((kind) => {
                    if (typeof kind !== "string") {
                      throw new Error(
                        "The scripted Reviewer Candidate Gate evidence kind is invalid.",
                      );
                    }
                    return { kind, ref: evidenceRefFor(kind) };
                  }),
                  responsibility: {
                    kind: "aggregate" as const,
                    candidateIds: [candidateGate.candidateInputId],
                  },
                };
              }),
              resolutions: [],
            };
          })()
        : undefined;
      return {
        status: "succeeded" as const,
        providerId: "scripted-execution",
        isolation: {
          readOnlyFilesystem: true as const,
          independentGitDatabase: true as const,
          independentSessionStorage: true as const,
          independentCredentialScope: true as const,
          independentMutableCache: true as const,
          inputAllowlist: true as const,
          mechanism: "electron-test-fixture",
          mechanismVersion: "1",
        },
        isolationEvidence: [
          `fixture:${input.fixtureId}`,
          `operation:${request.operationKey}`,
        ],
        terminalExecutionFactId: `${request.operationKey}:terminal`,
        output:
          request.phase === "initial-finding"
            ? {
                findings: [
                  {
                    severity: "info" as const,
                    summary:
                      "The exact frozen Diff was independently reviewed.",
                    rationale:
                      "The scripted test-build Reviewer inspected the allowlisted immutable input.",
                    impact:
                      "No blocking issue was found in the scoped fixture change.",
                    evidenceRefs,
                    suggestedOwner: "fixture-developer",
                    blocking: false,
                  },
                ],
              }
            : ReviewerRecheckOutputSchema.parse({
                result: "PASS",
                conditions: [],
                evidenceRefs,
                ...(gateExecution ? { gateExecution } : {}),
              }),
      };
    },
  });
  const integrationValidationProvider: IntegrationValidationProvider = {
    execute: async (request) => {
      const providerOperationId = `${request.operationKey}:fixture-validation`;
      const evidenceRefs = [`fixture-validation:${request.operationKey}`];
      request.onOperationStarted({
        providerId: "scripted-execution",
        providerOperationId,
        evidenceRefs,
      });
      return {
        status: "completed",
        exitCode: 0,
        providerId: "scripted-execution",
        providerOperationId,
        terminalReceiptHash: sha256(
          canonicalJson({ providerOperationId, evidenceRefs }),
        ),
        evidenceRefs,
        output: "fixture validation passed\n",
      };
    },
    inspect: async () => "not-found",
    cancel: async () => "not-found",
  };
  return {
    clock,
    executionAdapter: createScriptedExecutionAdapter({
      onExecute: async (execution, sink) => {
        const request = execution.request;
        if (
          execution.node.id !== "development" ||
          request?.sideEffectPolicy !== "formal" ||
          !request.immutableContext.workPackage
        ) {
          return { kind: "succeeded" as const };
        }
        const baseCommit = git(input.repositoryDirectory, [
          "rev-parse",
          "HEAD",
        ]);
        const repositoryDirectory = realpathSync(input.repositoryDirectory);
        const fixtureRoot = dirname(repositoryDirectory);
        if (
          dirname(realpathSync(input.companyDirectory)) !== fixtureRoot ||
          dirname(realpathSync(input.worktreeDirectory)) !== fixtureRoot
        ) {
          throw new Error(
            "Electron Test fixture resources must share one temporary fixture root.",
          );
        }
        const workPackage = request.immutableContext.workPackage;
        if (
          realpathSync(workPackage.repositoryReference) !== repositoryDirectory
        ) {
          throw new Error(
            "Fixture execution must use the frozen temporary Repository.",
          );
        }
        if (lstatSync(workPackage.executionTreePath).isSymbolicLink()) {
          throw new Error(
            "Fixture execution tree must be a real non-symlink directory.",
          );
        }
        const executionTreePath = realpathSync(workPackage.executionTreePath);
        const pathWithinFixture = relative(fixtureRoot, executionTreePath);
        if (
          pathWithinFixture === "" ||
          pathWithinFixture === ".." ||
          pathWithinFixture.startsWith(`..${sep}`)
        ) {
          throw new Error(
            "Fixture execution tree must remain inside the temporary fixture root.",
          );
        }
        if (
          git(executionTreePath, ["rev-parse", "HEAD"]) !== baseCommit ||
          git(executionTreePath, ["rev-parse", workPackage.sourceBranch]) !==
            baseCommit
        ) {
          throw new Error(
            "Fixture execution tree must start at the exact allocated base commit.",
          );
        }
        if (
          git(executionTreePath, ["symbolic-ref", "--short", "HEAD"]) !==
          workPackage.sourceBranch
        ) {
          throw new Error(
            "Fixture execution tree must use the frozen private source branch.",
          );
        }
        writeFileSync(
          join(executionTreePath, "fixture-change.txt"),
          `${input.fixtureId}\n`,
        );
        git(executionTreePath, ["add", "fixture-change.txt"]);
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Sandcastle Test Fixture",
            "-c",
            "user.email=fixture@sandcastle.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "test: add reviewed fixture change",
          ],
          {
            cwd: executionTreePath,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: input.fakeClock,
              GIT_COMMITTER_DATE: input.fakeClock,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const resultCommit = git(executionTreePath, ["rev-parse", "HEAD"]);
        if (
          git(executionTreePath, ["rev-parse", workPackage.sourceBranch]) !==
          resultCommit
        ) {
          throw new Error(
            "Fixture execution result must be the exact private source branch tip.",
          );
        }
        if (!sink) {
          throw new Error(
            "Fixture execution requires the Runtime Execution Fact sink.",
          );
        }
        const evidenceRefs = [
          `fixture:${input.fixtureId}`,
          `private-source-tip:${resultCommit}`,
        ];
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: `${request.operationKey}:fixture-completed`,
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: {
            structuredResult: { commits: [{ sha: resultCommit }] },
          },
          evidenceRefs,
        });
        if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
          throw new Error(
            "Fixture terminal Execution Fact was not durably accepted.",
          );
        }
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded" as const,
          evidenceRefs,
        };
      },
    }),
    reviewerExecutionAdapter,
    integrationValidationProvider,
  };
};

export const createIntegrationAuthorityFixtureDeliveryQualityPlans = (input: {
  readonly fixtureId: string;
  readonly database: CompanyDatabase;
  readonly seeded: IntegrationAuthorityFixtureResult;
  readonly tests: Pick<TestRuntime, "downstreamAuthority">;
  readonly reviewerExecutionAdapter: ReviewerExecutionAdapter;
  readonly executableHash: string;
}): DeliveryQualityNodePlanProvider => ({
  plan: ({ runId, nodeRunId, attempt }) => {
    const run = input.database.pipelineRuntime.inspectRun(runId);
    const node = run.nodes.find((candidate) => candidate.id === nodeRunId);
    const handlerKindId = run.snapshot.payload.pipelineVersion.handlers?.find(
      (handler) => handler.nodeId === node?.pipelineNodeId,
    )?.handlerKindId;
    if (!node || !handlerKindId) {
      throw new Error(`Fixture Delivery quality Node ${nodeRunId} is invalid.`);
    }
    const testRunId = `test:${runId}:${input.seeded.testNodeRunId}`;
    const candidateInputId = `${input.fixtureId}:delivery-candidate-input`;
    if (handlerKindId === "delivery-candidate-input@1") {
      const testAuthority = input.tests.downstreamAuthority(testRunId);
      return {
        handlerKindId,
        initialCommands: [
          {
            commandId: `${input.fixtureId}:candidate-input-freeze`,
            command: {
              type: "delivery.candidate-input.freeze",
              candidateInputId,
              requestId: `${input.fixtureId}:delivery-candidate-input-request`,
              projectId: input.seeded.projectId,
              runId,
              snapshotRevisionId: attempt.snapshotRevisionId,
              nodeRunId,
              nodeAttemptId: attempt.attemptId,
              producer: {
                ...input.seeded.deliveryQuality.producer,
                sessionId: input.seeded.deliveryQuality.candidateInputSessionId,
              },
              requiredTestRunIds: [testRunId],
              environment: {
                platform: process.platform,
                architecture: process.arch,
                electronVersion: process.versions.electron ?? process.version,
                executableHash: input.executableHash,
                capabilityProfileHash: sha256(
                  canonicalJson(testAuthority.capabilities),
                ),
              },
              evidencePolicy: {
                revisionId: "electron-test-fixture-evidence@1",
                redactionProfile: "fixture-redacted",
                retentionClass: "durable",
                maxItemBytes: 20 * 1024 * 1024,
                maxTotalBytes: 40 * 1024 * 1024,
              },
            },
          },
        ],
      };
    }
    if (
      handlerKindId === "security-review@1" ||
      handlerKindId === "operability-review@1"
    ) {
      const kind =
        handlerKindId === "security-review@1" ? "security" : "operability";
      const candidate =
        input.database.candidateInputs.inspect(candidateInputId);
      const topicId = `${input.fixtureId}:${kind}-review-topic`;
      const ownerParticipantId = `${topicId}:owner`;
      const reviewerParticipantId = `${topicId}:reviewer`;
      const gateInputId = `${input.fixtureId}:${kind}-gate-input`;
      const gateResultId = `${input.fixtureId}:${kind}-gate-result`;
      const executionId = `${input.fixtureId}:${kind}-gate-execution`;
      const acceptanceCriteria = [
        ...new Set(
          candidate.manifest.integration.manifest.packages.flatMap(
            (entry) => entry.reviewContext.acceptanceCriteria,
          ),
        ),
      ].sort();
      const excludedContext: Array<
        | "hidden-prompts"
        | "prior-reviewer-opinions"
        | "private-transcripts"
        | "provider-session-history"
        | "credential-values"
      > = [
        "hidden-prompts",
        "prior-reviewer-opinions",
        "private-transcripts",
        "provider-session-history",
        "credential-values",
      ];
      const topicManifest = {
        topicId,
        supportingArtifactVersionIds: candidate.manifest.artifacts.map(
          (entry) => entry.id,
        ),
        supportingSpecRevisionIds: [
          candidate.manifest.product.projectSpecRevisionId,
          ...candidate.manifest.technical.applicationSpecRevisions.map(
            (entry) => entry.id,
          ),
        ],
        harnessSnapshotIds: candidate.manifest.tests.map(
          (entry) => entry.fixture.id,
        ),
        acceptanceCriteria,
        excludedContext,
        scope: "verification" as const,
        verificationSubject: {
          kind: "candidate-final" as const,
          deliveryCandidateInputId: candidate.id,
          deliveryCandidateInputHash: candidate.manifestHash,
        },
        evidenceIds: candidate.manifest.evidence.map((entry) => entry.id),
      };
      const reviewer = input.seeded.gateReview.reviewer;
      const prepareCommandId = `${input.fixtureId}:${kind}-gate-input-prepare`;
      const initialCommands: DeliveryQualityNodePlan["initialCommands"] = [
        {
          commandId: `${input.fixtureId}:${kind}-review-topic-create`,
          expectedRevision: 0,
          command: {
            type: "review.topic.create" as const,
            topicId,
            projectId: input.seeded.projectId,
            runId,
            title: `${kind} review for the frozen Delivery Candidate Input`,
            manifest: topicManifest,
            producer: candidate.manifest.producer,
            participants: [
              {
                id: ownerParticipantId,
                role: "owner-participant" as const,
                ...candidate.manifest.producer,
              },
              {
                id: `${topicId}:moderator`,
                role: "moderator" as const,
                ...input.seeded.gateReview.moderator,
              },
              {
                id: reviewerParticipantId,
                role: "reviewer-participant" as const,
                aiMemberId: reviewer.aiMemberId,
                positionId: reviewer.positionId,
                sessionId: reviewer.sessionId,
              },
            ],
            quorum: 1,
            budget: {
              maxRounds: 1,
              maxDurationSeconds: 60,
              maxTokens: 0,
              maxCostCents: 0,
            },
            stopCondition: "blocking-findings-dispositioned",
            escalationPolicy: "fail-with-evidence",
          },
        },
        {
          commandId: prepareCommandId,
          command: {
            type: "quality-gate.input.prepare" as const,
            gateInputId,
            requestId: `${input.fixtureId}:${kind}-gate-input-request`,
            kind,
            candidateInputId: candidate.id,
            expectedCandidateInputHash: candidate.manifestHash,
            expectedRiskTier: candidate.manifest.risk.tier,
            nodeRunId,
            nodeAttemptId: attempt.attemptId,
            reviewTopicId: topicId,
            reviewerParticipantId,
          },
        },
        (context) => {
          const gateInput = context.result(prepareCommandId)
            .value as CandidateGateInputView;
          return {
            commandId: `${input.fixtureId}:${kind}-review-revision`,
            expectedRevision: 1,
            actor: {
              type: "runtime-worker",
              id: candidate.manifest.producer.aiMemberId,
              authenticatedBy: "runtime",
            },
            command: {
              type: "review.revision.submit" as const,
              topicId,
              revisionId: `${topicId}:revision`,
              ownerParticipantId,
              subjectKind: `${kind}-gate-input`,
              subjectId: gateInput.id,
              subjectHash: gateInput.manifestHash,
              producerAiMemberId: candidate.manifest.producer.aiMemberId,
              producerPositionId: candidate.manifest.producer.positionId,
              producerSessionId: candidate.manifest.producer.sessionId,
              evidenceRefs: [...gateInput.manifest.supportingEvidenceRefs],
            },
          };
        },
      ];
      const reviewRequest = (
        context: PlannedDeliveryQualityCommandContext,
      ): ReviewerExecutionInput => {
        const gateInput = context.result(prepareCommandId)
          .value as CandidateGateInputView;
        return {
          operationKey: attempt.operationKey,
          phase: "fresh-recheck",
          manifest: {
            ...topicManifest,
            deliveryCandidateInputId: candidate.id,
            supportingEvidenceRefs: gateInput.manifest.supportingEvidenceRefs,
            candidateGate: {
              gateInputId: gateInput.id,
              candidateInputId: candidate.id,
              checks: gateInput.manifest.checkCatalog.checks.map((check) => ({
                id: check.id,
                requiredEvidenceKinds: [...check.requiredEvidenceKinds],
              })),
            },
          } as unknown as ReviewerExecutionInput["manifest"],
          workspaceRef: input.seeded.projectId,
          reviewNodeRunId: nodeRunId,
          reviewer: {
            participantId: reviewerParticipantId,
            aiMemberId: reviewer.aiMemberId,
            positionId: reviewer.positionId,
            sessionId: reviewer.freshSessionId,
          },
          executionProfile: {
            agentAdapterId: "scripted-execution",
            model: "fixture-v1",
            sandboxRef: "docker",
            secretReferenceIds: [],
            timeoutSeconds: 30,
            maxIterations: 1,
          },
          findings: [],
          revision: {
            id: `${topicId}:revision`,
            subjectId: gateInput.id,
            subjectHash: gateInput.manifestHash,
          },
        };
      };
      return {
        handlerKindId,
        initialCommands,
        review: {
          reviewerSessionId: reviewer.freshSessionId,
          reviewerAiMemberId: reviewer.aiMemberId,
          reconcileExisting: false,
          timeoutSeconds: 30,
          request: reviewRequest,
          adapter: input.reviewerExecutionAdapter,
          terminalCommands: (reviewerResult, context) => {
            const gateInput = context.result(prepareCommandId)
              .value as CandidateGateInputView;
            const reviewerOutput = ReviewerRecheckOutputSchema.parse(
              reviewerResult.output,
            );
            const gateExecution = reviewerOutput.gateExecution;
            const terminalExecutionFactId =
              reviewerResult.terminalExecutionFactId;
            const expectedCheckIds = gateInput.manifest.checkCatalog.checks
              .map((check) => check.id)
              .sort();
            const actualCheckIds = gateExecution?.checks
              .map((check) => check.checkId)
              .sort();
            if (
              !gateExecution ||
              !terminalExecutionFactId ||
              reviewerOutput.result !== "PASS" ||
              gateExecution.gateInputId !== gateInput.id ||
              actualCheckIds?.join("\0") !== expectedCheckIds.join("\0") ||
              gateExecution.checks.some(
                (check) =>
                  check.status !== "passed" ||
                  check.responsibility.candidateIds[0] !== candidate.id,
              )
            ) {
              throw new Error(
                `${kind} Reviewer terminal result requires an unconditional PASS with every Candidate Gate check passed and exact Candidate Gate execution observations.`,
              );
            }
            const gateReceiptHash = sha256(
              canonicalJson({
                schemaVersion: 1,
                terminalExecutionFactId,
                gateExecution,
              }),
            );
            return [
              {
                commandId: `${input.fixtureId}:${kind}-review-pass`,
                expectedRevision: 2,
                actor: {
                  type: "runtime-worker",
                  id: reviewer.aiMemberId,
                  authenticatedBy: "runtime",
                },
                command: {
                  type: "review.recheck.submit",
                  topicId,
                  recheckId: `${topicId}:recheck`,
                  revisionId: `${topicId}:revision`,
                  reviewerParticipantId,
                  reviewerSessionId: reviewer.freshSessionId,
                  result: "PASS",
                  conditions: [],
                  evidenceRefs: [...reviewerOutput.evidenceRefs],
                },
              },
              {
                commandId: `${input.fixtureId}:${kind}-gate-execution-accept`,
                command: {
                  type: "quality-gate.execution.accept",
                  executionId,
                  gateInputId: gateInput.id,
                  operationKey: `${input.fixtureId}:${kind}:gate-review`,
                  request: {
                    schemaVersion: 1,
                    gateInputId: gateInput.id,
                    gateInputHash: gateInput.manifestHash,
                    reviewerTerminalExecutionFactId: terminalExecutionFactId,
                  },
                },
              },
              {
                commandId: `${input.fixtureId}:${kind}-gate-execution-reconcile`,
                command: {
                  type: "quality-gate.execution.reconcile",
                  executionId,
                  observation: {
                    state: "succeeded",
                    fact: gateExecution,
                    receiptHash: gateReceiptHash,
                  },
                },
              },
              {
                commandId: `${input.fixtureId}:${kind}-gate-result-finalize`,
                command: {
                  type: "quality-gate.result.finalize",
                  candidateGateResultId: gateResultId,
                  gateInputId: gateInput.id,
                  executionId,
                  qualityGateResultId: `quality-gate-${topicId}`,
                },
              },
            ];
          },
        },
        ...(kind === "operability"
          ? {
              afterPassCommands: [
                {
                  commandId: `${input.fixtureId}:candidate-input-authorize`,
                  command: {
                    type: "delivery.candidate-input.authorize" as const,
                    authorityId: `${input.fixtureId}:candidate-input-authority`,
                    candidateInputId: candidate.id,
                    expectedCandidateInputHash: candidate.manifestHash,
                    securityGateResultId: `${input.fixtureId}:security-gate-result`,
                    operabilityGateResultId: gateResultId,
                  },
                },
              ],
            }
          : {}),
      };
    }
    if (handlerKindId === "delivery-candidate@1") {
      const candidate =
        input.database.candidateInputs.inspect(candidateInputId);
      const authority = input.database.qualityGates.view(
        candidate.id,
      ).authority;
      if (!authority) {
        throw new Error(
          "Fixture Candidate Input has no exact dual-PASS authority.",
        );
      }
      return {
        handlerKindId,
        initialCommands: [
          {
            commandId: `${input.fixtureId}:delivery-candidate-assemble`,
            command: {
              type: "delivery.candidate.assemble",
              candidateId: `${input.fixtureId}:delivery-candidate`,
              requestId: `${input.fixtureId}:delivery-candidate-request`,
              candidateInputId: candidate.id,
              expectedCandidateInputHash: candidate.manifestHash,
              expectedGateAuthorityHash: authority.authorityHash,
              nodeRunId,
              nodeAttemptId: attempt.attemptId,
              leaseId: attempt.leaseId,
              workerId: "delivery-quality-node-handler",
            },
          },
        ],
      };
    }
    throw new Error(
      `Fixture Delivery quality plan for ${handlerKindId} is unavailable.`,
    );
  },
});

export const createIntegrationAuthorityFixturePreparation = (
  input: IntegrationAuthorityFixtureInput & {
    readonly database: CompanyDatabase;
  },
): IntegrationAuthorityFixturePreparation => {
  const database = input.database;
  const project = database.catalog.createProject({
    name: "Electron Test Fixture",
    goal: "Verify the real Product-to-Candidate authority chain.",
  });
  database.projectConfiguration.update({
    projectId: project.id,
    expectedRevision: 0,
    name: project.name,
    goal: project.goal,
    sharedContext:
      "One temporary Repository produces one reviewed source commit.",
    repositoryReferences: [input.repositoryDirectory],
  });
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:application-register`,
      actor: {
        type: "human",
        id: "electron-test-fixture",
        authenticatedBy: "local-session",
      },
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "application.register",
        applicationId: `${input.fixtureId}:application`,
        projectId: project.id,
        repositoryReference: input.repositoryDirectory,
        applicationKey: "fixture",
        ownership: "software-rnd",
        buildCommand: "fixture-build",
        testCommand: "fixture-test",
      },
    }),
  );
  const department = database.catalog.createDepartment({
    name: "Electron Test Quality",
  });
  const createPosition = (name: string, focus: string) => {
    const before = database.catalog.inspectDepartment(department.id);
    const after = database.catalog.createPosition({
      departmentId: department.id,
      name,
      responsibility: `${name} responsibility for the scoped fixture.`,
      aiMemberDisplayName: `${name} Member`,
      aiMemberProfile: `${name} deterministic test-build participant.`,
      aiMemberResponsibilityMetadata: { focus },
    });
    return after.positions.find(
      (position) =>
        !before.positions.some((candidate) => candidate.id === position.id),
    )!;
  };
  const developer = createPosition("Fixture Developer", "development");
  const productManager = createPosition(
    "Fixture Product Manager",
    "product-management",
  );
  const reviewer = createPosition("Fixture Reviewer", "review");
  const freshReviewer = createPosition("Fixture Fresh Reviewer", "review");
  const tester = createPosition("Fixture Test Engineer", "test");
  const deliveryCoordinator = createPosition(
    "Fixture Delivery Coordinator",
    "delivery-coordination",
  );
  const producerProfile = database.catalog
    .saveExecutionProfile({
      departmentId: department.id,
      expectedRevision: 0,
      name: "Fixture producer execution",
      providerRef: "scripted-execution",
      model: "fixture-v1",
      sandboxRef: "docker",
      branchStrategy: "branch",
      timeoutSeconds: 30,
      maxIterations: 1,
      maxTokens: null,
      retryMaxAttempts: 0,
      permissionPolicy: "deny",
      secretReferenceIds: [],
    })
    .executionProfiles.find(
      (candidate) => candidate.name === "Fixture producer execution",
    )!;
  const profile = database.catalog
    .saveExecutionProfile({
      departmentId: department.id,
      expectedRevision: 0,
      name: "Fixture isolated execution",
      providerRef: "scripted-execution",
      model: "fixture-v1",
      sandboxRef: "docker",
      branchStrategy: "branch",
      timeoutSeconds: 30,
      maxIterations: 1,
      maxTokens: null,
      retryMaxAttempts: 0,
      permissionPolicy: "deny",
      secretReferenceIds: [],
    })
    .executionProfiles.find(
      (candidate) => candidate.name === "Fixture isolated execution",
    )!;
  database.catalog.updateDepartment({
    departmentId: department.id,
    expectedRevision: 0,
    name: department.name,
    description: "Scoped exact-authority Electron Test fixture.",
    inputArtifactContracts: [],
    outputArtifactContracts: [],
    defaultExecutionProfileId: profile.id,
  });
  const graph = {
    nodes: [
      {
        id: "start",
        type: "start" as const,
        name: "Start",
        handlerKindId: "run-start@1",
      },
      {
        id: "development",
        type: "ai-task" as const,
        name: "Development",
        positionId: developer.id,
        executionProfileId: producerProfile.id,
        handlerKindId: "development@1",
      },
      {
        id: "review",
        type: "ai-task" as const,
        name: "Code Review",
        positionId: reviewer.id,
        executionProfileId: profile.id,
        handlerKindId: "code-review@1",
      },
      {
        id: "integration",
        type: "ai-task" as const,
        name: "Integration",
        positionId: freshReviewer.id,
        executionProfileId: profile.id,
        handlerKindId: "integration@1",
      },
      {
        id: "test",
        type: "ai-task" as const,
        name: "Test",
        positionId: tester.id,
        executionProfileId: profile.id,
        handlerKindId: "test@1",
      },
      {
        id: "candidate-input",
        type: "ai-task" as const,
        name: "Candidate Input",
        positionId: deliveryCoordinator.id,
        executionProfileId: profile.id,
        handlerKindId: "delivery-candidate-input@1",
      },
      {
        id: "security",
        type: "ai-task" as const,
        name: "Security Review",
        positionId: reviewer.id,
        executionProfileId: profile.id,
        handlerKindId: "security-review@1",
      },
      {
        id: "operability",
        type: "ai-task" as const,
        name: "Operability Review",
        positionId: freshReviewer.id,
        executionProfileId: profile.id,
        handlerKindId: "operability-review@1",
      },
      {
        id: "candidate",
        type: "ai-task" as const,
        name: "Delivery Candidate",
        positionId: deliveryCoordinator.id,
        executionProfileId: profile.id,
        handlerKindId: "delivery-candidate@1",
      },
      {
        id: "human-release",
        type: "human-approval" as const,
        name: "Human Release",
        positionId: deliveryCoordinator.id,
        handlerKindId: "human-release@1",
      },
      {
        id: "complete",
        type: "complete" as const,
        name: "Complete",
        handlerKindId: "run-complete@1",
      },
    ],
    edges: [
      { from: "start", to: "development" },
      { from: "development", to: "review" },
      { from: "review", to: "integration" },
      { from: "integration", to: "test" },
      { from: "test", to: "candidate-input" },
      { from: "candidate-input", to: "security" },
      { from: "security", to: "operability" },
      { from: "operability", to: "candidate" },
      { from: "candidate", to: "human-release" },
      { from: "human-release", to: "complete" },
    ],
  };
  const draft = database.pipelineConfiguration.saveDraft({
    departmentId: department.id,
    expectedRevision: 0,
    graph,
  });
  database.pipelineConfiguration.publish({
    departmentId: department.id,
    expectedRevision: draft.draft.revision,
  });
  const productSession = database.interaction.createSession({
    projectId: project.id,
    mode: "consultation",
  });
  database.interaction.addParticipant({
    sessionId: productSession.id,
    participantType: "ai-member",
    participantRef: productManager.aiMember.id,
    role: "product-manager",
  });
  return {
    projectId: project.id,
    departmentId: department.id,
    productSessionId: productSession.id,
    developerPositionId: developer.id,
    productManagerPositionId: productManager.id,
    reviewerPositionId: reviewer.id,
    freshReviewerPositionId: freshReviewer.id,
    testerPositionId: tester.id,
    deliveryCoordinatorPositionId: deliveryCoordinator.id,
    producerExecutionProfileId: producerProfile.id,
    isolatedExecutionProfileId: profile.id,
  };
};

/**
 * Test-build-only setup seam. It uses the already-open Company Runtime
 * database so the fixture never becomes a second database owner.
 */
export const createIntegrationAuthorityFixture = async (
  input: IntegrationAuthorityFixtureInput & {
    readonly database: CompanyDatabase;
    readonly preparation?: IntegrationAuthorityFixturePreparation;
    readonly confirmedProduct?: ConfirmedFixtureProductAuthority;
  },
): Promise<IntegrationAuthorityFixtureResult> => {
  const database = input.database;
  const baseCommit = git(input.repositoryDirectory, ["rev-parse", "HEAD"]);
  const preparation =
    input.preparation ??
    createIntegrationAuthorityFixturePreparation({ ...input, database });
  const project = { id: preparation.projectId };
  const department = database.catalog.inspectDepartment(
    preparation.departmentId,
  );
  const position = (id: string) => {
    const found = department.positions.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Fixture Position ${id} is unavailable.`);
    return found;
  };
  const developer = position(preparation.developerPositionId);
  const productManager = position(preparation.productManagerPositionId);
  const reviewer = position(preparation.reviewerPositionId);
  const freshReviewer = position(preparation.freshReviewerPositionId);
  const tester = position(preparation.testerPositionId);
  const deliveryCoordinator = position(
    preparation.deliveryCoordinatorPositionId,
  );
  const standardPositions =
    database.catalog.inspectDepartment("software-rnd").positions;
  const softwareArchitect = standardPositions.find(
    (position) => position.id === "software-architect",
  );
  const standardDeliveryCoordinator = standardPositions.find(
    (position) => position.id === "delivery-coordinator",
  );
  if (!softwareArchitect || !standardDeliveryCoordinator) {
    throw new Error(
      "Fixture requires the built-in Software architect and Delivery coordinator positions.",
    );
  }
  const departmentProfiles = database.catalog.inspectDepartment(department.id);
  const producerProfile = departmentProfiles.executionProfiles.find(
    (candidate) => candidate.id === preparation.producerExecutionProfileId,
  );
  const profile = departmentProfiles.executionProfiles.find(
    (candidate) => candidate.id === preparation.isolatedExecutionProfileId,
  );
  if (!producerProfile || !profile) {
    throw new Error("Fixture Execution Profiles are unavailable.");
  }
  let productSession = database.interaction.inspectSession(
    preparation.productSessionId,
  ).session;

  const humanActor = {
    type: "human" as const,
    id: "electron-test-fixture",
    authenticatedBy: "local-session" as const,
  };
  const runtimeActor = (aiMemberId: string) => ({
    type: "runtime-worker" as const,
    id: aiMemberId,
    authenticatedBy: "runtime" as const,
  });
  const createConsultation = (
    position: typeof developer,
    role: string,
  ): string => {
    const session = database.interaction.createSession({
      projectId: project.id,
      mode: "consultation",
    });
    database.interaction.addParticipant({
      sessionId: session.id,
      participantType: "ai-member",
      participantRef: position.aiMember.id,
      role,
    });
    return session.id;
  };
  const productBaseline = (() => {
    if (input.confirmedProduct) {
      const discovery = database.product.inspect(project.id);
      const exact = discovery.baselines.find(
        (baseline) =>
          baseline.id === input.confirmedProduct!.productBaselineId &&
          baseline.hash === input.confirmedProduct!.productBaselineHash &&
          baseline.runId === input.confirmedProduct!.runId &&
          baseline.snapshotRevisionId ===
            input.confirmedProduct!.snapshotRevisionId,
      );
      if (!exact) {
        throw new Error(
          "Renderer-confirmed Product authority does not match the authoritative Runtime view.",
        );
      }
      const run = database.pipelineRuntime.inspectRun(exact.runId);
      if (
        run.run.projectId !== project.id ||
        run.run.departmentId !== department.id ||
        run.snapshot.id !== exact.snapshotRevisionId ||
        run.snapshot.revision !== 1 ||
        run.snapshot.payload.productBaseline?.id !== exact.id ||
        run.snapshot.payload.productBaseline?.hash !== exact.hash
      ) {
        throw new Error(
          `Renderer-confirmed Product Baseline did not atomically create the exact formal Run and r1: ${JSON.stringify(
            {
              expected: {
                projectId: project.id,
                departmentId: department.id,
                snapshotRevisionId: exact.snapshotRevisionId,
                baselineId: exact.id,
                baselineHash: exact.hash,
              },
              actual: {
                projectId: run.run.projectId,
                departmentId: run.run.departmentId,
                snapshotRevisionId: run.snapshot.id,
                snapshotRevision: run.snapshot.revision,
                baseline: run.snapshot.payload.productBaseline,
              },
            },
          )}`,
        );
      }
      return exact;
    }
    const formalProductProposal = requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:product-proposal-revise`,
        actor: humanActor,
        consumerId: "electron-test-fixture-setup",
        expectedRevision: 0,
        command: {
          type: "product.proposal.revise",
          projectId: project.id,
          producerSessionId: productSession.id,
          content: {
            goal: "Verify one exact reviewed temporary Repository change.",
            users: ["Electron Test fixture"],
            scope: ["Versioned Test authority"],
            nonGoals: ["Release Candidate creation"],
            acceptanceCriteria: [
              "The exact frozen Diff is independently reviewed.",
            ],
            constraints: ["Use only the temporary fixture Repository."],
            risks: ["Fixture evidence must not escape its temporary root."],
            openQuestions: [],
          },
        },
      }),
    );
    if (!formalProductProposal.proposal) {
      throw new Error("Formal Product Proposal Command produced no proposal.");
    }
    const awaitingProductConfirmation = requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:product-proposal-awaiting`,
        actor: humanActor,
        consumerId: "electron-test-fixture-setup",
        expectedRevision: formalProductProposal.proposal.revision,
        command: {
          type: "product.proposal.mark-awaiting-confirmation",
          projectId: project.id,
          proposalRevisionId: formalProductProposal.proposal.currentRevision.id,
          proposalHash: formalProductProposal.proposal.currentRevision.hash,
        },
      }),
    );
    const confirmed = requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:product-baseline-confirm`,
        actor: humanActor,
        consumerId: "electron-test-fixture-setup",
        expectedRevision: awaitingProductConfirmation.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: project.id,
          departmentId: department.id,
          proposalRevisionId:
            awaitingProductConfirmation.proposal!.currentRevision.id,
          proposalHash:
            awaitingProductConfirmation.proposal!.currentRevision.hash,
        },
      }),
    );
    const baseline = confirmed.baselines[0];
    if (!baseline) {
      throw new Error("Formal Product confirmation produced no baseline.");
    }
    return baseline;
  })();
  if (productSession.status !== "active") {
    productSession = database.interaction.createSession({
      projectId: project.id,
      mode: "consultation",
    });
    database.interaction.addParticipant({
      sessionId: productSession.id,
      participantType: "ai-member",
      participantRef: productManager.aiMember.id,
      role: "product-manager",
    });
  }
  const projectSpecResult = requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:project-spec-revise`,
      actor: runtimeActor(productManager.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "project-spec.revise",
        runId: productBaseline.runId,
        producerSessionId: productSession.id,
        content: {
          outcome:
            "Produce exact T15 and T16 authority for one temporary Repository.",
          acceptanceCriteria: [
            "The exact frozen Diff is independently reviewed.",
          ],
          applicationBoundaries: [`${input.fixtureId}:application`],
          crossApplicationContracts: [],
          deliveryConstraints: [
            "Do not access credentials or a user Repository.",
          ],
        },
      },
    }),
  );
  const projectSpecRevision = projectSpecResult.specRevisions[0];
  if (!projectSpecRevision) {
    throw new Error("Formal Project Spec Command produced no revision.");
  }
  const productModeratorSession = createConsultation(tester, "moderator");
  const productReviewerSession = createConsultation(
    reviewer,
    "reviewer-participant",
  );
  const productFreshSession = createConsultation(
    freshReviewer,
    "reviewer-participant",
  );
  const productTopicId = `${input.fixtureId}:product-review-topic`;
  const productParticipants = {
    owner: `${productTopicId}:owner`,
    moderator: `${productTopicId}:moderator`,
    reviewer: `${productTopicId}:reviewer`,
    fresh: `${productTopicId}:fresh`,
  };
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:product-review-start`,
      actor: runtimeActor(productManager.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 1,
      command: {
        type: "product-review.start",
        runId: productBaseline.runId,
        topicId: productTopicId,
        projectSpecRevisionId: projectSpecRevision.id,
        projectSpecHash: projectSpecRevision.hash,
        participants: [
          {
            id: productParticipants.owner,
            role: "owner-participant",
            aiMemberId: productManager.aiMember.id,
            positionId: productManager.id,
            sessionId: productSession.id,
          },
          {
            id: productParticipants.moderator,
            role: "moderator",
            aiMemberId: tester.aiMember.id,
            positionId: tester.id,
            sessionId: productModeratorSession,
          },
          {
            id: productParticipants.reviewer,
            role: "reviewer-participant",
            aiMemberId: reviewer.aiMember.id,
            positionId: reviewer.id,
            sessionId: productReviewerSession,
          },
          {
            id: productParticipants.fresh,
            role: "reviewer-participant",
            aiMemberId: freshReviewer.aiMember.id,
            positionId: freshReviewer.id,
            sessionId: productFreshSession,
          },
        ],
        budget: {
          maxRounds: 2,
          maxDurationSeconds: 60,
          maxTokens: 1_000,
          maxCostCents: 0,
        },
      },
    }),
  );
  const productReviewRevisionId = `${productTopicId}:revision`;
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:product-review-revision`,
      actor: runtimeActor(productManager.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 1,
      command: {
        type: "review.revision.submit",
        topicId: productTopicId,
        revisionId: productReviewRevisionId,
        ownerParticipantId: productParticipants.owner,
        subjectKind: "project-spec",
        subjectId: projectSpecRevision.id,
        subjectHash: projectSpecRevision.hash,
        producerAiMemberId: productManager.aiMember.id,
        producerPositionId: productManager.id,
        producerSessionId: productSession.id,
        evidenceRefs: ["fixture:project-spec-ready"],
      },
    }),
  );
  for (const [suffix, position, participantId, sessionId, revision] of [
    [
      "primary",
      reviewer,
      productParticipants.reviewer,
      createConsultation(reviewer, "reviewer"),
      2,
    ],
    [
      "fresh",
      freshReviewer,
      productParticipants.fresh,
      createConsultation(freshReviewer, "reviewer"),
      3,
    ],
  ] as const) {
    requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:product-review-pass-${suffix}`,
        actor: runtimeActor(position.aiMember.id),
        consumerId: "electron-test-fixture-setup",
        expectedRevision: revision,
        command: {
          type: "review.recheck.submit",
          topicId: productTopicId,
          recheckId: `${productTopicId}:recheck:${suffix}`,
          revisionId: productReviewRevisionId,
          reviewerParticipantId: participantId,
          reviewerSessionId: sessionId,
          result: "PASS",
          conditions: [],
          evidenceRefs: [`fixture:product-review:${suffix}`],
        },
      }),
    );
  }
  const readinessId = `${input.fixtureId}:product-readiness`;
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:product-readiness-record`,
      actor: runtimeActor(productManager.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "product-readiness.record",
        runId: productBaseline.runId,
        evidenceId: readinessId,
        projectSpecRevisionId: projectSpecRevision.id,
        projectSpecHash: projectSpecRevision.hash,
        producerSessionId: productSession.id,
        checkKey: "fixture-repository",
        status: "ready",
        summary: "The temporary Repository and scoped fixture are ready.",
        evidenceRefs: ["fixture:repository-ready"],
      },
    }),
  );
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:product-gate-promote`,
      actor: runtimeActor(productManager.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 1,
      command: {
        type: "product-gate.promote",
        runId: productBaseline.runId,
        topicId: productTopicId,
        projectSpecRevisionId: projectSpecRevision.id,
        projectSpecHash: projectSpecRevision.hash,
        readinessEvidenceIds: [readinessId],
      },
    }),
  );
  const architectureSession = createConsultation(
    softwareArchitect,
    "architect",
  );
  const applicationSpecResult = requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:application-spec-revise`,
      actor: runtimeActor(softwareArchitect.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "application-spec.revise",
        runId: productBaseline.runId,
        applicationId: `${input.fixtureId}:application`,
        promotedProjectSpecRevisionId: projectSpecRevision.id,
        promotedProjectSpecHash: projectSpecRevision.hash,
        producerSessionId: architectureSession,
        content: {
          design: "Apply one temporary Repository change.",
          acceptanceCriteria: [
            "The exact frozen Diff is independently reviewed.",
          ],
          workPackageConstraints: ["Use one development@1 Node Run."],
          integrationObligations: ["Run the scoped fixture validation."],
          contractRefs: [],
        },
      },
    }),
  );
  const applicationSpecRevision =
    applicationSpecResult.applicationSpecRevisions[0];
  if (!applicationSpecRevision) {
    throw new Error("Formal Application Spec Command produced no revision.");
  }
  const technicalProposalResult = requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:technical-proposal-revise`,
      actor: runtimeActor(softwareArchitect.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "technical-baseline-proposal.revise",
        runId: productBaseline.runId,
        producerSessionId: architectureSession,
        applicationSpecRevisions: [
          {
            id: applicationSpecRevision.id,
            hash: applicationSpecRevision.hash,
          },
        ],
        content: {
          architecture: "One temporary Application and Repository.",
          dependencyGraph: [],
          contracts: [],
          riskPolicy: ["No credentials or user Repository access."],
          permissionPolicy: ["Deny external access."],
          testStrategy: ["Run scoped Code Review and Integration."],
        },
      },
    }),
  );
  const technicalProposal =
    technicalProposalResult.technicalBaselineProposals[0];
  if (!technicalProposal) {
    throw new Error("Formal Technical Proposal Command produced no revision.");
  }
  const technicalModeratorSession = createConsultation(tester, "moderator");
  const technicalReviewerSession = createConsultation(
    reviewer,
    "reviewer-participant",
  );
  const technicalFreshSession = createConsultation(
    freshReviewer,
    "reviewer-participant",
  );
  const technicalTopicId = `${input.fixtureId}:technical-review-topic`;
  const technicalParticipants = {
    owner: `${technicalTopicId}:owner`,
    moderator: `${technicalTopicId}:moderator`,
    reviewer: `${technicalTopicId}:reviewer`,
    fresh: `${technicalTopicId}:fresh`,
  };
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:technical-review-start`,
      actor: runtimeActor(softwareArchitect.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: technicalProposal.revision,
      command: {
        type: "technical-review.start",
        runId: productBaseline.runId,
        topicId: technicalTopicId,
        technicalBaselineProposalId: technicalProposal.id,
        technicalBaselineProposalHash: technicalProposal.hash,
        participants: [
          {
            id: technicalParticipants.owner,
            role: "owner-participant",
            aiMemberId: softwareArchitect.aiMember.id,
            positionId: softwareArchitect.id,
            sessionId: architectureSession,
          },
          {
            id: technicalParticipants.moderator,
            role: "moderator",
            aiMemberId: tester.aiMember.id,
            positionId: tester.id,
            sessionId: technicalModeratorSession,
          },
          {
            id: technicalParticipants.reviewer,
            role: "reviewer-participant",
            aiMemberId: reviewer.aiMember.id,
            positionId: reviewer.id,
            sessionId: technicalReviewerSession,
          },
          {
            id: technicalParticipants.fresh,
            role: "reviewer-participant",
            aiMemberId: freshReviewer.aiMember.id,
            positionId: freshReviewer.id,
            sessionId: technicalFreshSession,
          },
        ],
        budget: {
          maxRounds: 2,
          maxDurationSeconds: 60,
          maxTokens: 1_000,
          maxCostCents: 0,
        },
      },
    }),
  );
  const technicalReviewRevisionId = `${technicalTopicId}:revision`;
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:technical-review-revision`,
      actor: runtimeActor(softwareArchitect.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 1,
      command: {
        type: "review.revision.submit",
        topicId: technicalTopicId,
        revisionId: technicalReviewRevisionId,
        ownerParticipantId: technicalParticipants.owner,
        subjectKind: "technical-baseline-proposal",
        subjectId: technicalProposal.id,
        subjectHash: technicalProposal.hash,
        producerAiMemberId: softwareArchitect.aiMember.id,
        producerPositionId: softwareArchitect.id,
        producerSessionId: architectureSession,
        evidenceRefs: ["fixture:technical-proposal-ready"],
      },
    }),
  );
  let technicalGateResultId = "";
  for (const [suffix, position, participantId, sessionId, revision] of [
    [
      "primary",
      reviewer,
      technicalParticipants.reviewer,
      createConsultation(reviewer, "reviewer"),
      2,
    ],
    [
      "fresh",
      freshReviewer,
      technicalParticipants.fresh,
      createConsultation(freshReviewer, "reviewer"),
      3,
    ],
  ] as const) {
    const result = requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:technical-review-pass-${suffix}`,
        actor: runtimeActor(position.aiMember.id),
        consumerId: "electron-test-fixture-setup",
        expectedRevision: revision,
        command: {
          type: "review.recheck.submit",
          topicId: technicalTopicId,
          recheckId: `${technicalTopicId}:recheck:${suffix}`,
          revisionId: technicalReviewRevisionId,
          reviewerParticipantId: participantId,
          reviewerSessionId: sessionId,
          result: "PASS",
          conditions: [],
          evidenceRefs: [`fixture:technical-review:${suffix}`],
        },
      }),
    );
    technicalGateResultId = result.gateResult?.id ?? technicalGateResultId;
  }
  if (!technicalGateResultId) {
    throw new Error("Formal Technical Review produced no PASS Gate Result.");
  }
  const parentSnapshotRevisionId = database.pipelineRuntime.inspectRun(
    productBaseline.runId,
  ).run.snapshotRevisionId;
  const promotedTechnical = requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:technical-gate-promote`,
      actor: runtimeActor(standardDeliveryCoordinator.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 2,
      command: {
        type: "technical-gate.promote",
        runId: productBaseline.runId,
        parentSnapshotRevisionId,
        gateResultId: technicalGateResultId,
      },
    }),
  );
  const formalTechnicalBaseline = promotedTechnical.acceptedBaseline;
  if (!formalTechnicalBaseline) {
    throw new Error("Formal Technical Gate produced no accepted baseline.");
  }
  const formalStarted = database.pipelineRuntime.startFormalizedRun({
    projectId: project.id,
    departmentId: department.id,
  });
  let awaitingReview = formalStarted;
  const developmentNode = awaitingReview.nodes.find(
    (node) => node.pipelineNodeId === "development",
  );
  if (!developmentNode) {
    throw new Error("Formal fixture Run has no development Node Run.");
  }

  const now = input.fakeClock;
  const projectSpecRevisionId = projectSpecRevision.id;
  const technicalBaselineId = formalTechnicalBaseline.id;
  const workPackageId = `${input.fixtureId}:work-package`;
  const workPackageVersionId = `${workPackageId}:v1`;
  const allocationId = `${input.fixtureId}:allocation`;
  const manifest = {
    objective: "Apply the scoped fixture change.",
    acceptanceCriteria: ["The exact frozen Diff is independently reviewed."],
    moduleScope: ["fixture-change.txt"],
    allowedPermissions: ["repository.write"],
    specRefs: [projectSpecRevisionId],
    harnessRefs: ["fixture:tdd@1"],
    assignmentCriteria: { positionIds: [developer.id] },
    expectedArtifacts: ["canonical-diff"],
    selfCheckCommands: ["fixture-test"],
    codeReviewConditions: ["Independent PASS required"],
    integrationConditions: ["npm test"],
    riskTier: "medium" as const,
    recoveryPolicy: "Create a fresh Version and Attempt.",
  };
  const selfCheck = {
    status: "passed" as const,
    commands: ["fixture-test"],
    logRefs: ["fixture:self-check"],
    summary: "The scoped fixture self-check passed.",
  };
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:work-package-generate`,
      actor: runtimeActor(standardDeliveryCoordinator.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "work-package.generate",
        runId: awaitingReview.run.id,
        technicalBaselineId,
        packages: [
          {
            workPackageId,
            versionId: workPackageVersionId,
            applicationId: `${input.fixtureId}:application`,
            repositoryReference: input.repositoryDirectory,
            nodeRunId: developmentNode.id,
            dependencies: [],
            manifest,
          },
        ],
      },
    }),
  );
  const assignedWorkPackage = requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:work-package-assign`,
      actor: runtimeActor(standardDeliveryCoordinator.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 0,
      command: {
        type: "work-package.assign",
        workPackageId,
        baseCommit,
      },
    }),
  );
  const formalAssignment = assignedWorkPackage.packages
    .find((entry) => entry.id === workPackageId)
    ?.versions.at(-1)
    ?.assignments.at(-1);
  if (!formalAssignment) {
    throw new Error("Formal Work Package assignment was not created.");
  }
  await database.workspaces.executeProvision(formalAssignment.allocationId);
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:work-package-start`,
      actor: runtimeActor(standardDeliveryCoordinator.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 1,
      command: {
        type: "work-package.start",
        workPackageId,
      },
    }),
  );
  const beforeDevelopment = database.pipelineRuntime.inspectRun(
    awaitingReview.run.id,
  );
  await database.pipelineRuntime.executeReady({
    runId: awaitingReview.run.id,
    expectedRevision: beforeDevelopment.run.revision,
  });
  const importedCommit = database.workspaces
    .inspect(formalAssignment.allocationId)
    .imports.find((entry) => entry.state === "succeeded")?.resultCommit;
  if (!importedCommit) {
    const allocationView = database.workspaces.inspect(
      formalAssignment.allocationId,
    );
    const pipelineView = database.pipelineRuntime.inspectRun(
      awaitingReview.run.id,
    );
    throw new Error(
      `Formal Work Package execution produced no Runtime-owned source import: ${JSON.stringify(
        {
          allocationState: allocationView.state,
          imports: allocationView.imports,
          nodes: pipelineView.nodes.map((node) => ({
            id: node.pipelineNodeId,
            status: node.status,
            failureCode: node.failure?.code ?? null,
          })),
        },
      )}`,
    );
  }
  const diffBytes = execFileSync(
    "git",
    [
      "-C",
      input.repositoryDirectory,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      baseCommit,
      importedCommit,
      "--",
    ],
    { encoding: "buffer" },
  );
  requireSucceeded(
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.fixtureId}:work-package-self-check`,
      actor: runtimeActor(standardDeliveryCoordinator.aiMember.id),
      consumerId: "electron-test-fixture-setup",
      expectedRevision: 3,
      command: {
        type: "work-package.self-check",
        workPackageId,
        ...selfCheck,
        commitEvidence: [importedCommit],
      },
    }),
  );
  awaitingReview = database.pipelineRuntime.inspectRun(awaitingReview.run.id);
  const developmentAttempt = awaitingReview.nodes
    .find((node) => node.pipelineNodeId === "development")
    ?.attempts.at(-1);
  const reviewNode = awaitingReview.nodes.find(
    (node) => node.pipelineNodeId === "review",
  );
  if (!developmentAttempt || reviewNode?.status !== "ready") {
    throw new Error(
      "Formal Work Package self-check did not release Code Review.",
    );
  }
  const producerSession = database.interaction.inspectSession(
    formalAssignment.interactionSessionId,
  );
  const registerArtifactVersion = (artifact: {
    readonly commandPrefix: string;
    readonly artifactType: string;
    readonly logicalName: string;
    readonly content: Buffer;
    readonly integrationAuthority?: {
      readonly generationId: string;
      readonly manifestHash: string;
      readonly passAuthorityHash: string;
      readonly repositoryCommits: {
        repositoryReference: string;
        commit: string;
      }[];
    };
  }) => {
    const registration = requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:${artifact.commandPrefix}-register`,
        actor: runtimeActor(developer.aiMember.id),
        consumerId: "electron-test-fixture-setup",
        command: {
          type: "artifact.version.register",
          projectId: project.id,
          artifactType: artifact.artifactType,
          artifactSchemaVersion: "1",
          logicalName: artifact.logicalName,
          content: {
            kind: "managed-file",
            encoding: "base64",
            data: artifact.content.toString("base64"),
          },
          producer: {
            projectId: project.id,
            runId: awaitingReview.run.id,
            nodeRunId: developmentNode.id,
            nodeAttemptId: developmentAttempt.id,
            snapshotRevisionId: awaitingReview.snapshot.id,
            aiMemberId: developer.aiMember.id,
            positionId: developer.id,
            sessionId: producerSession.session.id,
            workPackageId,
            ...(artifact.integrationAuthority
              ? { integrationAuthority: artifact.integrationAuthority }
              : {}),
          },
          inputVersionIds: [],
        },
      }),
    );
    return requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:${artifact.commandPrefix}-finalize`,
        actor: runtimeActor(developer.aiMember.id),
        consumerId: "electron-test-fixture-setup",
        command: {
          type: "artifact.version.finalize",
          registrationId: registration.registrationId,
        },
      }),
    );
  };
  registerArtifactVersion({
    commandPrefix: "canonical-diff",
    artifactType: "canonical-diff",
    logicalName: `${input.fixtureId}:canonical-diff`,
    content: diffBytes,
  });
  const buildBytes = Buffer.from(`fixture-build:${importedCommit}\n`);

  const reviewed = await database.pipelineRuntime.executeReady({
    runId: awaitingReview.run.id,
    expectedRevision: awaitingReview.run.revision,
  });
  const reviewResult = database.codeReviews.inspect(reviewed.run.id)[0];
  if (!reviewResult?.integrationEligible) {
    throw new Error(
      `Code Review handler did not produce exact T15 authority: ${JSON.stringify(
        {
          reviewResult,
          artifacts: database.artifactRegistry
            .listVersionsForRun(reviewed.run.id)
            .map((artifact) => ({
              id: artifact.id,
              type: artifact.type,
              status: artifact.status,
              producer: artifact.producer,
            })),
        },
      )}`,
    );
  }
  const integrated = await database.pipelineRuntime.executeReady({
    runId: reviewed.run.id,
    expectedRevision: reviewed.run.revision,
  });
  const generation = database.integrations
    .inspect(integrated.run.id)
    .find((candidate) => candidate.state === "passed");
  if (!generation) {
    throw new Error(
      `Integration handler did not produce PASS authority: ${JSON.stringify({
        reviewed: reviewed.nodes.map((node) => ({
          id: node.pipelineNodeId,
          status: node.status,
        })),
        integrated: integrated.nodes,
        generations: database.integrations.inspect(integrated.run.id),
      })}`,
    );
  }
  const integrationAuthority = database.integrations.readPassAuthority(
    generation.id,
  );
  const build = registerArtifactVersion({
    commandPrefix: "build",
    artifactType: "build",
    logicalName: `${input.fixtureId}:build`,
    content: buildBytes,
    integrationAuthority: {
      generationId: integrationAuthority.id,
      manifestHash: integrationAuthority.manifestHash,
      passAuthorityHash: integrationAuthority.passAuthorityHash!,
      repositoryCommits: integrationAuthority.repositoryResults
        .map((entry) => ({
          repositoryReference: entry.repositoryReference,
          commit: entry.integratedCommit!,
        }))
        .sort((left, right) =>
          left.repositoryReference.localeCompare(right.repositoryReference),
        ),
    },
  });
  const testing = await database.pipelineRuntime.executeReady({
    runId: integrated.run.id,
    expectedRevision: integrated.run.revision,
  });
  const testNode = testing.nodes.find((node) => node.pipelineNodeId === "test");
  const testAttempt = testNode?.attempts.at(-1);
  if (testNode?.status !== "running" || !testAttempt) {
    throw new Error("Fixture Pipeline did not claim the Test Node Attempt.");
  }
  const candidateInputNode = testing.nodes.find(
    (node) => node.pipelineNodeId === "candidate-input",
  );
  const securityNode = testing.nodes.find(
    (node) => node.pipelineNodeId === "security",
  );
  const operabilityNode = testing.nodes.find(
    (node) => node.pipelineNodeId === "operability",
  );
  const candidateNode = testing.nodes.find(
    (node) => node.pipelineNodeId === "candidate",
  );
  const humanReleaseNode = testing.nodes.find(
    (node) => node.pipelineNodeId === "human-release",
  );
  if (
    !candidateInputNode ||
    !securityNode ||
    !operabilityNode ||
    !candidateNode ||
    !humanReleaseNode
  ) {
    throw new Error("Fixture Pipeline is missing Delivery quality Nodes.");
  }
  const testSession = database.interaction.createSession({
    projectId: project.id,
    mode: "run-collaboration",
    runId: testing.run.id,
    nodeRunId: testNode.id,
  });
  database.interaction.addParticipant({
    sessionId: testSession.id,
    participantType: "ai-member",
    participantRef: tester.aiMember.id,
    role: "test-engineer",
  });
  const candidateInputSession = database.interaction.createSession({
    projectId: project.id,
    mode: "run-collaboration",
    runId: testing.run.id,
    nodeRunId: candidateInputNode.id,
  });
  database.interaction.addParticipant({
    sessionId: candidateInputSession.id,
    participantType: "ai-member",
    participantRef: deliveryCoordinator.aiMember.id,
    role: "delivery-coordinator",
  });
  const gateReviewerSession = createConsultation(
    reviewer,
    "security-operability-reviewer",
  );
  const gateReviewerFreshSession = createConsultation(
    reviewer,
    "security-operability-recheck",
  );
  const interactionSession = database.interaction.createSession({
    projectId: project.id,
    mode: "consultation",
  });
  const interactionHuman = database.interaction.addParticipant({
    sessionId: interactionSession.id,
    participantType: "human",
    participantRef: "electron-test-fixture",
    role: "requester",
  });
  database.interaction.addParticipant({
    sessionId: interactionSession.id,
    participantType: "ai-member",
    participantRef: tester.aiMember.id,
    role: "consulted-member",
  });
  const frozenProfile = testing.snapshot.payload.executionProfiles.find(
    (candidate) => candidate.id === profile.id,
  );
  if (!frozenProfile)
    throw new Error("Fixture Execution Profile was not frozen.");
  const frozenWorkPackageVersion = database.workPackages
    .inspect(testing.run.id)
    .packages.find((entry) => entry.id === workPackageId)
    ?.versions.find((entry) => entry.id === workPackageVersionId);
  if (!frozenWorkPackageVersion) {
    throw new Error("Fixture Work Package Version was not frozen.");
  }

  return {
    projectId: project.id,
    runId: testing.run.id,
    snapshotRevisionId: testing.snapshot.id,
    technicalBaselineId: formalTechnicalBaseline.id,
    technicalBaselineHash: formalTechnicalBaseline.hash,
    testNodeRunId: testNode.id,
    testNodeAttemptId: testAttempt.id,
    testSessionId: testSession.id,
    interactionSessionId: interactionSession.id,
    interactionHumanParticipantId: interactionHuman.id,
    testOwnerPositionId: tester.id,
    testOwnerAiMemberId: tester.aiMember.id,
    gateReview: {
      moderator: {
        aiMemberId: productManager.aiMember.id,
        positionId: productManager.id,
        sessionId: productSession.id,
      },
      reviewer: {
        aiMemberId: reviewer.aiMember.id,
        positionId: reviewer.id,
        sessionId: gateReviewerSession,
        freshSessionId: gateReviewerFreshSession,
      },
    },
    workPackageCoverage: [
      {
        workPackageId,
        workPackageVersionId,
        manifestHash: frozenWorkPackageVersion.manifestHash,
        riskTier: manifest.riskTier,
      },
    ],
    testExecutionProfile: {
      id: profile.id,
      hash: sha256(canonicalJson(frozenProfile)),
    },
    build: {
      artifactVersionId: build.id,
      digest: sha256(buildBytes),
    },
    deliveryQuality: {
      candidateInputNodeRunId: candidateInputNode.id,
      candidateInputSessionId: candidateInputSession.id,
      securityNodeRunId: securityNode.id,
      operabilityNodeRunId: operabilityNode.id,
      candidateNodeRunId: candidateNode.id,
      humanReleaseNodeRunId: humanReleaseNode.id,
      producer: {
        aiMemberId: deliveryCoordinator.aiMember.id,
        positionId: deliveryCoordinator.id,
      },
    },
    integrationAuthority,
  };
};
