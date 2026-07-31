import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { startCompanyRuntimeServer } from "../server.js";
import type { ModelOnlyInteractionExecutionAdapter } from "../adapters/interactionExecutionAdapter.js";
import type { AdapterExecutionFact } from "../execution/contract.js";
import { MODEL_ONLY_CONTEXT_SCHEMA_HASH } from "../execution/contract.js";
import type { ArtifactVersionView } from "../artifactRegistry.js";
import type { CompanyCommandRegistry } from "../commandRegistry.js";
import type { DeliveryCandidateInputView } from "../delivery/candidateInputRuntime.js";
import type { RuntimeInteraction } from "../interaction.js";
import type {
  CandidateGateInputView,
  CandidateGateResultView,
} from "../quality/qualityGateRuntime.js";

import {
  electronTestFixtureRuntimePrincipal,
  loadElectronTestFixtureConfig,
  normalizeTestEvidenceLocator,
  readElectronTestFixtureAdapterScript,
  verifyTestEvidenceFile,
} from "./electronTestFixture.js";
import {
  createElectronTestExecutionAdapter,
  readAcknowledgedElectronTestView,
} from "./electronTestExecutionAdapter.js";
import {
  createIntegrationAuthorityFixture,
  createIntegrationAuthorityFixtureRuntimeOptions,
  type IntegrationAuthorityFixtureResult,
} from "./integrationAuthorityFixture.js";
import type {
  TestExecutionRequest,
  TestExecutionResult,
  TestRuntime,
} from "./testRuntime.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

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

const repeatableIdFactory = (seed: string): (() => string) => {
  let sequence = 0;
  return () => {
    sequence += 1;
    const value = sha256(`${seed}:${sequence}`).slice(0, 32).split("");
    value[12] = "4";
    value[16] = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${value.slice(0, 8).join("")}-${value.slice(8, 12).join("")}-${value.slice(12, 16).join("")}-${value.slice(16, 20).join("")}-${value.slice(20).join("")}`;
  };
};

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

const scriptedInteractionAdapter = (
  response: string,
): ModelOnlyInteractionExecutionAdapter => ({
  capabilities: {
    reattachRunningOperation: false,
    strongExecutionFence: true,
    enforceNoSideEffects: {
      mechanism: "model-only",
      mechanismVersion: "electron-test-fixture-1",
      policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
    },
  },
  execute: async (request, sink) => {
    const facts: readonly AdapterExecutionFact[] = [
      {
        adapterSchemaVersion: 1,
        factId: `${request.operationKey}:provider-started`,
        ordinal: 1,
        kind: "provider-started",
        schemaVersion: 1,
        payload: { providerExecutionRef: `fixture:${request.operationKey}` },
        evidenceRefs: [],
      },
      {
        adapterSchemaVersion: 1,
        factId: `${request.operationKey}:message`,
        ordinal: 2,
        kind: "message",
        schemaVersion: 1,
        payload: { content: response },
        evidenceRefs: [],
      },
      {
        adapterSchemaVersion: 1,
        factId: `${request.operationKey}:completed`,
        ordinal: 3,
        kind: "completed",
        schemaVersion: 1,
        payload: {},
        evidenceRefs: [],
      },
    ];
    let terminalExecutionFactId = "";
    for (const fact of facts) {
      const receipt = await sink.record(fact);
      if (fact.kind === "completed") {
        terminalExecutionFactId = receipt.executionFactId;
      }
    }
    return {
      operationKey: request.operationKey,
      terminalExecutionFactId,
      status: "succeeded",
      evidenceRefs: [],
    };
  },
  cancel: async () => "not-found",
  reconcile: async () => ({ status: "unknown", evidenceRefs: [] }),
});

type FixtureEvidenceDescriptor = {
  readonly id: string;
  readonly testCaseRevisionId: string;
  readonly assertionId: string | null;
  readonly kind: TestExecutionResult["evidence"][number]["kind"];
  readonly artifactType: string;
  readonly mediaType: string;
  readonly logicalName: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly redactionProfile: string;
  readonly retentionClass: "transient" | "standard" | "durable";
  readonly metadata: unknown;
};

type FixtureExecutionInput = {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly action: "electron-assertion" | "cleanup";
  readonly testCaseRevisionId: string;
  readonly assertionId: string | null;
  readonly correlationCommandId?: string;
  readonly evidence: readonly FixtureEvidenceDescriptor[];
  readonly assertionContract?: {
    readonly schemaVersion: 1;
    readonly ui: {
      readonly statusText: string;
      readonly buttonLabel: string;
    };
    readonly runtime: {
      readonly interactionSessionId: string;
      readonly interactionCommandId: string;
      readonly interactionTurnStatus: "completed";
      readonly interactionResponse: string;
    };
  };
  readonly cleanup?: {
    readonly rootFingerprint: string;
    readonly targets: readonly {
      readonly kind: "repository" | "worktree";
      readonly pathFingerprint: string;
    }[];
  };
};

const fixtureExecutionInput = (
  request: TestExecutionRequest,
  fixtureId: string,
): FixtureExecutionInput => {
  const value = request.input as Partial<FixtureExecutionInput> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    value.fixtureId !== fixtureId ||
    !["electron-assertion", "cleanup"].includes(String(value.action)) ||
    typeof value.testCaseRevisionId !== "string" ||
    !Array.isArray(value.evidence)
  ) {
    throw new Error("Electron Test operation input is invalid.");
  }
  return value as FixtureExecutionInput;
};

const registerEvidence = (input: {
  readonly descriptor: FixtureEvidenceDescriptor;
  readonly evidenceDirectory: string;
  readonly operationKey: string;
  readonly seeded: IntegrationAuthorityFixtureResult;
  readonly commandRegistry: CompanyCommandRegistry;
  readonly validateBytes?: (bytes: Buffer) => void;
}): TestExecutionResult["evidence"][number] => {
  const locator = normalizeTestEvidenceLocator(input.descriptor.locator);
  if (locator !== input.descriptor.locator) {
    throw new Error("Electron Test evidence locator is not canonical.");
  }
  const verified = verifyTestEvidenceFile({
    evidenceDirectory: input.evidenceDirectory,
    locator,
    contentHash: input.descriptor.contentHash,
    byteSize: input.descriptor.byteSize,
  });
  const bytes = verified.bytes;
  input.validateBytes?.(bytes);
  const registration = requireSucceeded(
    input.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.operationKey}:artifact:${input.descriptor.id}:register`,
      actor: {
        type: "runtime-worker",
        id: "electron-test-fixture",
        authenticatedBy: "runtime",
      },
      consumerId: "electron-test-fixture-execution",
      expectedRevision: 0,
      command: {
        type: "artifact.version.register",
        projectId: input.seeded.projectId,
        artifactType: input.descriptor.artifactType,
        artifactSchemaVersion: "1",
        logicalName: input.descriptor.logicalName,
        content: {
          kind: "managed-file",
          encoding: "base64",
          data: bytes.toString("base64"),
          mediaType: input.descriptor.mediaType,
        },
        producer: {
          projectId: input.seeded.projectId,
          runId: input.seeded.runId,
          nodeRunId: input.seeded.testNodeRunId,
          nodeAttemptId: input.seeded.testNodeAttemptId,
          snapshotRevisionId: input.seeded.snapshotRevisionId,
          aiMemberId: input.seeded.testOwnerAiMemberId,
          positionId: input.seeded.testOwnerPositionId,
          sessionId: input.seeded.testSessionId,
        },
        inputVersionIds: [],
      },
    }),
  );
  const artifact = requireSucceeded(
    input.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `${input.operationKey}:artifact:${input.descriptor.id}:finalize`,
      actor: {
        type: "runtime-worker",
        id: "electron-test-fixture",
        authenticatedBy: "runtime",
      },
      consumerId: "electron-test-fixture-execution",
      expectedRevision: 0,
      command: {
        type: "artifact.version.finalize",
        registrationId: registration.registrationId,
      },
    }),
  ) as ArtifactVersionView;
  if (
    artifact.contentHash !== input.descriptor.contentHash ||
    artifact.byteSize !== input.descriptor.byteSize
  ) {
    throw new Error(
      "Runtime-managed Artifact does not match the frozen evidence descriptor.",
    );
  }
  return {
    id: input.descriptor.id,
    testCaseRevisionId: input.descriptor.testCaseRevisionId,
    assertionId: input.descriptor.assertionId,
    kind: input.descriptor.kind,
    mediaType: input.descriptor.mediaType,
    contentHash: artifact.contentHash,
    byteSize: artifact.byteSize,
    artifactVersionId: artifact.id,
    redactionProfile: input.descriptor.redactionProfile,
    retentionClass: input.descriptor.retentionClass,
    locator: artifact.contentRef,
    metadata: input.descriptor.metadata,
  };
};

const materializeCandidateQualityGates = (input: {
  readonly config: ReturnType<typeof loadElectronTestFixtureConfig>;
  readonly tests: TestRuntime;
  readonly commandRegistry: CompanyCommandRegistry;
  readonly seeded: IntegrationAuthorityFixtureResult;
}): void => {
  const receiptPath = join(
    input.config.evidenceDirectory,
    "runtime",
    "candidate-quality-gates.json",
  );
  if (existsSync(receiptPath)) return;
  const testRunId = `test:${input.seeded.runId}:${input.seeded.testNodeRunId}`;
  const testAuthority = input.tests.downstreamAuthority(testRunId);
  const execute = <Value>(
    commandId: string,
    actor: {
      readonly type: "runtime-worker";
      readonly id: string;
      readonly authenticatedBy: "runtime";
    },
    command: Parameters<CompanyCommandRegistry["execute"]>[0]["command"],
    expectedRevision?: number,
  ): Value =>
    requireSucceeded(
      input.commandRegistry.execute({
        schemaVersion: 1,
        commandId,
        actor,
        consumerId: "electron-test-fixture-quality-setup",
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        command,
      }),
    ) as Value;
  const runtimeActor = (id: string) => ({
    type: "runtime-worker" as const,
    id,
    authenticatedBy: "runtime" as const,
  });
  const candidateInputId = "fixture-delivery-candidate-input";
  const candidate = execute<DeliveryCandidateInputView>(
    "fixture-candidate-input-freeze",
    runtimeActor(input.seeded.testOwnerAiMemberId),
    {
      type: "delivery.candidate-input.freeze",
      candidateInputId,
      requestId: "fixture-candidate-input-request",
      projectId: input.seeded.projectId,
      runId: input.seeded.runId,
      snapshotRevisionId: input.seeded.snapshotRevisionId,
      nodeRunId: input.seeded.testNodeRunId,
      nodeAttemptId: input.seeded.testNodeAttemptId,
      producer: {
        aiMemberId: input.seeded.testOwnerAiMemberId,
        positionId: input.seeded.testOwnerPositionId,
        sessionId: input.seeded.testSessionId,
      },
      requiredTestRunIds: [testRunId],
      environment: {
        platform: process.platform,
        architecture: process.arch,
        electronVersion: process.versions.electron ?? process.version,
        executableHash: sha256(readFileSync(process.execPath)),
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
  );
  const gateResultIds: Record<"security" | "operability", string> = {
    security: "",
    operability: "",
  };
  for (const kind of ["security", "operability"] as const) {
    const topicId = `fixture-${kind}-review-topic`;
    const ownerParticipantId = `${topicId}:owner`;
    const reviewerParticipantId = `${topicId}:reviewer`;
    const gateInputId = `fixture-${kind}-gate-input`;
    const acceptanceCriteria = [
      ...new Set(
        candidate.manifest.integration.manifest.packages.flatMap(
          (entry) => entry.reviewContext.acceptanceCriteria,
        ),
      ),
    ].sort();
    execute(
      `fixture-${kind}-review-topic-create`,
      runtimeActor(input.seeded.testOwnerAiMemberId),
      {
        type: "review.topic.create",
        topicId,
        projectId: input.seeded.projectId,
        runId: input.seeded.runId,
        title: `${kind} review for the frozen Delivery Candidate Input`,
        manifest: {
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
          excludedContext: [
            "hidden-prompts",
            "prior-reviewer-opinions",
            "private-transcripts",
            "provider-session-history",
            "credential-values",
          ],
          scope: "verification",
          verificationSubject: {
            kind: "candidate-final",
            deliveryCandidateInputId: candidate.id,
            deliveryCandidateInputHash: candidate.manifestHash,
          },
          evidenceIds: candidate.manifest.evidence.map((entry) => entry.id),
        },
        producer: candidate.manifest.producer,
        participants: [
          {
            id: ownerParticipantId,
            role: "owner-participant",
            aiMemberId: input.seeded.testOwnerAiMemberId,
            positionId: input.seeded.testOwnerPositionId,
            sessionId: input.seeded.testSessionId,
          },
          {
            id: `${topicId}:moderator`,
            role: "moderator",
            ...input.seeded.gateReview.moderator,
          },
          {
            id: reviewerParticipantId,
            role: "reviewer-participant",
            aiMemberId: input.seeded.gateReview.reviewer.aiMemberId,
            positionId: input.seeded.gateReview.reviewer.positionId,
            sessionId: input.seeded.gateReview.reviewer.sessionId,
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
      0,
    );
    const gateInput = execute<CandidateGateInputView>(
      `fixture-${kind}-gate-input-prepare`,
      runtimeActor(input.seeded.testOwnerAiMemberId),
      {
        type: "quality-gate.input.prepare",
        gateInputId,
        requestId: `fixture-${kind}-gate-input-request`,
        kind,
        candidateInputId: candidate.id,
        expectedCandidateInputHash: candidate.manifestHash,
        expectedRiskTier: candidate.manifest.risk.tier,
        nodeRunId: input.seeded.testNodeRunId,
        nodeAttemptId: input.seeded.testNodeAttemptId,
        reviewTopicId: topicId,
        reviewerParticipantId,
      },
    );
    const reviewRevisionId = `${topicId}:revision`;
    execute(
      `fixture-${kind}-review-revision`,
      runtimeActor(input.seeded.testOwnerAiMemberId),
      {
        type: "review.revision.submit",
        topicId,
        revisionId: reviewRevisionId,
        ownerParticipantId,
        subjectKind: `${kind}-gate-input`,
        subjectId: gateInput.id,
        subjectHash: gateInput.manifestHash,
        producerAiMemberId: input.seeded.testOwnerAiMemberId,
        producerPositionId: input.seeded.testOwnerPositionId,
        producerSessionId: input.seeded.testSessionId,
        evidenceRefs: [...gateInput.manifest.supportingEvidenceRefs],
      },
      1,
    );
    const qualityGateResultId = `quality-gate-${topicId}`;
    execute(
      `fixture-${kind}-review-pass`,
      runtimeActor(input.seeded.gateReview.reviewer.aiMemberId),
      {
        type: "review.recheck.submit",
        topicId,
        recheckId: `${topicId}:recheck`,
        revisionId: reviewRevisionId,
        reviewerParticipantId,
        reviewerSessionId: input.seeded.gateReview.reviewer.freshSessionId,
        result: "PASS",
        conditions: [],
        evidenceRefs: [...gateInput.manifest.supportingEvidenceRefs],
      },
      2,
    );
    const executionId = `fixture-${kind}-gate-execution`;
    const evidenceRefFor = (evidenceKind: string): string => {
      const prefixes =
        evidenceKind === "artifact" || evidenceKind === "static-analysis"
          ? ["artifact-version:"]
          : evidenceKind === "runtime-fact"
            ? ["test-pass-authority:", "integration-pass-authority:"]
            : evidenceKind === "dynamic-analysis"
              ? ["test-evidence:", "artifact-version:"]
              : [
                  "test-evidence:",
                  "test-pass-authority:",
                  "integration-pass-authority:",
                  "artifact-version:",
                ];
      const reference = gateInput.manifest.supportingEvidenceRefs.find((item) =>
        prefixes.some((prefix) => item.startsWith(prefix)),
      );
      if (!reference) {
        throw new Error(
          `${kind} fixture Gate has no authoritative ${evidenceKind} evidence reference.`,
        );
      }
      return reference;
    };
    execute(
      `fixture-${kind}-gate-execution-accept`,
      runtimeActor(input.seeded.gateReview.reviewer.aiMemberId),
      {
        type: "quality-gate.execution.accept",
        executionId,
        gateInputId: gateInput.id,
        operationKey: `fixture:${kind}:gate-review`,
        request: {
          schemaVersion: 1,
          gateInputId: gateInput.id,
          gateInputHash: gateInput.manifestHash,
        },
      },
    );
    execute(
      `fixture-${kind}-gate-execution-reconcile`,
      runtimeActor(input.seeded.gateReview.reviewer.aiMemberId),
      {
        type: "quality-gate.execution.reconcile",
        executionId,
        observation: {
          state: "succeeded",
          fact: {
            schemaVersion: 1,
            gateInputId: gateInput.id,
            checks: gateInput.manifest.checkCatalog.checks.map((check) => ({
              checkId: check.id,
              status: "passed",
              evidence: check.requiredEvidenceKinds.map((evidenceKind) => ({
                kind: evidenceKind,
                ref: evidenceRefFor(evidenceKind),
              })),
              responsibility: {
                kind: "aggregate",
                candidateIds: [candidate.id],
              },
            })),
            resolutions: [],
          },
          receiptHash: sha256(
            canonicalJson({
              schemaVersion: 1,
              executionId,
              state: "succeeded",
            }),
          ),
        },
      },
    );
    const candidateGateResult = execute<CandidateGateResultView>(
      `fixture-${kind}-gate-result-finalize`,
      runtimeActor(input.seeded.gateReview.reviewer.aiMemberId),
      {
        type: "quality-gate.result.finalize",
        candidateGateResultId: `fixture-${kind}-gate-result`,
        gateInputId: gateInput.id,
        executionId,
        qualityGateResultId,
      },
    );
    if (candidateGateResult.result !== "PASS") {
      throw new Error(`${kind} fixture Gate did not produce PASS.`);
    }
    gateResultIds[kind] = candidateGateResult.id;
  }
  writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      candidateInputId: candidate.id,
      candidateInputHash: candidate.manifestHash,
      candidateRiskTier: candidate.manifest.risk.tier,
      securityGateResultId: gateResultIds.security,
      operabilityGateResultId: gateResultIds.operability,
    }),
    { flag: "wx", mode: 0o600 },
  );
  if ((statSync(receiptPath).mode & 0o777) !== 0o600) {
    throw new Error(
      "Candidate Quality Gate fixture receipt must be mode 0600.",
    );
  }
};

const main = async (): Promise<void> => {
  const config = loadElectronTestFixtureConfig({
    configPath: requiredEnvironment("SANDCASTLE_ELECTRON_TEST_FIXTURE_CONFIG"),
    authorizationClaimPath: requiredEnvironment(
      "SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION_CLAIM",
    ),
    authorization: requiredEnvironment(
      "SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION",
    ),
    packaged:
      requiredEnvironment("SANDCASTLE_ELECTRON_TEST_FIXTURE_PACKAGED") === "1",
    entrypoint: "electron-test-fixture",
  });
  const interactionScript = JSON.parse(
    readElectronTestFixtureAdapterScript(
      config,
      "scripted-interaction",
    ).toString("utf8"),
  ) as { readonly response?: string };
  const fixtureInput = {
    companyDirectory: config.companyDirectory,
    companyDirectoryFingerprint: config.companyDirectoryFingerprint,
    fixtureId: config.fixtureId,
    repositoryDirectory: config.repositoryDirectory,
    worktreeDirectory: config.worktreeDirectory,
    fakeClock: config.fakeClock,
    repeatableIdSeed: config.repeatableIdSeed,
  };
  const fixtureRuntimeOptions =
    createIntegrationAuthorityFixtureRuntimeOptions(fixtureInput);
  const setupReceiptPath = join(
    config.evidenceDirectory,
    "runtime",
    "setup-authority.json",
  );
  let seeded: IntegrationAuthorityFixtureResult | undefined;
  let interactionRuntime: RuntimeInteraction | undefined;
  const cleanupReceipts = new Map<string, unknown>();
  let candidateQualitySetupScheduled = false;
  let candidateQualitySetupClosed = false;
  let candidateQualitySetupTimer: ReturnType<typeof setTimeout> | undefined;
  const requireSeeded = (): IntegrationAuthorityFixtureResult => {
    if (!seeded) {
      throw new Error("Electron Test Runtime setup authority is unavailable.");
    }
    return seeded;
  };
  const runtime = await startCompanyRuntimeServer({
    address: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ADDRESS"),
    companyDir: config.companyDirectory,
    token: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_TOKEN"),
    consumerId: process.env.SANDCASTLE_COMPANY_RUNTIME_CONSUMER_ID,
    principal: electronTestFixtureRuntimePrincipal,
    executionAdapter: fixtureRuntimeOptions.executionAdapter,
    reviewerExecutionAdapter: fixtureRuntimeOptions.reviewerExecutionAdapter,
    integrationValidationProvider:
      fixtureRuntimeOptions.integrationValidationProvider,
    interactionExecutionAdapter: scriptedInteractionAdapter(
      interactionScript.response ?? "fixture interaction completed",
    ),
    testBuildFixture: {
      clock: fixtureRuntimeOptions.clock,
      nextId: repeatableIdFactory(config.repeatableIdSeed),
      fixtureAuthority: {
        read: (fixtureId) => {
          if (fixtureId !== config.fixtureId) {
            throw new Error(
              "Electron Test fixture identity is not allowlisted.",
            );
          }
          return {
            fixtureId: config.fixtureId,
            companyDirectoryFingerprint: config.companyDirectoryFingerprint,
            scriptHashes: Object.values(config.scriptHashes).sort(),
            adapterIds: ["scripted-execution"],
          };
        },
      },
      setup: async (database) => {
        interactionRuntime = database.interaction;
        if (existsSync(setupReceiptPath)) {
          const receipt = JSON.parse(
            readFileSync(setupReceiptPath, "utf8"),
          ) as {
            readonly schemaVersion: number;
            readonly fixtureId: string;
            readonly rootFingerprint: string;
            readonly companyDirectoryFingerprint: string;
            readonly seeded: IntegrationAuthorityFixtureResult;
          };
          if (
            receipt.schemaVersion !== 1 ||
            receipt.fixtureId !== config.fixtureId ||
            receipt.rootFingerprint !== config.rootFingerprint ||
            receipt.companyDirectoryFingerprint !==
              config.companyDirectoryFingerprint
          ) {
            throw new Error("Electron Test setup receipt identity is invalid.");
          }
          const authority = database.integrations.readPassAuthority(
            receipt.seeded.integrationAuthority.id,
          );
          if (
            canonicalJson(authority) !==
            canonicalJson(receipt.seeded.integrationAuthority)
          ) {
            throw new Error(
              "Electron Test setup receipt does not match Runtime authority.",
            );
          }
          seeded = receipt.seeded;
          return;
        }
        seeded = await createIntegrationAuthorityFixture({
          ...fixtureInput,
          database,
        });
        mkdirSync(join(config.evidenceDirectory, "runtime"), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(
          setupReceiptPath,
          JSON.stringify({
            schemaVersion: 1,
            fixtureId: config.fixtureId,
            rootFingerprint: config.rootFingerprint,
            companyDirectoryFingerprint: config.companyDirectoryFingerprint,
            seeded,
          }),
          { flag: "wx", mode: 0o600 },
        );
        if ((statSync(setupReceiptPath).mode & 0o777) !== 0o600) {
          throw new Error("Electron Test setup receipt must be mode 0600.");
        }
      },
    },
    testExecutionAdapterFactory: ({ database, tests, commandRegistry }) => {
      const scheduleCandidateQualitySetup = (): void => {
        if (candidateQualitySetupScheduled) return;
        candidateQualitySetupScheduled = true;
        let attempts = 0;
        const poll = (): void => {
          if (candidateQualitySetupClosed) return;
          attempts += 1;
          try {
            const currentSeed = requireSeeded();
            const testRunId = `test:${currentSeed.runId}:${currentSeed.testNodeRunId}`;
            if (tests.inspect(testRunId).state === "passed") {
              materializeCandidateQualityGates({
                config,
                tests,
                commandRegistry,
                seeded: currentSeed,
              });
              return;
            }
          } catch (error) {
            process.stderr.write(
              `[electron-test-fixture-runtime:candidate-quality-setup] ${
                error instanceof Error ? error.stack : String(error)
              }\n`,
            );
            return;
          }
          if (attempts >= 400) {
            process.stderr.write(
              "[electron-test-fixture-runtime:candidate-quality-setup] Timed out waiting for exact PASS Test authority.\n",
            );
            return;
          }
          candidateQualitySetupTimer = setTimeout(poll, 25);
        };
        candidateQualitySetupTimer = setTimeout(poll, 0);
      };
      return [
        createElectronTestExecutionAdapter({
          fixtureId: config.fixtureId,
          selectAcknowledgedView: (request) =>
            readAcknowledgedElectronTestView(
              database,
              tests.inspect(request.testRunId),
            ),
          terminalResult: (request, consumedToken) => {
            try {
              const operation = fixtureExecutionInput(
                request,
                config.fixtureId,
              );
              const currentSeed = requireSeeded();
              if (operation.action === "cleanup") {
                if (
                  operation.assertionId !== null ||
                  !operation.cleanup ||
                  operation.cleanup.rootFingerprint !==
                    config.rootFingerprint ||
                  canonicalJson(operation.cleanup.targets) !==
                    canonicalJson(
                      config.cleanupTargets.map((target) => ({
                        kind: target.kind,
                        pathFingerprint: target.pathFingerprint,
                      })),
                    ) ||
                  config.cleanupTargets.some((target) =>
                    existsSync(target.path),
                  ) ||
                  operation.evidence.length !== 1 ||
                  operation.evidence[0]?.kind !== "cleanup"
                ) {
                  throw new Error(
                    "Electron Test cleanup operation lacks exact post-delete authority.",
                  );
                }
                const descriptor = operation.evidence[0];
                const expectedCleanupSource = {
                  schemaVersion: 1,
                  fixtureId: config.fixtureId,
                  rootFingerprint: config.rootFingerprint,
                  targets: config.cleanupTargets.map((target) => ({
                    kind: target.kind,
                    pathFingerprint: target.pathFingerprint,
                    state: "absent" as const,
                  })),
                };
                const evidence = registerEvidence({
                  descriptor,
                  evidenceDirectory: config.evidenceDirectory,
                  operationKey: request.operationKey,
                  seeded: currentSeed,
                  commandRegistry,
                  validateBytes: (bytes) => {
                    const cleanupSource = JSON.parse(bytes.toString("utf8"));
                    if (
                      canonicalJson(cleanupSource) !==
                      canonicalJson(expectedCleanupSource)
                    ) {
                      throw new Error(
                        "Electron Test cleanup evidence does not match the frozen post-delete receipt.",
                      );
                    }
                  },
                });
                const receipt = {
                  schemaVersion: 1 as const,
                  kind: "cleanup" as const,
                  receiptId: `${request.operationKey}:cleanup-receipt`,
                  fixtureId: config.fixtureId,
                  operationKey: request.operationKey,
                  rootFingerprint: config.rootFingerprint,
                  targets: expectedCleanupSource.targets,
                  artifactVersionId: evidence.artifactVersionId!,
                  contentHash: evidence.contentHash,
                };
                cleanupReceipts.set(request.operationKey, receipt);
                return {
                  schemaVersion: 1 as const,
                  assertions: [],
                  evidence: [evidence],
                };
              }
              if (
                typeof operation.assertionId !== "string" ||
                typeof operation.correlationCommandId !== "string" ||
                operation.assertionContract?.schemaVersion !== 1
              ) {
                throw new Error(
                  "Electron Test assertion operation is missing correlation identity.",
                );
              }
              if (!interactionRuntime) {
                throw new Error(
                  "Electron Test Interaction Runtime is unavailable.",
                );
              }
              const interaction = interactionRuntime.inspectSession(
                currentSeed.interactionSessionId,
              );
              const interactionTurn = interaction.turns.find(
                (turn) =>
                  turn.commandId ===
                  operation.assertionContract!.runtime.interactionCommandId,
              );
              const interactionOutput = interaction.messages.find(
                (message) => message.id === interactionTurn?.outputMessageId,
              );
              const authoritativeContract = {
                schemaVersion: 1 as const,
                ui: operation.assertionContract.ui,
                runtime: {
                  interactionSessionId: interaction.session.id,
                  interactionCommandId: interactionTurn?.commandId,
                  interactionTurnStatus: interactionTurn?.status,
                  interactionResponse: interactionOutput?.content,
                },
              };
              if (
                interaction.session.id !== currentSeed.interactionSessionId ||
                interactionTurn?.status !== "completed" ||
                canonicalJson(authoritativeContract) !==
                  canonicalJson(operation.assertionContract)
              ) {
                throw new Error(
                  "Electron Test assertion contract does not match the authoritative Interaction Turn.",
                );
              }
              const evidence = operation.evidence.map((descriptor) =>
                registerEvidence({
                  descriptor,
                  evidenceDirectory: config.evidenceDirectory,
                  operationKey: request.operationKey,
                  seeded: currentSeed,
                  commandRegistry,
                  ...(descriptor.kind === "runtime"
                    ? {
                        validateBytes: (bytes: Buffer) => {
                          const payload = JSON.parse(
                            bytes.toString("utf8"),
                          ) as {
                            readonly assertionContract?: {
                              readonly expected?: unknown;
                              readonly observed?: unknown;
                            };
                          };
                          if (
                            canonicalJson(
                              payload.assertionContract?.expected,
                            ) !== canonicalJson(operation.assertionContract) ||
                            canonicalJson(
                              payload.assertionContract?.observed,
                            ) !== canonicalJson(operation.assertionContract)
                          ) {
                            throw new Error(
                              "Electron Test expected and observed assertion contracts do not match exactly.",
                            );
                          }
                        },
                      }
                    : {}),
                }),
              );
              const run = tests.inspect(request.testRunId);
              const event = (
                database
                  .prepare(
                    `SELECT sequence, type, scope_json AS scopeJson
                   FROM runtime_event_outbox
                  WHERE run_id = ? AND node_run_id = ?
                    AND type IN ('test.run.reconciling', 'test.run.started')
                  ORDER BY sequence DESC`,
                  )
                  .all(run.manifest.runId, run.manifest.nodeRunId) as Array<{
                  readonly sequence: number;
                  readonly type: string;
                  readonly scopeJson: string;
                }>
              ).find((candidate) => {
                const scope = JSON.parse(candidate.scopeJson) as {
                  readonly testRunId?: string;
                };
                return scope.testRunId === run.id;
              });
              if (!event || !consumedToken) {
                throw new Error(
                  "Electron Test execution requires an acknowledged authoritative Query View and Runtime event.",
                );
              }
              return {
                schemaVersion: 1,
                assertions: [
                  {
                    testCaseRevisionId: operation.testCaseRevisionId,
                    assertionId: operation.assertionId,
                    uiObserved: "Interaction Observed",
                    runtimeObserved: "completed",
                    uiStatus: "passed",
                    runtimeStatus: "passed",
                    correlation: {
                      commandId: operation.correlationCommandId,
                      eventSequence: event.sequence,
                      runtimeEventType: event.type,
                      queryAsOfSequence: consumedToken.sequence,
                      queryViewHash: consumedToken.viewHash,
                      viewSyncTokenHash: consumedToken.tokenHash,
                      snapshotRevisionId: run.manifest.snapshotRevisionId,
                      runId: run.manifest.runId,
                      nodeRunId: run.manifest.nodeRunId,
                      nodeAttemptId: run.manifest.nodeAttemptId,
                      sessionId: run.manifest.sessionId,
                      artifactVersionIds: evidence
                        .map((entry) => entry.artifactVersionId)
                        .filter((id): id is string => id !== null),
                    },
                  },
                ],
                evidence,
              };
            } catch (error) {
              process.stderr.write(
                `[electron-test-fixture-runtime:terminal-result] ${error instanceof Error ? error.stack : String(error)}\n`,
              );
              throw error;
            }
          },
          terminalReceipt: (request) => {
            const cleanupReceipt = cleanupReceipts.get(request.operationKey);
            if (cleanupReceipt) scheduleCandidateQualitySetup();
            return (
              cleanupReceipt ?? {
                schemaVersion: 1,
                fixtureId: config.fixtureId,
                operationKey: request.operationKey,
                status: "succeeded",
              }
            );
          },
        }),
      ];
    },
  });
  const close = (): void => {
    candidateQualitySetupClosed = true;
    if (candidateQualitySetupTimer) clearTimeout(candidateQualitySetupTimer);
    void runtime.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await runtime.closed;
};

main().catch((error) => {
  process.stderr.write(`[electron-test-fixture-runtime] ${String(error)}\n`);
  process.exitCode = 1;
});
