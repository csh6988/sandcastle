import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  scriptedSoftwareRndDepartment,
  scriptedSoftwareRndPipelineEditor,
} from "../runtime/testing/departmentInspectContract.js";
import {
  ArtifactLineagePanel,
  DepartmentDetailView,
  DepartmentRunDetail,
  AgentsPage,
  SkillCatalogResults,
  SkillsPage,
  PositionDrawerEditor,
  ProjectDetailView,
  ProjectDetailWorkPackages,
  CodeReviewAuthorityPanel,
  IntegrationGenerationPanel,
  CandidateQualityGatePanel,
  DeliveryCandidatePanel,
  deliveryCandidateInputIdFromRun,
  deliveryCandidateIdFromRun,
  CompanyInteractionPage,
  InteractionRunPanel,
  RUN_PROGRESS_POLL_INTERVAL_MS,
  createRunCollaborationSession,
  interactionSessionCloseLabel,
  interactionStatusLabel,
  loadInteractionProjectContext,
  memoryCandidateDecisionLabel,
  promptInteractionSession,
  startRunProgressPolling,
  RuntimeDiagnosticsPanel,
  ReviewTopicsPanel,
  ProductReviewStatePanel,
  TechnicalReviewStatePanel,
  isAgentTestDisabled,
  RunCollaborationWorkspace,
  projectCreationInputInvalid,
  startProjectDepartmentRun,
  inspectProjectRunWorkPackages,
  inspectProjectRunCodeReviews,
  confirmProjectProductBaseline,
  recoveryOverrideInputProvided,
} from "./companyPages.js";
import { Icon, IconButton } from "./icons.js";
import { messages } from "./i18n.js";
import type {
  DepartmentRunView,
  ProductReviewStateView,
  TechnicalReviewStateView,
  ReviewTopicView,
  CodeReviewView,
  IntegrationGenerationView,
  CandidateQualityGateView,
  DeliveryCandidateView,
} from "../runtime/interface.js";
import type {
  AgentCatalogView,
  SkillCatalogView,
} from "../runtime/interface.js";
import { scriptedSkillConfiguration } from "../runtime/testing/skillConfigurationContract.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";

describe("Delivery Candidate quality", () => {
  it("renders only authoritative Candidate/Gate identity and finds the frozen Run result", () => {
    const view = {
      candidateInput: {
        id: "candidate-input-1",
        requestId: "candidate-request-1",
        manifest: { schemaVersion: 1, risk: { tier: "high" } },
        manifestHash: "a".repeat(64),
        state: "frozen-for-final-gates",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
      criticalEscalation: null,
      gateInputs: [],
      gateResults: [
        {
          id: "security-result-1",
          gateInputId: "security-input-1",
          qualityGateResultId: "generic-result-1",
          result: "PASS",
          manifest: {},
          resultHash: "b".repeat(64),
          defects: [],
          obligations: [],
          createdAt: "2026-07-30T00:01:00.000Z",
        },
      ],
      authority: null,
    } as CandidateQualityGateView;
    const markup = renderToStaticMarkup(
      <CandidateQualityGatePanel
        busy={false}
        diagnostic={null}
        onCriticalEscalation={() => undefined}
        view={view}
      />,
    );
    const run = {
      nodes: [
        {
          handler: { handlerKindId: "delivery-candidate-input@1" },
          status: "succeeded",
          result: { deliveryCandidateInputId: "candidate-input-1" },
        },
      ],
    } as unknown as DepartmentRunView;

    assert.match(markup, /candidate-input-1/);
    assert.match(markup, /high/);
    assert.match(markup, /security-result-1/);
    assert.match(markup, /blocked/);
    assert.equal(deliveryCandidateInputIdFromRun(run), "candidate-input-1");

    const escalatedMarkup = renderToStaticMarkup(
      <CandidateQualityGatePanel
        busy={false}
        diagnostic={null}
        onCriticalEscalation={() => undefined}
        view={{
          ...view,
          candidateInput: {
            ...view.candidateInput,
            manifest: { schemaVersion: 1, risk: { tier: "critical" } },
          },
          criticalEscalation: {
            id: "critical-escalation-1",
            candidateInputId: view.candidateInput.id,
            candidateInputHash: view.candidateInput.manifestHash,
            decision: "reject",
            actor: {
              type: "human",
              id: "verified-local-human",
              authenticatedBy: "local-session",
            },
            risk: { tier: "critical" },
            riskHash: "d".repeat(64),
            reason: "Critical risk was rejected by the verified local human.",
            evidenceRefs: ["artifact-version:risk-evidence-1"],
            decisionHash: "e".repeat(64),
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        }}
      />,
    );
    assert.match(escalatedMarkup, /critical-escalation-1/);
    assert.match(escalatedMarkup, /Critical risk was rejected/);
  });

  it("renders an authoritative Human release gesture and finds the Candidate Run result", () => {
    const view = {
      id: "delivery-candidate-1",
      requestId: "delivery-candidate-request-1",
      manifest: { artifacts: [{ id: "artifact-version-1" }] },
      manifestHash: "c".repeat(64),
      projection: "awaiting-decision",
      decision: null,
      supersededByCandidateId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    } as DeliveryCandidateView;
    const markup = renderToStaticMarkup(
      <DeliveryCandidatePanel
        busy={false}
        diagnostic={null}
        onDecision={() => undefined}
        view={view}
      />,
    );
    const run = {
      nodes: [
        {
          handler: { handlerKindId: "delivery-candidate@1" },
          status: "succeeded",
          result: { deliveryCandidateId: view.id },
        },
      ],
    } as unknown as DepartmentRunView;

    assert.match(markup, /accept-delivery-candidate/);
    assert.match(markup, /reject-delivery-candidate/);
    assert.match(markup, /request-delivery-changes/);
    assert.match(markup, /Exact responsibility kind/);
    assert.match(markup, /Exact responsibility ID/);
    assert.match(markup, /1 immutable evidence reference/);
    assert.equal(deliveryCandidateIdFromRun(run), view.id);
    const acceptedMarkup = renderToStaticMarkup(
      <DeliveryCandidatePanel
        busy={false}
        diagnostic={null}
        onDecision={() => undefined}
        view={{ ...view, projection: "accepted" }}
      />,
    );
    assert.doesNotMatch(acceptedMarkup, /accept-delivery-candidate/);

    const activatedMarkup = renderToStaticMarkup(
      <DeliveryCandidatePanel
        busy={false}
        diagnostic={null}
        onDecision={() => undefined}
        onRecovery={() => undefined}
        view={
          {
            ...view,
            projection: "rework-activated",
            decision: {
              id: "release-decision-1",
              rework: { scope: "same-boundary" },
            },
            recoveryActivation: {
              id: "release-rework-activation-1",
              authority: {
                kind: "work-package-version",
                id: "work-package-version-2",
              },
              activationHash: "d".repeat(64),
            },
          } as DeliveryCandidateView
        }
      />,
    );
    assert.match(activatedMarkup, /rework-activated/);
    assert.match(activatedMarkup, /work-package-version-2/);
    assert.match(activatedMarkup, new RegExp("d{64}"));
    assert.doesNotMatch(activatedMarkup, /activate-delivery-rework/);
  });

  it("requires and submits an exact child Run for boundary-changing release rework", async () => {
    const view = {
      id: "delivery-candidate-boundary-change",
      requestId: "delivery-candidate-request-boundary-change",
      manifest: { artifacts: [{ id: "artifact-version-1" }] },
      manifestHash: "f".repeat(64),
      projection: "awaiting-decision",
      decision: null,
      supersededByCandidateId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    } as DeliveryCandidateView;
    const submitted: unknown[] = [];
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const domGlobals = {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    } as const;
    const previousGlobals = new Map(
      Object.keys(domGlobals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(domGlobals)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <DeliveryCandidatePanel
            busy={false}
            diagnostic={null}
            onDecision={(input) => submitted.push(input)}
            view={view}
          />,
        );
      });
      const scope = container.querySelector("select") as HTMLSelectElement;
      await act(async () => {
        scope.value = "boundary-changing";
        scope.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      const button = container.querySelector(
        "#request-delivery-changes",
      ) as HTMLButtonElement;
      assert.equal(button.disabled, true);
      const childRun = container.querySelector(
        "#delivery-release-child-run-delivery-candidate-boundary-change",
      ) as HTMLInputElement;
      const responsibilityId = container.querySelector(
        "#delivery-release-responsibility-id-delivery-candidate-boundary-change",
      ) as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )?.set?.call(childRun, "confirmed-child-run-1");
        childRun.dispatchEvent(
          new dom.window.InputEvent("input", { bubbles: true }),
        );
        childRun.dispatchEvent(
          new dom.window.Event("change", { bubbles: true }),
        );
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )?.set?.call(responsibilityId, "work-package-version-1");
        responsibilityId.dispatchEvent(
          new dom.window.InputEvent("input", { bubbles: true }),
        );
      });
      assert.equal(
        (
          container.querySelector(
            "#request-delivery-changes",
          ) as HTMLButtonElement
        ).disabled,
        false,
      );
      await act(async () => button.click());
      assert.deepEqual(submitted, [
        {
          decision: "changes-requested",
          reason:
            "Reviewed the immutable Delivery Candidate evidence in this local session.",
          evidenceRefs: ["artifact-version:artifact-version-1"],
          reworkScope: "boundary-changing",
          childRunId: "confirmed-child-run-1",
          responsibilityKind: "work-package",
          responsibilityId: "work-package-version-1",
        },
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    }
  });
});

describe("Review Topics", () => {
  it("renders exact manifest, individual findings, quorum, and PASS-only gate state", () => {
    const manifest = {
      scope: "code" as const,
      topicId: "topic-1",
      supportingArtifactVersionIds: ["evidence-1"],
      supportingSpecRevisionIds: ["spec-1"],
      harnessSnapshotIds: ["harness-1"],
      acceptanceCriteria: ["Exact diff is verified"],
      excludedContext: ["hidden-prompts" as const],
      workPackageVersionId: "package-v1",
      repositoryId: "repo-1",
      sourceCommit: "abc123",
      diffArtifactVersionId: "diff-v1",
      diffHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const view = {
      topic: {
        id: "topic-1",
        projectId: "project-1",
        title: "Independent code review",
        kind: "code" as const,
        status: "PASS" as const,
        revision: 8,
        manifest,
        manifestHash:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        producer: {
          aiMemberId: "developer",
          positionId: "software-engineer",
          sessionId: "producer-session",
        },
        quorum: 2,
        budget: {
          maxRounds: 2,
          maxDurationSeconds: 600,
          maxTokens: 8_000,
          maxCostCents: 250,
        },
        budgetUsed: {
          rounds: 1,
          durationSeconds: 90,
          tokens: 900,
          costCents: 25,
        },
        stopCondition: "blocking-findings-dispositioned" as const,
        escalationPolicy: "fail-with-evidence" as const,
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:10:00.000Z",
      },
      participants: [
        {
          id: "owner",
          role: "owner-participant" as const,
          aiMemberId: "owner-member",
          positionId: "owner-position",
          sessionId: "owner-session",
          eligibility: {
            eligible: false,
            reasons: ["role-excluded" as const],
            snapshotHash:
              "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        },
        {
          id: "reviewer",
          role: "reviewer-participant" as const,
          aiMemberId: "reviewer-member",
          positionId: "reviewer-position",
          sessionId: "reviewer-session",
          eligibility: {
            eligible: true,
            reasons: [],
            snapshotHash:
              "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          },
        },
      ],
      findings: [
        {
          id: "finding-1",
          topicId: "topic-1",
          reviewerParticipantId: "reviewer",
          reviewerSessionId: "reviewer-session",
          severity: "high" as const,
          summary: "Recovery evidence was missing",
          rationale: "Crash behavior was unverified",
          impact: "Ambiguous operation state",
          evidenceRefs: ["test-before"],
          suggestedOwner: "owner",
          blocking: true,
          createdAt: "2026-07-27T00:01:00.000Z",
        },
      ],
      resolutions: [],
      discussions: [],
      revisions: [],
      rechecks: [
        {
          id: "recheck-1",
          topicId: "topic-1",
          revisionId: "revision-1",
          reviewerParticipantId: "reviewer",
          reviewerSessionId: "fresh-session-1",
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["test-after"],
          eligibilitySnapshotHash:
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          createdAt: "2026-07-27T00:08:00.000Z",
        },
        {
          id: "recheck-2",
          topicId: "topic-1",
          revisionId: "revision-1",
          reviewerParticipantId: "fresh-reviewer",
          reviewerSessionId: "fresh-session-2",
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["independent-check"],
          eligibilitySnapshotHash:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          createdAt: "2026-07-27T00:09:00.000Z",
        },
      ],
      gateResult: {
        id: "gate-1",
        topicId: "topic-1",
        kind: "code" as const,
        manifest,
        manifestHash:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        revisionId: "revision-1",
        result: "PASS" as const,
        satisfiesProductionContract: true,
        conditions: [],
        recheckIds: ["recheck-1", "recheck-2"],
        evidenceRefs: ["test-after", "independent-check"],
        createdAt: "2026-07-27T00:10:00.000Z",
      },
    } satisfies ReviewTopicView;

    const markup = renderToStaticMarkup(<ReviewTopicsPanel topics={[view]} />);
    assert.match(markup, /data-review-topic="topic-1"/);
    assert.match(markup, new RegExp(view.topic.manifestHash));
    assert.match(markup, /data-review-quorum="true">2\/2/);
    assert.match(markup, /Recovery evidence was missing/);
    assert.match(markup, /Satisfies downstream production contracts/);
  });
});

describe("Product Review state", () => {
  it("renders immutable Spec lineage, readiness blockers, and PASS Snapshot promotion", () => {
    const state = {
      projectId: "project-1",
      runId: "run-1",
      productBaselineId: "baseline-1",
      productBaselineHash: "a".repeat(64),
      specRevisions: [
        {
          id: "spec-r1",
          projectSpecId: "spec-1",
          projectId: "project-1",
          runId: "run-1",
          productBaselineId: "baseline-1",
          productBaselineHash: "a".repeat(64),
          revision: 1,
          supersedesRevisionId: null,
          content: {
            outcome: "Ship checkout",
            acceptanceCriteria: ["One order"],
            applicationBoundaries: ["checkout-web"],
            crossApplicationContracts: ["checkout-v1"],
            deliveryConstraints: ["Local-first"],
          },
          hash: "b".repeat(64),
          producer: {
            aiMemberId: "product-planner-member",
            positionId: "product-planner",
            sessionId: "session-1",
          },
          createdAt: "2026-07-27T00:00:00.000Z",
        },
      ],
      reviewTopics: [],
      readinessEvidence: [],
      readinessBlockers: ["readiness-blocker-1"],
      promotion: {
        id: "promotion-1",
        topicId: "topic-1",
        qualityGateResultId: "gate-1",
        projectSpecRevisionId: "spec-r1",
        projectSpecHash: "b".repeat(64),
        readinessEvidenceIds: ["readiness-1"],
        sourceSnapshotRevisionId: "snapshot-r1",
        snapshotRevisionId: "snapshot-r2",
        snapshotHash: "c".repeat(64),
        createdAt: "2026-07-27T00:10:00.000Z",
      },
      snapshotLineage: [
        {
          id: "snapshot-r1",
          revision: 1,
          parentRevision: null,
          hash: "d".repeat(64),
        },
        {
          id: "snapshot-r2",
          revision: 2,
          parentRevision: 1,
          hash: "c".repeat(64),
        },
      ],
    } satisfies ProductReviewStateView;

    const markup = renderToStaticMarkup(
      <ProductReviewStatePanel state={state} />,
    );
    assert.match(markup, /data-product-review-state/);
    assert.match(markup, /1 immutable Project Spec revision/);
    assert.match(markup, /Blocked by readiness-blocker-1/);
    assert.match(markup, /PASS promoted Snapshot snapshot-r2 from snapshot-r1/);
  });
});

describe("Technical Review state", () => {
  it("renders exact Application Specs, proposal, contracts, and accepted baseline", () => {
    const applicationSpecRef = {
      applicationId: "checkout-web",
      id: "application-spec-r1",
      hash: "b".repeat(64),
    };
    const contractRef = {
      id: "checkout-submit",
      version: "1",
      hash: "c".repeat(64),
    };
    const state = {
      projectId: "project-1",
      runId: "run-1",
      applications: [
        {
          id: "checkout-web",
          projectId: "project-1",
          repositoryReference: "/work/checkout-web",
          applicationKey: "web",
          ownership: "checkout-team",
          buildCommand: "npm run build:web",
          testCommand: "npm run test:web",
          revision: 1 as const,
          createdAt: "2026-07-27T00:00:00.000Z",
        },
      ],
      applicationSpecRevisions: [
        {
          id: applicationSpecRef.id,
          applicationSpecId: "application-spec-1",
          applicationId: applicationSpecRef.applicationId,
          projectId: "project-1",
          runId: "run-1",
          promotedProjectSpecRevisionId: "project-spec-r1",
          promotedProjectSpecHash: "a".repeat(64),
          revision: 1,
          supersedesRevisionId: null,
          content: {
            design: "Submit checkout commands.",
            acceptanceCriteria: ["One order is created."],
            workPackageConstraints: ["Isolated execution."],
            integrationObligations: ["Produce checkout-submit."],
            contractRefs: [{ id: "checkout-submit", version: "1" }],
          },
          hash: applicationSpecRef.hash,
          producer: {
            aiMemberId: "software-architect-member",
            positionId: "software-architect",
            sessionId: "architect-session",
          },
          createdAt: "2026-07-27T00:01:00.000Z",
        },
      ],
      technicalBaselineProposals: [
        {
          id: "proposal-r1",
          technicalBaselineProposalId: "proposal-1",
          projectId: "project-1",
          runId: "run-1",
          promotedProjectSpecRevisionId: "project-spec-r1",
          promotedProjectSpecHash: "a".repeat(64),
          readinessEvidence: [{ id: "readiness-1", hash: "d".repeat(64) }],
          applicationSpecRevisions: [applicationSpecRef],
          revision: 1,
          supersedesRevisionId: null,
          content: {
            architecture: "Web calls Orders API.",
            dependencyGraph: ["web -> api"],
            contracts: [
              {
                id: contractRef.id,
                version: contractRef.version,
                producerApplicationId: "checkout-web",
                consumerApplicationId: "orders-api",
                kind: "api" as const,
                schema: "POST /orders",
                compatibilityPolicy: "exact" as const,
                compatibility: "compatible" as const,
                evidenceRefs: ["contract-pass"],
                testCommands: ["npm run test:contract"],
              },
            ],
            riskPolicy: ["Reject duplicates."],
            permissionPolicy: ["No production credentials."],
            testStrategy: ["Run contract tests."],
          },
          hash: "e".repeat(64),
          producer: {
            aiMemberId: "software-architect-member",
            positionId: "software-architect",
            sessionId: "architect-session",
          },
          createdAt: "2026-07-27T00:02:00.000Z",
        },
      ],
      applicationContracts: [
        {
          id: contractRef.id,
          version: contractRef.version,
          producerApplicationId: "checkout-web",
          consumerApplicationId: "orders-api",
          kind: "api" as const,
          schema: "POST /orders",
          compatibilityPolicy: "exact" as const,
          compatibility: "compatible" as const,
          evidenceRefs: ["contract-pass"],
          testCommands: ["npm run test:contract"],
          hash: contractRef.hash,
        },
      ],
      reviewTopics: [],
      conditionalObligations: [],
      acceptedBaseline: {
        id: "technical-baseline-1",
        projectId: "project-1",
        runId: "run-1",
        proposalRevisionId: "proposal-r1",
        manifest: {
          schemaVersion: 1 as const,
          promotedProjectSpecRevisionId: "project-spec-r1",
          promotedProjectSpecHash: "a".repeat(64),
          readinessEvidence: [{ id: "readiness-1", hash: "d".repeat(64) }],
          applicationSpecRevisions: [applicationSpecRef],
          proposalRevisionId: "proposal-r1",
          proposalRevisionHash: "e".repeat(64),
          crossApplicationContracts: [contractRef],
          architecture: "Web calls Orders API.",
          dependencyGraph: ["web -> api"],
          riskPolicy: ["Reject duplicates."],
          permissionPolicy: ["No production credentials."],
          testStrategy: ["Run contract tests."],
        },
        hash: "f".repeat(64),
        createdAt: "2026-07-27T00:05:00.000Z",
      },
      promotion: {
        id: "technical-promotion-1",
        topicId: "technical-topic-1",
        qualityGateResultId: "technical-gate-1",
        technicalBaselineId: "technical-baseline-1",
        technicalBaselineHash: "f".repeat(64),
        proposalRevisionId: "proposal-r1",
        proposalRevisionHash: "e".repeat(64),
        sourceSnapshotRevisionId: "snapshot-r2",
        snapshotRevisionId: "snapshot-r3",
        snapshotHash: "1".repeat(64),
        createdAt: "2026-07-27T00:05:00.000Z",
      },
      snapshotLineage: [
        {
          id: "snapshot-r1",
          revision: 1,
          parentRevision: null,
          hash: "2".repeat(64),
        },
        {
          id: "snapshot-r2",
          revision: 2,
          parentRevision: 1,
          hash: "3".repeat(64),
        },
        {
          id: "snapshot-r3",
          revision: 3,
          parentRevision: 2,
          hash: "1".repeat(64),
        },
      ],
    } satisfies TechnicalReviewStateView;

    const markup = renderToStaticMarkup(
      <TechnicalReviewStatePanel state={state} />,
    );
    assert.match(markup, /data-technical-review-state/);
    assert.match(markup, /1 immutable Application Spec revision/);
    assert.match(markup, /Proposal r1/);
    assert.match(markup, /1 compatible Cross-Application Contract revision/);
    assert.match(
      markup,
      /PASS accepted Technical Baseline technical-baseline-1/,
    );
  });
});

describe("Artifact lineage", () => {
  it("renders exact producer and input Artifact Version identities", () => {
    const markup = renderToStaticMarkup(
      <ArtifactLineagePanel
        lineage={{
          version: {
            id: "artifact-version-2",
            artifactId: "artifact-1",
            projectId: "project-1",
            type: "verification-report",
            schemaVersion: "1",
            logicalName: "checkout-verification",
            version: 2,
            contentRef: ".sandcastle/artifacts/artifact-version-2.json",
            contentHash: "a".repeat(64),
            byteSize: 128,
            status: "accepted",
            producer: {
              runId: "run-2",
              nodeRunId: "node-verification",
              nodeAttemptId: "attempt-3",
              snapshotRevisionId: "snapshot-r2",
              aiMemberId: "evaluator-member",
            },
            createdAt: "2026-07-15T00:00:00.000Z",
          },
          inputs: [{ versionId: "artifact-version-1", relation: "input" }],
        }}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-artifact-lineage="artifact-version-2"/);
    assert.match(markup, /run-2/);
    assert.match(markup, /attempt-3/);
    assert.match(markup, /snapshot-r2/);
    assert.match(markup, /evaluator-member/);
    assert.match(markup, /artifact-version-1/);
  });
});

describe("Company Agent and Skill catalog pages", () => {
  it("locks only the Agent card currently being tested", () => {
    assert.equal(isAgentTestDisabled(new Set(), "codex", "installed"), false);
    assert.equal(
      isAgentTestDisabled(new Set(["codex"]), "codex", "installed"),
      true,
    );
    assert.equal(
      isAgentTestDisabled(new Set(["codex"]), "hermes", "installed"),
      false,
    );
    const concurrentTests = new Set(["codex", "hermes"]);
    assert.equal(
      isAgentTestDisabled(concurrentTests, "codex", "installed"),
      true,
    );
    assert.equal(
      isAgentTestDisabled(concurrentTests, "hermes", "installed"),
      true,
    );
    assert.equal(
      isAgentTestDisabled(new Set(), "codem", "not-installed"),
      true,
    );
  });

  it("renders detected Agents with stable IDs and a non-destructive test action", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        t={messages.en}
        initialCatalog={
          {
            agents: [
              {
                id: "codex",
                name: "Codex",
                status: "installed",
                version: "1.2.3",
                executablePath: "/opt/bin/codex",
                lastDetectedAt: "2026-07-16T08:00:00.000Z",
                capabilities: ["non-interactive"],
                errorCode: null,
              },
            ],
          } satisfies AgentCatalogView
        }
      />,
    );
    assert.match(markup, /data-page="agents"/);
    assert.match(markup, /data-agent-id="codex"/);
    assert.match(markup, /Codex/);
    assert.match(markup, /1\.2\.3/);
    assert.match(markup, /class="catalog-path"/);
    assert.match(markup, /class="catalog-meta-block"/);
    assert.match(markup, /data-agent-capabilities/);
    assert.match(markup, /data-detect-agents/);
    assert.match(markup, /class="agent-test-button"/);
    assert.match(markup, /data-test-agent="codex"/);
  });

  it("renders independent Skills search, source references, and lifecycle actions", () => {
    const markup = renderToStaticMarkup(
      <SkillsPage
        t={messages.en}
        initialCatalog={
          {
            directories: ["/Users/test/.codex/skills"],
            skills: [
              {
                id: "local-review",
                name: "Local Review",
                description: "Reviews changes.",
                sourceDirectory: "/Users/test/.codex/skills",
                version: "sha256:abc",
                locationReference:
                  "/Users/test/.codex/skills/local-review/SKILL.md",
                requiredCapabilities: ["structured-output"],
                status: "discovered",
              },
            ],
          } satisfies SkillCatalogView
        }
      />,
    );
    assert.match(markup, /data-page="skills"/);
    assert.match(markup, /placeholder="Search Skills"/);
    assert.match(markup, /Local Review/);
    assert.match(markup, /SKILL\.md/);
    assert.match(markup, /data-enable-skill="local-review"/);
    assert.match(markup, /data-skill-directory/);
    assert.match(markup, /class="refresh-skills-button"/);
    assert.match(markup, /class="create-panel skill-directory-panel"/);
    assert.match(markup, /Add Skill Directory/);
    assert.match(markup, /data-view-skill-source="local-review"/);
    assert.match(markup, /Requires Agent capabilities.*structured-output/);
    assert.match(markup, /data-skill-catalog-list/);
    assert.match(markup, /class="skill-catalog-item"/);
    assert.match(markup, /class="skill-enable-button"/);
  });

  it("filters the rendered Skill catalog with ordered fuzzy characters", () => {
    const markup = renderToStaticMarkup(
      <SkillCatalogResults
        onArchive={() => undefined}
        onEnable={() => undefined}
        search="lrv"
        skills={[
          {
            id: "local-review",
            name: "Local Review",
            description: "Reviews changes.",
            sourceDirectory: "/skills",
            version: "sha256:abc",
            locationReference: "/skills/local-review/SKILL.md",
            status: "enabled",
          },
          {
            id: "release-notes",
            name: "Release Notes",
            description: "Writes release notes.",
            sourceDirectory: "/skills",
            version: "sha256:def",
            locationReference: "/skills/release-notes/SKILL.md",
            status: "enabled",
          },
        ]}
        t={messages.en}
      />,
    );
    assert.match(markup, /Local Review/);
    assert.doesNotMatch(markup, /Release Notes/);
  });

  it("prefers direct Skill name matches over description-only matches", () => {
    const markup = renderToStaticMarkup(
      <SkillCatalogResults
        onArchive={() => undefined}
        onEnable={() => undefined}
        search="ask"
        skills={[
          {
            id: "ask-matt",
            name: "ask-matt",
            description: "Ask which skill fits.",
            sourceDirectory: "/skills",
            version: "sha256:ask",
            locationReference: "/skills/ask-matt/SKILL.md",
            status: "discovered",
          },
          {
            id: "code-review",
            name: "code-review",
            description: "Review changes and asks for context.",
            sourceDirectory: "/skills",
            version: "sha256:review",
            locationReference: "/skills/code-review/SKILL.md",
            status: "discovered",
          },
        ]}
        t={messages.en}
      />,
    );
    assert.match(markup, /data-skill-catalog-id="ask-matt"/);
    assert.doesNotMatch(markup, /data-skill-catalog-id="code-review"/);
  });
});

describe("Position drawer", () => {
  it("edits basic identity, default Agent, and fuzzy-searchable Skills in one save", () => {
    const position = scriptedSoftwareRndDepartment.positions.find(
      (candidate) => candidate.id === "software-engineer",
    );
    assert.ok(position);
    const markup = renderToStaticMarkup(
      <PositionDrawerEditor
        agentCatalog={{
          agents: [
            {
              id: "codex",
              name: "Codex",
              status: "installed",
              version: "1.2.3",
              executablePath: "/opt/codex",
              lastDetectedAt: "2026-07-16T08:00:00.000Z",
              capabilities: ["non-interactive"],
              errorCode: null,
            },
          ],
        }}
        busy={false}
        configuration={scriptedSkillConfiguration}
        departmentId="software-rnd"
        onArchive={async () => undefined}
        onClose={() => undefined}
        onSave={async () => undefined}
        position={position}
        t={messages.en}
      />,
    );
    assert.match(markup, /data-position-drawer="software-engineer"/);
    assert.match(markup, /data-position-drawer-layer/);
    assert.match(markup, /data-position-drawer-backdrop/);
    assert.match(markup, /data-close-position-drawer/);
    assert.match(markup, /aria-label="Close position editor"/);
    assert.match(markup, /data-drawer-close-icon/);
    assert.doesNotMatch(markup, />×<\/button>/);
    assert.match(markup, /Default Agent/);
    assert.match(markup, /value="codex"/);
    assert.match(markup, /placeholder="Search Skills"/);
    assert.match(markup, /1 selected/);
    assert.match(
      markup,
      /class="skill-picker-option selected" data-position-skill-option="tdd"/,
    );
    assert.match(
      markup,
      /class="skill-picker-option-name">Test-Driven Development</,
    );
    assert.match(markup, /data-save-position-configuration/);
    assert.match(markup, /data-position-danger-zone/);
  });
});

describe("Runtime diagnostics", () => {
  it("renders storage, lease, outbox, audit, and cursor diagnostics", () => {
    const markup = renderToStaticMarkup(
      <RuntimeDiagnosticsPanel
        busy={false}
        diagnostics={{
          schemaVersion: 20,
          sqliteIntegrity: "ok",
          databaseBytes: 4096,
          runtimeEventCount: 100,
          pendingRuntimeEventCount: 4,
          auditRecordCount: 80,
          activeLeaseCount: 2,
          cursorCount: 3,
        }}
        lastBackup={null}
        onBackup={async () => undefined}
        onCompact={async () => undefined}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-runtime-diagnostics/);
    assert.match(markup, /Schema v20/);
    assert.match(markup, /SQLite integrity.*ok/);
    assert.match(markup, /Active leases.*2/);
    assert.match(markup, /Pending Runtime events.*4/);
    assert.match(markup, /Audit records.*80/);
    assert.match(markup, /Durable cursors.*3/);
    assert.match(markup, /Compact acknowledged events/);
    assert.match(markup, /Create database backup/);
  });
});

describe("Department detail", () => {
  const pipelineProps = {
    pipelineEditor: scriptedSoftwareRndPipelineEditor,
    onSavePipelineDraft: async () => scriptedSoftwareRndPipelineEditor,
    onValidatePipeline: async () =>
      scriptedSoftwareRndPipelineEditor.validation,
    onPublishPipeline: async () => scriptedSoftwareRndPipelineEditor,
  };
  const skillProps = {
    skillConfiguration: scriptedSkillConfiguration,
    onSaveSkill: async () => scriptedSkillConfiguration,
    onArchiveSkill: async () => scriptedSkillConfiguration,
    onSetPositionSkills: async () => scriptedSkillConfiguration,
    onSaveSkillFlow: async () => scriptedSkillConfiguration,
    onArchiveSkillFlow: async () => scriptedSkillConfiguration,
    onCreatePosition: async () => undefined,
    onArchivePosition: async () => undefined,
    onCreateSecretReference: async () => undefined,
    onArchiveSecretReference: async () => undefined,
    onSaveExecutionProfile: async () => undefined,
    onArchiveExecutionProfile: async () => undefined,
  };

  it("renders Runtime-backed Overview, Positions, and editable Pipeline panels", () => {
    const overview = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="overview"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(overview, /data-page="department-detail"/);
    assert.match(overview, /Software R&amp;D/);
    assert.match(overview, /Built-in department/);
    assert.match(overview, /Published Pipeline v2/);
    assert.match(overview, /6 positions/);
    assert.match(positions, /Product Planner/);
    assert.match(positions, /Software Architect/);
    assert.match(positions, /Software Engineer/);
    assert.match(positions, /Reviewer/);
    assert.match(positions, /Evaluator/);
    assert.match(pipeline, /data-pipeline-draft-revision="0"/);
    assert.match(pipeline, /data-pipeline-published-version="2"/);
    assert.match(pipeline, /Product alignment/);
    assert.match(pipeline, /Technical plan/);
    assert.match(pipeline, /Human acceptance/);
    assert.match(pipeline, /Save Draft/);
    assert.match(pipeline, /Full-screen editor/);
    assert.match(pipeline, /Validate/);
    assert.match(pipeline, /Publish/);
    assert.match(pipeline, /data-pipeline-canvas/);
    assert.match(pipeline, /data-pipeline-node-library/);
    assert.match(pipeline, /data-pipeline-canvas-node="technical-plan"/);
    assert.match(pipeline, /data-pipeline-inspector/);
    assert.doesNotMatch(pipeline, /Accessible list editor/);
    assert.doesNotMatch(pipeline, /data-pipeline-node-editor=/);
    assert.match(pipeline, /data-pipeline-history-version="1"/);
  });

  it("renders the complete AI Task configuration in the visual Inspector", () => {
    const aiTask = scriptedSoftwareRndPipelineEditor.draft.graph.nodes.find(
      (node) => node.id === "implementation",
    );
    assert.ok(aiTask);
    const inspectorEditor = {
      ...scriptedSoftwareRndPipelineEditor,
      draft: {
        ...scriptedSoftwareRndPipelineEditor.draft,
        graph: {
          ...scriptedSoftwareRndPipelineEditor.draft.graph,
          nodes: [
            {
              ...aiTask,
              instructions: "Implement the approved plan.",
              executionProfileId: "default",
              inputContractRefs: ["technical-plan"],
              outputContractRefs: ["implementation"],
              timeoutSeconds: 900,
              retryMaxAttempts: 2,
              maxIterations: 6,
              maxTokens: 32_000,
            },
            ...scriptedSoftwareRndPipelineEditor.draft.graph.nodes.filter(
              (node) => node.id !== aiTask.id,
            ),
          ],
        },
      },
    };
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
        pipelineEditor={inspectorEditor}
      />,
    );

    assert.match(pipeline, /Draft based on.*v2/);
    assert.match(pipeline, /data-pipeline-inspector-field="instructions"/);
    assert.match(pipeline, /data-pipeline-inspector-field="execution-profile"/);
    assert.match(pipeline, /data-pipeline-inspector-field="input-contracts"/);
    assert.match(pipeline, /data-pipeline-inspector-field="output-contracts"/);
    assert.match(pipeline, /data-pipeline-inspector-field="timeout"/);
    assert.match(pipeline, /data-pipeline-inspector-field="retry"/);
    assert.match(pipeline, /data-pipeline-inspector-field="max-iterations"/);
    assert.match(pipeline, /data-pipeline-inspector-field="max-tokens"/);
  });

  it("renders Department and Position edit controls from the deep Runtime read model", () => {
    const detail = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="overview"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(detail, /data-department-settings/);
    assert.match(detail, /Save department/);
    assert.match(detail, /Archive department/);
    assert.match(detail, /Copy department/);
    assert.match(positions, /data-position-editor="software-engineer"/);
    assert.match(positions, /AI Member display name/);
    assert.match(positions, /Save position/);
  });

  it("separates the read-only Department overview from layered Settings", () => {
    const props = {
      department: scriptedSoftwareRndDepartment,
      t: messages.en,
      onBack: () => undefined,
      onTabChange: () => undefined,
      onUpdateDepartment: async () => undefined,
      onArchiveDepartment: async () => undefined,
      onCopyDepartment: async () => undefined,
      onUpdatePosition: async () => undefined,
      onConfigurePosition: async () => undefined,
      agentCatalog: {
        agents: [
          {
            id: "codex",
            name: "Codex",
            status: "installed" as const,
            version: "1.2.3",
            executablePath: "/opt/codex",
            lastDetectedAt: "2026-07-16T08:00:00.000Z",
            capabilities: ["non-interactive" as const],
            errorCode: null,
          },
        ],
      },
      ...pipelineProps,
      ...skillProps,
    };
    const overview = renderToStaticMarkup(
      <DepartmentDetailView {...props} activeTab="overview" />,
    );
    const settings = renderToStaticMarkup(
      <DepartmentDetailView {...props} activeTab="settings" />,
    );
    assert.match(overview, /data-department-panel="overview"/);
    assert.match(overview, /Department summary/);
    assert.doesNotMatch(overview, /data-department-settings/);
    assert.match(settings, /data-department-settings/);
    assert.match(settings, /data-artifact-contract-settings/);
    assert.match(settings, /data-department-advanced-settings/);
    assert.match(settings, /data-run-environment-toggle/);
    assert.match(settings, /Edit advanced run environment/);
    assert.match(settings, /data-save-department-settings/);
    assert.match(settings, /Run environments/);
    assert.match(settings, /Agent provider/);
    assert.match(settings, /Sandbox environment/);
    assert.doesNotMatch(settings, /Save Execution Profile/);
    assert.doesNotMatch(settings, /Create Secret Reference/);
    assert.doesNotMatch(settings, /Provider reference/);
    assert.doesNotMatch(settings, /Sandbox reference/);
  });

  it("renders a stable unpublished Pipeline state for a custom Department", () => {
    const customDepartment = {
      ...scriptedSoftwareRndDepartment,
      id: "custom-department",
      name: "Design",
      builtIn: false,
      positions: [],
      pipeline: null,
    };
    const customPipelineEditor = {
      ...scriptedSoftwareRndPipelineEditor,
      department: { id: "custom-department", name: "Design" },
      positions: [],
      draft: {
        revision: 0,
        updatedAt: null,
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [{ from: "start", to: "complete" }],
        },
      },
      validation: { valid: true, issues: [] },
      published: null,
      history: [],
    };
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={customDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        pipelineEditor={customPipelineEditor}
        onSavePipelineDraft={async () => customPipelineEditor}
        onValidatePipeline={async () => customPipelineEditor.validation}
        onPublishPipeline={async () => customPipelineEditor}
        {...skillProps}
      />,
    );

    assert.match(pipeline, /data-pipeline-state="draft-only"/);
    assert.match(pipeline, /No Pipeline has been published yet/);
    assert.match(pipeline, /Save Draft/);
  });

  it("localizes stable Runtime validation codes in the Pipeline editor", () => {
    const invalidEditor = {
      ...scriptedSoftwareRndPipelineEditor,
      validation: {
        valid: false,
        issues: [
          {
            code: "START_COUNT_INVALID",
            messageKey: "pipeline.validation.startCount",
          },
        ],
      },
    };
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        pipelineEditor={invalidEditor}
        onSavePipelineDraft={async () => invalidEditor}
        onValidatePipeline={async () => invalidEditor.validation}
        onPublishPipeline={async () => invalidEditor}
        {...skillProps}
      />,
    );

    assert.match(pipeline, /data-pipeline-validation="invalid"/);
    assert.match(pipeline, /data-validation-code="START_COUNT_INVALID"/);
    assert.match(
      pipeline,
      /The Pipeline must contain exactly one Start node\./,
    );
  });

  it("renders Runtime-backed Skill bindings, Skill Flows, and AI Task Flow selection", () => {
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(positions, /data-skill-configuration/);
    assert.match(positions, /data-skill-catalog/);
    assert.match(positions, /Test-Driven Development/);
    assert.match(positions, /data-position-skill-binding="software-engineer"/);
    assert.match(positions, /data-skill-flow-editor="implementation-flow"/);
    assert.match(positions, /data-skill-flow-skill-list="implementation-flow"/);
    assert.match(
      positions,
      /class="skill-flow-skill-option selected" data-skill-flow-skill-option="implementation-flow:tdd"/,
    );
    assert.match(
      positions,
      /Builds behavior through red-green vertical slices./,
    );
    assert.match(positions, /Implement one tested vertical slice at a time./);
    assert.match(positions, /Archive Skill Flow/);
    assert.match(pipeline, /data-pipeline-canvas-node="implementation"/);
    assert.match(pipeline, /Implementation/);
  });

  it("renders stable Skill Configuration error codes for conflict guidance", () => {
    const markup = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        error="Skill Flow revision is stale. Reload and try again."
        skillErrorCode="VERSION_CONFLICT"
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(markup, /data-skill-error-code="VERSION_CONFLICT"/);
    assert.match(markup, /configuration changed in another view/);
  });

  it("explains blocked Skill and Skill Flow archive errors in English and Chinese", () => {
    const english = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        error="fallback"
        skillErrorCode="SKILL_FLOW_IN_USE"
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const chinese = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.zh}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        error="fallback"
        skillErrorCode="SKILL_IN_USE"
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(english, /current Pipeline Draft or active Pipeline Version/);
    assert.match(chinese, /仍有 Position 或活跃 Skill Flow 正在使用它/);
  });

  it("renders Department contracts, Execution Profiles, Secret References, and Position lifecycle controls", () => {
    const overview = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="overview"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(overview, /data-artifact-contracts="input"/);
    assert.match(overview, /data-artifact-contracts="output"/);
    assert.match(
      overview,
      /Formal inputs required before this Department Run can start\./,
    );
    assert.match(overview, /No input artifacts are required\./);
    assert.match(overview, /No output artifacts are required\./);
    assert.match(overview, /data-execution-profiles/);
    assert.match(
      overview,
      /data-execution-profile-editor="software-rnd-default"/,
    );
    assert.match(overview, /data-secret-references/);
    assert.match(overview, /no secret value is saved/);
    assert.match(positions, /data-new-position/);
    assert.match(positions, /data-archive-position="software-engineer"/);
    assert.match(positions, /data-archive-skill="tdd"/);
  });
});

describe("Project detail", () => {
  it("requires at least one non-empty Recovery Override input", () => {
    assert.equal(recoveryOverrideInputProvided("", "", "", ""), false);
    assert.equal(recoveryOverrideInputProvided(" ", "  ", "", " "), false);
    assert.equal(
      recoveryOverrideInputProvided("", "scripted-model", "", ""),
      true,
    );
  });

  it("blocks blank and whitespace-only Project creation input", () => {
    assert.equal(projectCreationInputInvalid("", "Goal"), true);
    assert.equal(projectCreationInputInvalid("Project", ""), true);
    assert.equal(projectCreationInputInvalid("   ", "  "), true);
    assert.equal(projectCreationInputInvalid("Project", "Goal"), false);
  });

  it("renders Approve and Reject actions for a waiting Human Approval", () => {
    const waitingRun = {
      ...scriptedDepartmentRun,
      run: {
        ...scriptedDepartmentRun.run,
        status: "waiting-approval" as const,
        revision: 2,
      },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          pipelineVersion: {
            ...scriptedDepartmentRun.snapshot.payload.pipelineVersion,
            graph: {
              nodes: [
                { id: "start", type: "start" as const, name: "Start" },
                {
                  id: "approval",
                  type: "human-approval" as const,
                  name: "Approval",
                },
                { id: "complete", type: "complete" as const, name: "Complete" },
              ],
              edges: [
                { from: "start", to: "approval" },
                { from: "approval", to: "complete" },
              ],
            },
          },
        },
      },
      nodes: [
        { ...scriptedDepartmentRun.nodes[0]!, status: "succeeded" as const },
        {
          id: "node-run-approval",
          runId: "run-1",
          pipelineNodeId: "approval",
          nodeType: "human-approval" as const,
          status: "waiting-approval" as const,
          attemptCount: 0,
          attempts: [],
          approvals: [
            {
              id: "approval-cycle-1",
              cycle: 1,
              status: "pending" as const,
              decision: null,
              requestedAction: "Approve completion",
              inputManifestHash: null,
              eligibleHumanPolicy: { policy: "any" },
              expiresAt: null,
              decisionActor: null,
              decisionCommandId: null,
              createdAt: "2026-07-15T00:00:00.000Z",
              decidedAt: null,
              expiredAt: null,
            },
          ],
          requiredDependencyIds: ["start"],
          result: null,
          failure: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
        {
          ...scriptedDepartmentRun.nodes[1]!,
          requiredDependencyIds: ["approval"],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onDecision={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onFork={() => undefined}
        run={waitingRun}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-run-approval-decision="approve"/);
    assert.match(markup, /data-run-approval-decision="request-changes"/);
    assert.match(markup, /data-run-approval-decision="reject"/);
    assert.match(markup, /data-run-approval-feedback/);
    assert.match(markup, /data-run-approval-cycle="1"/);
    assert.match(markup, /data-run-control="pause"/);
    assert.match(markup, /data-run-control="cancel"/);
    assert.match(markup, /data-run-fork-node=/);
    assert.match(markup, />Approve</);
    assert.match(markup, />Request changes</);
    assert.match(markup, />Reject</);

    const expiredRun: DepartmentRunView = {
      ...waitingRun,
      run: { ...waitingRun.run, status: "blocked", revision: 3 },
      nodes: waitingRun.nodes.map((node) =>
        node.id === "node-run-approval"
          ? {
              ...node,
              status: "failed",
              failure: {
                code: "APPROVAL_EXPIRED",
                message: "The Approval request expired.",
              },
              approvals: node.approvals.map((approval) => ({
                ...approval,
                status: "expired",
                expiredAt: "2026-07-15T00:01:00.000Z",
              })),
            }
          : node,
      ),
    };
    const expiredMarkup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onDecision={() => undefined}
        onRetryApproval={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        run={expiredRun}
        t={messages.en}
      />,
    );
    assert.match(expiredMarkup, /data-run-approval-expired/);
    assert.match(expiredMarkup, /data-run-approval-retry="node-run-approval"/);
  });

  it("renders structured run progress and separated node timeline regions", () => {
    const runWithCurrentNode: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: { ...scriptedDepartmentRun.run, status: "running" },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          pipelineVersion: {
            ...scriptedDepartmentRun.snapshot.payload.pipelineVersion,
            graph: {
              nodes: [
                { id: "start", type: "start", name: "Start" },
                {
                  id: "implement",
                  type: "ai-task",
                  name: "Implement",
                  positionId: "engineer",
                },
                { id: "complete", type: "complete", name: "Complete" },
              ],
              edges: [
                { from: "start", to: "implement" },
                { from: "implement", to: "complete" },
              ],
            },
          },
          positions: [
            {
              id: "engineer",
              revision: 1,
              name: "Software Engineer",
              responsibility: "Implement the change",
              defaultAgentId: "codex",
              resolvedAgentId: "codex",
              agentSource: "position-default",
              skillIds: [],
              aiMember: {
                id: "engineer-member",
                displayName: "Ada",
                profile: "",
                responsibilityMetadata: {},
                status: "active",
              },
            },
          ],
        },
      },
      nodes: [
        { ...scriptedDepartmentRun.nodes[0]!, status: "succeeded" },
        {
          id: "node-run-implement",
          runId: "run-1",
          pipelineNodeId: "implement",
          nodeType: "ai-task",
          handler: {
            nodeId: "implement",
            handlerKindId: "ai-task@1",
            inputSchemaHash: "c".repeat(64),
            outputSchemaHash: "d".repeat(64),
          },
          status: "running",
          attemptCount: 1,
          attempts: [
            {
              id: "attempt-1",
              attemptNumber: 1,
              snapshotRevisionId: "snapshot-1",
              reason: "initial",
              recoverable: true,
              status: "running",
              result: null,
              failure: null,
              feedback: [],
              createdAt: "2026-07-15T00:00:00.000Z",
              startedAt: "2026-07-15T00:01:00.000Z",
              completedAt: null,
            },
          ],
          approvals: [],
          requiredDependencyIds: ["start"],
          result: null,
          failure: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:01:00.000Z",
        },
        {
          ...scriptedDepartmentRun.nodes[1]!,
          requiredDependencyIds: ["implement"],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onDecision={() => undefined}
        onRetry={() => undefined}
        onFork={() => undefined}
        run={runWithCurrentNode}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-run-progress/);
    assert.match(markup, /data-current-node/);
    assert.match(markup, /data-run-execution-info/);
    assert.match(markup, /data-run-current-activity/);
    assert.match(markup, /data-run-node-timeline/);
    assert.match(markup, /data-run-node-summary="node-run-implement"/);
    assert.match(markup, /data-node-handler-kind="ai-task@1"/);
    assert.match(markup, />ai-task@1</);
    assert.match(markup, /class="run-node-status"/);
    assert.match(markup, /class="run-node-attempts"/);
    assert.match(markup, /class="run-node-evidence"/);
    assert.match(markup, /class="run-node-actions"/);
    assert.match(markup, /1 \/ 3/);
    assert.match(markup, /Ada/);
    assert.match(markup, /Software Engineer/);
  });

  it("renders failed AI Task recovery and persisted Continue Run actions", () => {
    const failedRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: {
        ...scriptedDepartmentRun.run,
        status: "failed",
        revision: 2,
      },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          pipelineVersion: {
            ...scriptedDepartmentRun.snapshot.payload.pipelineVersion,
            graph: {
              nodes: [
                { id: "start", type: "start", name: "Start" },
                {
                  id: "implement",
                  type: "ai-task",
                  name: "Implement",
                  positionId: "engineer",
                },
                { id: "complete", type: "complete", name: "Complete" },
              ],
              edges: [
                { from: "start", to: "implement" },
                { from: "implement", to: "complete" },
              ],
            },
          },
          executionProfiles:
            scriptedDepartmentRun.snapshot.payload.executionProfiles.map(
              (profile) => ({
                ...profile,
                retryPolicy: { maxAttempts: 1 },
              }),
            ),
        },
      },
      nodes: [
        { ...scriptedDepartmentRun.nodes[0]!, status: "succeeded" },
        {
          id: "node-run-implement",
          runId: "run-1",
          pipelineNodeId: "implement",
          nodeType: "ai-task",
          status: "failed",
          attemptCount: 1,
          attempts: [
            {
              id: "attempt-1",
              attemptNumber: 1,
              snapshotRevisionId: "snapshot-1",
              reason: "initial",
              recoverable: false,
              status: "failed",
              result: null,
              failure: {
                code: "SCRIPTED_AGENT_FAILED",
                message: "The first attempt failed.",
              },
              feedback: [],
              createdAt: "2026-07-15T00:00:00.000Z",
              startedAt: "2026-07-15T00:00:00.000Z",
              completedAt: "2026-07-15T00:01:00.000Z",
            },
          ],
          approvals: [],
          requiredDependencyIds: ["start"],
          result: null,
          failure: {
            code: "SCRIPTED_AGENT_FAILED",
            message: "The first attempt failed.",
          },
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:01:00.000Z",
        },
        {
          ...scriptedDepartmentRun.nodes[1]!,
          requiredDependencyIds: ["implement"],
        },
      ],
    };
    const failedMarkup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onDecision={() => undefined}
        onRetry={() => undefined}
        run={failedRun}
        t={messages.en}
      />,
    );
    assert.match(failedMarkup, /data-run-node-retry="node-run-implement"/);
    assert.match(failedMarkup, /data-run-retry-feedback/);
    assert.match(failedMarkup, /Retries remaining: 1/);
    assert.match(failedMarkup, /SCRIPTED_AGENT_FAILED/);
    assert.match(failedMarkup, /data-run-recovery/);
    assert.match(failedMarkup, /data-run-recovery-provider/);
    assert.match(failedMarkup, /data-run-recovery-model/);
    assert.match(failedMarkup, /data-run-recover/);

    const readyAttempt = {
      ...failedRun.nodes[1]!.attempts[0]!,
      id: "attempt-2",
      attemptNumber: 2,
      reason: "retry" as const,
      status: "ready" as const,
      failure: null,
      startedAt: null,
      completedAt: null,
    };
    const recoveringRun: DepartmentRunView = {
      ...failedRun,
      run: { ...failedRun.run, status: "recovering", revision: 3 },
      nodes: failedRun.nodes.map((node) =>
        node.id === "node-run-implement"
          ? {
              ...node,
              status: "ready",
              attemptCount: 2,
              attempts: [...node.attempts, readyAttempt],
              failure: null,
            }
          : node,
      ),
    };
    const recoveringMarkup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onDecision={() => undefined}
        onRetry={() => undefined}
        run={recoveringRun}
        t={messages.en}
      />,
    );
    assert.match(recoveringMarkup, /data-run-continue/);
    assert.match(recoveringMarkup, /data-run-control="pause"/);
    assert.match(recoveringMarkup, /data-run-control="cancel"/);
    assert.match(recoveringMarkup, />Continue run</);
  });

  it("renders the Runtime-backed Project configuration editor", () => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web", "/work/checkout-api"],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <ProjectDetailView
        project={project}
        t={messages.en}
        initialTab="settings"
        onBack={() => undefined}
        onSave={async () => project}
        onArchive={async () => project}
      />,
    );

    assert.match(markup, /data-page="project-detail"/);
    assert.match(markup, /data-runtime-project-id="project-1"/);
    assert.match(markup, /Project revision 1/);
    assert.match(markup, /Preserve the payment-provider contract\./);
    assert.match(markup, /data-project-repository="\/work\/checkout-web"/);
    assert.match(markup, /data-project-repository="\/work\/checkout-api"/);
    assert.match(markup, /Add repository reference/);
    assert.match(markup, /Save project/);
    assert.match(markup, /Archive project/);
    assert.match(markup, /data-project-runs/);
    assert.match(markup, /data-project-run-list/);
    assert.match(markup, /data-project-run-detail/);
    assert.match(markup, /class="primary-button"/);
    assert.match(markup, /data-start-department-run/);
    assert.match(markup, /data-open-consultation/);
    assert.match(markup, /Start Department Run/);
    assert.match(markup, /class="run-start-field"/);
    assert.match(markup, /data-run-start-submit/);
  });

  it("opens Project Detail on the PRD Overview tab instead of configuration", () => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web"],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <ProjectDetailView
        project={project}
        t={messages.en}
        onBack={() => undefined}
        onSave={async () => project}
        onArchive={async () => project}
      />,
    );

    assert.match(markup, /data-project-tab="overview"/);
    assert.match(markup, /aria-selected="true"[^>]*>Overview/);
    assert.match(markup, /data-active-project-tab="overview"/);
    assert.match(markup, /data-project-overview/);
  });

  it("queries and mounts the selected Run Work Package graph without retaining failed data", async () => {
    const graph = {
      projectId: "project-1",
      runId: "run-1",
      technicalBaselineId: "technical-baseline-1",
      packages: [],
    };
    const queries: unknown[] = [];
    const loaded = await inspectProjectRunWorkPackages(
      {
        query: async (query) => {
          queries.push(query);
          return { view: graph };
        },
      },
      "run-1",
    );
    assert.deepEqual(queries, [
      { type: "work-packages.inspect", runId: "run-1" },
    ]);
    assert.deepEqual(loaded, graph);

    const markup = renderToStaticMarkup(
      <ProjectDetailWorkPackages active graph={loaded} />,
    );
    assert.match(markup, /data-work-package-graph/);
    assert.match(markup, /Technical Baseline technical-baseline-1/);

    const failed = await inspectProjectRunWorkPackages(
      {
        query: async () => {
          throw new Error("query failed");
        },
      },
      "run-1",
    );
    assert.equal(failed, null);
    assert.equal(
      renderToStaticMarkup(<ProjectDetailWorkPackages active graph={failed} />),
      "",
    );
  });

  it("rebuilds Code Review authority from the selected Run Query View", async () => {
    const codeReview: CodeReviewView = {
      id: "code-review-1",
      topicId: "code-review-topic-1",
      manifest: {
        schemaVersion: 1,
        projectId: "project-1",
        runId: "run-1",
        snapshotRevisionId: "snapshot-1",
        workPackageId: "work-package-1",
        workPackageVersionId: "work-package-version-1",
        assignmentId: "assignment-1",
        nodeRunId: "node-run-1",
        nodeAttemptId: "node-attempt-1",
        repositoryReference: "/tmp/repository",
        baseCommit: "a".repeat(40),
        workspaceImportId: "workspace-import-1",
        sourceCommit: "b".repeat(40),
        diffArtifactVersionId: "diff-artifact-version-1",
        diffHash: "c".repeat(64),
        specRevisionIds: ["application-spec:r1"],
        harnessSnapshotIds: ["harness:tdd@1"],
        acceptanceCriteria: ["Independent PASS gates Integration."],
        selfCheck: {
          id: "self-check-1",
          hash: "d".repeat(64),
          commands: ["npm test"],
          logRefs: ["artifact:self-check-log"],
          evidenceRefs: ["artifact:self-check-evidence"],
        },
        permissions: ["repository.read"],
        errorHandlingInputs: [],
        crossApplicationImpactInputs: [],
        excludedContext: ["producer-workspace"],
      },
      manifestHash: "e".repeat(64),
      workspace: {
        id: "reviewer-workspace-1",
        operationKey: "code-review:code-review-1:workspace",
        state: "ready",
        reviewerAiMemberId: "reviewer-member",
        reviewerPositionId: "reviewer-position",
        reviewerSessionId: "reviewer-session-1",
        reviewNodeRunId: "code-review-node-1",
        providerId: "isolated-reviewer",
        workspaceRef: "reviewer-workspace:1",
        capabilitySnapshotHash: "f".repeat(64),
        independenceEvidenceHash: "1".repeat(64),
        failureCode: null,
        failureMessage: null,
      },
      gateResult: null,
      authority: null,
      defects: [],
      integrationEligible: false,
    };
    const queries: unknown[] = [];
    const loaded = await inspectProjectRunCodeReviews(
      {
        query: async (query) => {
          queries.push(query);
          return { view: [codeReview] };
        },
      },
      "run-1",
    );

    assert.deepEqual(queries, [
      { type: "code-reviews.inspect", runId: "run-1" },
    ]);
    assert.equal(loaded[0]?.manifest.sourceCommit, "b".repeat(40));
    const markup = renderToStaticMarkup(
      <CodeReviewAuthorityPanel reviews={loaded} />,
    );
    assert.match(markup, /data-code-review-authority/);
    assert.match(markup, /work-package-version-1/);
    assert.match(markup, /Awaiting independent PASS/);

    const failed = await inspectProjectRunCodeReviews(
      {
        query: async () => {
          throw new Error("query failed");
        },
      },
      "run-1",
    );
    assert.deepEqual(failed, []);
  });

  it("mounts authoritative Integration Generations on the selected Run Reviews tab", async (context) => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web"],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const selectedRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: { ...scriptedDepartmentRun.run, status: "completed" },
    };
    const integrationGeneration = {
      id: "integration-generation-1",
      manifest: {
        generation: 1,
        coverageId: "coverage-1",
        snapshotRevisionId: selectedRun.snapshot.id,
      },
      manifestHash: "a".repeat(64),
      state: "passed",
      repositoryResults: [
        {
          id: "repository-result-1",
          repositoryReference: "/work/checkout-web",
          state: "succeeded",
          expectedTip: "b".repeat(40),
          integratedCommit: "c".repeat(40),
          validationRecords: [
            {
              validationId: "validation-1",
              kind: "build-test",
              status: "passed",
            },
          ],
        },
      ],
      operations: [{ state: "succeeded" }],
      defects: [],
      aggregateReview: { result: "PASS" },
    } as unknown as IntegrationGenerationView;
    const queries: unknown[] = [];
    let openCount = 0;
    let closeCount = 0;
    const bridge = {
      query: async (query: {
        readonly type: string;
        readonly runId?: string;
      }) => {
        queries.push(query);
        if (query.type === "product.discovery.inspect") {
          return {
            view: {
              project: {
                id: project.id,
                name: project.name,
                goal: project.goal,
                revision: 1,
              },
              proposal: null,
              baselines: [],
              formalRuns: [],
            },
          };
        }
        if (query.type === "work-packages.inspect") {
          return {
            view: {
              projectId: project.id,
              runId: selectedRun.run.id,
              technicalBaselineId: "baseline-1",
              packages: [],
            },
          };
        }
        if (query.type === "code-reviews.inspect") return { view: [] };
        if (query.type === "integration-generations.inspect") {
          return {
            view: [integrationGeneration],
            asOfSequence: 1,
            viewSyncToken: "view-token-1",
          };
        }
        throw new Error(`Unexpected query ${query.type}`);
      },
      execute: async () => ({
        status: "succeeded",
        value: {
          acknowledged: true,
          subscriptionGeneration: 1,
          barrierSequence: 1,
          auditId: "audit-1",
        },
        effectIds: [],
      }),
      openEventStream: async () => {
        openCount += 1;
        return {
          subscriptionId: "subscription-1",
          subscriptionGeneration: 1,
          barrierSequence: 1,
        };
      },
      closeEventStream: async () => {
        closeCount += 1;
      },
      runtime: {
        departments: async () => [],
        runs: async () => [selectedRun],
        inspectAgentCatalog: async () => ({ agents: [] }),
        artifacts: async () => [],
        reviewTopics: async () => [],
        interactions: async () => [],
      },
    } as unknown as Window["sandcastle"];
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    Object.defineProperty(dom.window, "sandcastle", {
      configurable: true,
      value: bridge,
    });
    const domGlobals = {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    } as const;
    const previousGlobals = new Map(
      Object.keys(domGlobals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(domGlobals)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    context.after(async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    });

    await act(async () => {
      root.render(
        <ProjectDetailView
          initialTab="reviews"
          onArchive={async () => project}
          onBack={() => undefined}
          onSave={async () => project}
          project={project}
          t={messages.en}
        />,
      );
    });
    await act(async () => undefined);

    assert.equal(openCount, 1);
    assert.equal(
      queries.filter(
        (query) =>
          typeof query === "object" &&
          query !== null &&
          "type" in query &&
          query.type === "integration-generations.inspect",
      ).length,
      1,
    );
    assert.match(
      container.innerHTML,
      /data-integration-generation="integration-generation-1"/,
    );
    assert.match(container.innerHTML, /Aggregate review: PASS/);

    await act(async () => root.unmount());
    assert.equal(closeCount, 1);
  });

  it("loads the selected Run Work Package graph through Project Detail and clears it after a failed replacement query", async (context) => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web"],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const replacementProject = {
      ...project,
      id: "project-2",
      name: "Billing",
    };
    const runFor = (projectId: string, runId: string): DepartmentRunView => ({
      ...scriptedDepartmentRun,
      run: {
        ...scriptedDepartmentRun.run,
        id: runId,
        projectId,
        status: "completed",
      },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          project: {
            ...scriptedDepartmentRun.snapshot.payload.project,
            id: projectId,
          },
        },
      },
      nodes: scriptedDepartmentRun.nodes.map((node) => ({
        ...node,
        runId,
      })),
    });
    const runs = new Map([
      ["project-1", runFor("project-1", "run-1")],
      ["project-2", runFor("project-2", "run-2")],
    ]);
    const queries: unknown[] = [];
    const bridge = {
      query: async (query: {
        readonly type: string;
        readonly runId?: string;
        readonly projectId?: string;
      }) => {
        queries.push(query);
        if (query.type === "product.discovery.inspect") {
          return {
            view: {
              project: {
                id: query.projectId!,
                name: query.projectId === "project-1" ? "Checkout" : "Billing",
                goal: "Ship",
                revision: 1,
              },
              proposal: null,
              baselines: [],
              formalRuns: [],
            },
          };
        }
        if (query.type === "work-packages.inspect" && query.runId === "run-1") {
          return {
            view: {
              projectId: "project-1",
              runId: "run-1",
              technicalBaselineId: "technical-baseline-1",
              packages: [],
            },
          };
        }
        throw new Error("query failed");
      },
      runtime: {
        departments: async () => [],
        runs: async (projectId: string) => [runs.get(projectId)!],
        inspectAgentCatalog: async () => ({ agents: [] }),
        artifacts: async () => [],
        reviewTopics: async () => [],
        interactions: async () => [],
      },
    } as unknown as Window["sandcastle"];
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    Object.defineProperty(dom.window, "sandcastle", {
      configurable: true,
      value: bridge,
    });
    const domGlobals = {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    } as const;
    const previousGlobals = new Map(
      Object.keys(domGlobals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(domGlobals)) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value,
      });
    }
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    context.after(async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    });

    const workPackageQueries = () =>
      queries.filter(
        (query): query is { readonly type: string; readonly runId: string } =>
          typeof query === "object" &&
          query !== null &&
          "type" in query &&
          query.type === "work-packages.inspect",
      );
    await act(async () => {
      root.render(
        <ProjectDetailView
          project={project}
          t={messages.en}
          initialTab="runs"
          onBack={() => undefined}
          onSave={async () => project}
          onArchive={async () => project}
        />,
      );
    });

    await act(async () => {
      assert.deepEqual(workPackageQueries(), [
        { type: "work-packages.inspect", runId: "run-1" },
      ]);
      assert.equal(
        container.querySelectorAll("[data-work-package-graph]").length,
        1,
      );
    });

    await act(async () => {
      root.render(
        <ProjectDetailView
          project={replacementProject}
          t={messages.en}
          initialTab="runs"
          onBack={() => undefined}
          onSave={async () => replacementProject}
          onArchive={async () => replacementProject}
        />,
      );
    });

    await act(async () => {
      assert.deepEqual(workPackageQueries(), [
        { type: "work-packages.inspect", runId: "run-1" },
        { type: "work-packages.inspect", runId: "run-2" },
      ]);
      assert.equal(
        container.querySelectorAll("[data-work-package-graph]").length,
        0,
      );
    });
  });
});

describe("Agent Interaction workspace", () => {
  it("confirms the exact Runtime Product Proposal and re-queries authoritative Baseline/Run state", async () => {
    const awaiting = {
      project: { id: "project-1", name: "Checkout", goal: "Ship", revision: 1 },
      proposal: {
        id: "proposal-1",
        projectId: "project-1",
        status: "awaiting-confirmation" as const,
        revision: 2,
        currentRevision: {
          id: "proposal-r1",
          revision: 1,
          hash: "a".repeat(64),
          content: {
            goal: "Ship",
            users: ["Customers"],
            scope: ["Checkout"],
            nonGoals: [],
            acceptanceCriteria: ["One order"],
            constraints: ["Local-first"],
            risks: ["Retries"],
            openQuestions: [],
          },
          producer: {
            aiMemberId: "product-planner-member",
            positionId: "product-planner",
            sessionId: "session-1",
          },
          editedBy: {
            type: "human" as const,
            id: "local-user",
            authenticatedBy: "local-session" as const,
          },
          createdAt: "2026-07-15T00:00:00.000Z",
        },
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:01:00.000Z",
      },
      baselines: [],
      formalRuns: [],
    };
    const confirmed = {
      ...awaiting,
      proposal: { ...awaiting.proposal, status: "confirmed" as const },
      baselines: [
        {
          id: "baseline-1",
          projectId: "project-1",
          sourceProposalRevisionId: "proposal-r1",
          sourceProposalHash: "a".repeat(64),
          content: awaiting.proposal.currentRevision.content,
          hash: "a".repeat(64),
          confirmedBy: {
            type: "human" as const,
            id: "local-user",
            authenticatedBy: "local-session" as const,
          },
          confirmationCommandId: "confirm-1",
          confirmedAt: "2026-07-15T00:02:00.000Z",
          runId: "run-1",
          snapshotRevisionId: "snapshot-r1",
        },
      ],
      formalRuns: [
        {
          runId: "run-1",
          productBaselineId: "baseline-1",
          snapshotRevisionId: "snapshot-r1",
          parentRunId: null,
          forkedFromSnapshotRevisionId: null,
          status: "ready",
          createdAt: "2026-07-15T00:02:00.000Z",
        },
      ],
    };
    const queries: unknown[] = [];
    const commands: unknown[] = [];
    const bridge = {
      query: async (query: unknown) => {
        queries.push(query);
        return {
          view: queries.length === 1 ? awaiting : confirmed,
          asOfSequence: queries.length,
        };
      },
      execute: async (command: unknown) => {
        commands.push(command);
        return { status: "succeeded", value: confirmed, effectIds: [] };
      },
    } as unknown as Parameters<typeof confirmProjectProductBaseline>[0];

    const result = await confirmProjectProductBaseline(
      bridge,
      "project-1",
      "software-rnd",
      {
        agentOverrideId: "claude-code",
        forkSourceRunId: "run-0",
        forkSourceSnapshotRevisionId: "snapshot-r0",
      },
    );

    assert.equal(result.baselines[0]?.runId, "run-1");
    assert.equal(queries.length, 2);
    assert.equal(commands.length, 1);
    assert.deepEqual(
      (commands[0] as { readonly expectedRevision: number }).expectedRevision,
      2,
    );
    assert.deepEqual((commands[0] as { readonly command: unknown }).command, {
      type: "confirm-product-baseline",
      projectId: "project-1",
      departmentId: "software-rnd",
      agentOverrideId: "claude-code",
      forkSourceRunId: "run-0",
      forkSourceSnapshotRevisionId: "snapshot-r0",
      proposalRevisionId: "proposal-r1",
      proposalHash: "a".repeat(64),
    });
  });

  it("coalesces concurrent Project confirmation into one Department Run start", async () => {
    let startCalls = 0;
    let executeCalls = 0;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startedRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: { ...scriptedDepartmentRun.run, id: "run-confirm", revision: 0 },
    };
    const advancedRun: DepartmentRunView = {
      ...startedRun,
      run: { ...startedRun.run, revision: 6, status: "waiting-approval" },
    };
    const runtime = {
      startRun: async () => {
        startCalls += 1;
        await startGate;
        return startedRun;
      },
      executeReady: async () => {
        executeCalls += 1;
        return advancedRun;
      },
    } as unknown as Parameters<typeof startProjectDepartmentRun>[0];

    const first = startProjectDepartmentRun(
      runtime,
      "project-confirm",
      "software-rnd",
    );
    const second = startProjectDepartmentRun(
      runtime,
      "project-confirm",
      "software-rnd",
    );
    releaseStart();

    assert.equal((await first).run.id, "run-confirm");
    assert.equal((await second).run.id, "run-confirm");
    assert.equal(startCalls, 1);
    assert.equal(executeCalls, 1);
  });

  it("keeps Project Consultation informal and prevents a formal Run before explicit confirmation", () => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web"],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <ProjectDetailView
        project={project}
        t={messages.en}
        initialTab="consultation"
        onBack={() => undefined}
        onSave={async () => project}
        onArchive={async () => project}
      />,
    );

    assert.match(markup, /data-project-consultation/);
    assert.match(markup, /data-consultation-mode="informal"/);
    assert.match(markup, /data-consultation-start/);
    assert.match(markup, /data-consultation-confirm/);
    assert.doesNotMatch(markup, /data-run-collaboration-workspace/);
  });

  it("renders formal collaboration with Department Run, Snapshot, and Current Node context", () => {
    const interaction = {
      session: {
        id: "session-1",
        mode: "run-collaboration" as const,
        projectId: "project-1",
        runId: "run-1",
        nodeRunId: "node-run-1",
        status: "active" as const,
        createdAt: "2026-07-15T00:00:00.000Z",
        closedAt: null,
      },
      participants: [],
      messages: [],
      turns: [],
      permissions: [
        {
          id: "permission-1",
          sessionId: "session-1",
          runId: "run-1",
          nodeRunId: "node-run-start",
          scope: "artifact:write",
          status: "pending" as const,
          expiresAt: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          decidedAt: null,
        },
        {
          id: "permission-2",
          sessionId: "session-1",
          runId: "run-1",
          nodeRunId: "node-run-start",
          scope: "repository.read",
          status: "approved" as const,
          expiresAt: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          decidedAt: "2026-07-15T00:01:00.000Z",
        },
        {
          id: "permission-3",
          sessionId: "session-1",
          runId: "run-1",
          nodeRunId: "node-run-start",
          scope: "repository.delete",
          status: "denied" as const,
          expiresAt: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          decidedAt: "2026-07-15T00:02:00.000Z",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <RunCollaborationWorkspace
        artifacts={[
          {
            id: "artifact-version-1",
            artifactId: "artifact-1",
            projectId: "project-1",
            type: "technical-plan",
            schemaVersion: "1",
            logicalName: "technical-plan.md",
            version: 1,
            contentRef: ".sandcastle/artifacts/technical-plan.md",
            contentHash: "a".repeat(64),
            byteSize: 128,
            status: "produced",
            producer: {
              runId: "run-1",
              nodeRunId: "node-run-start",
              nodeAttemptId: "attempt-1",
              snapshotRevisionId: "snapshot-1",
              aiMemberId: "member-1",
            },
            createdAt: "2026-07-15T00:00:00.000Z",
          },
        ]}
        collaboration={interaction}
        consultation={{
          ...interaction,
          session: {
            ...interaction.session,
            id: "consultation-1",
            mode: "consultation",
            runId: null,
            nodeRunId: null,
            status: "closed",
          },
        }}
        busy={false}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onDecision={() => undefined}
        onRetryApproval={() => undefined}
        onRetry={() => undefined}
        onFork={() => undefined}
        onPermissionDecision={() => undefined}
        onPermissionRequest={() => undefined}
        onSend={() => undefined}
        run={scriptedDepartmentRun}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-run-collaboration-workspace/);
    assert.match(markup, /data-run-collaboration-sessions/);
    assert.match(markup, /data-run-collaboration-conversation/);
    assert.match(markup, /data-run-collaboration-evidence/);
    assert.match(markup, /data-consultation-readonly/);
    assert.match(markup, /data-permission-request="permission-1"/);
    assert.match(markup, /data-permission-status-icon="pending"/);
    assert.match(markup, /data-permission-status-icon="approved"/);
    assert.match(markup, /data-permission-status-icon="denied"/);
    assert.match(markup, /data-run-artifact="artifact-version-1"/);
    assert.match(markup, /data-run-context-run="run-1"/);
    assert.match(markup, /data-run-context-snapshot="snapshot-1"/);
    assert.match(markup, /data-run-context-node="node-run-start"/);
  });

  it("uses accessible local SVG icons for domain and utility actions", () => {
    const markup = renderToStaticMarkup(
      <>
        <Icon name="project" size={24} />
        <Icon name="approval" size={20} />
        <IconButton label="Refresh runs" icon="refresh" />
      </>,
    );
    assert.match(markup, /data-icon="project"/);
    assert.match(markup, /data-icon="approval"/);
    assert.match(markup, /aria-label="Refresh runs"/);
    assert.match(markup, /data-icon-button/);
    assert.match(markup, /<svg/);
    assert.doesNotMatch(markup, /[🔍✕⟳✅]/u);
  });

  it("localizes persisted Agent execution status outside the chat transcript", () => {
    assert.equal(
      interactionStatusLabel(messages.zh, "Agent is processing this message."),
      "Agent 正在处理这条消息…",
    );
    assert.equal(
      interactionStatusLabel(
        messages.zh,
        "Agent execution failed: provider unavailable\nWARN noisy detail",
      ),
      "Agent 执行失败: provider unavailable",
    );
  });

  it("sends a human prompt through the Agent execution command", async () => {
    const calls: Array<Record<string, string>> = [];
    const interaction = {
      session: {
        id: "session-1",
        mode: "consultation" as const,
        projectId: "project-1",
        runId: null,
        nodeRunId: null,
        status: "active" as const,
        createdAt: "2026-07-15T00:00:00.000Z",
        closedAt: null,
      },
      participants: [
        {
          id: "human-1",
          sessionId: "session-1",
          participantType: "human" as const,
          participantRef: "user-local",
          role: "requester",
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      messages: [],
      turns: [],
      permissions: [],
    };
    const runtime = {
      promptInteraction: async (input: Record<string, string>) => {
        calls.push(input);
        return {
          id: "turn-1",
          sessionId: "session-1",
          inputMessageId: "message-1",
          outputMessageId: null,
          status: "queued" as const,
          commandId: "command-1",
          executionOperationKey: "interaction-turn:turn-1",
          executionLeaseId: null,
          executionEpoch: null,
          fenceToken: null,
          mechanism: "model-only" as const,
          mechanismVersion: "1",
          contextHash: "a".repeat(64),
          contextSchemaHash: "b".repeat(64),
          terminalExecutionFactId: null,
          providerExecutionRef: null,
          failureCode: null,
          failureMessage: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
        };
      },
      inspectInteraction: async () => interaction,
    };

    await promptInteractionSession(runtime, interaction, " 你好 ");

    assert.deepEqual(calls, [
      {
        sessionId: "session-1",
        participantId: "human-1",
        content: "你好",
      },
    ]);
  });

  it("makes a closed Session visibly non-interactive", () => {
    assert.equal(
      interactionSessionCloseLabel(messages.en, "active"),
      "Close session",
    );
    assert.equal(
      interactionSessionCloseLabel(messages.en, "closed"),
      "Session closed",
    );
  });

  it("loads governed and legacy Memory with interactions and Department Runs", async () => {
    const calls: string[] = [];
    const runtime = {
      interactions: async (projectId: string) => {
        calls.push(`interactions:${projectId}`);
        return [];
      },
      memoryCandidates: async (projectId: string) => {
        calls.push(`memory-candidates:${projectId}`);
        return [];
      },
      memoryEntries: async (projectId: string) => {
        calls.push(`memory-entries:${projectId}`);
        return [];
      },
      legacyMemoryRecords: async (projectId: string) => {
        calls.push(`memory-legacy:${projectId}`);
        return [];
      },
      runs: async (projectId: string) => {
        calls.push(`runs:${projectId}`);
        return [];
      },
    } as unknown as Parameters<typeof loadInteractionProjectContext>[0];

    const context = await loadInteractionProjectContext(runtime, "project-1");

    assert.deepEqual(context, {
      sessions: [],
      memoryCandidates: [],
      memoryEntries: [],
      legacyMemoryRecords: [],
      runs: [],
    });
    assert.deepEqual(calls.sort(), [
      "interactions:project-1",
      "memory-candidates:project-1",
      "memory-entries:project-1",
      "memory-legacy:project-1",
      "runs:project-1",
    ]);
  });

  it("renders durable Memory decision, Gate, and Entry identity after reload", () => {
    assert.equal(
      memoryCandidateDecisionLabel(
        {
          id: "memory-candidate-1",
          projectId: "project-1",
          scope: "project",
          aiMemberId: null,
          status: "accepted",
          revision: 1,
          currentRevision: {
            id: "memory-candidate-r1",
            revision: 1,
            supersedesRevisionId: null,
            content: "Use exact reviewed evidence.",
            hash: "a".repeat(64),
            redactionPolicy: {
              version: "redaction-v1",
              hash: "b".repeat(64),
            },
            sourceArtifactVersions: [
              { id: "artifact-r1", hash: "c".repeat(64) },
            ],
            sourceEventRanges: [
              { runId: "run-1", fromSequence: 1, toSequence: 2 },
            ],
            producer: {
              aiMemberId: "member-1",
              positionId: "position-1",
              sessionId: "session-1",
            },
            createdAt: "2026-07-27T00:00:00.000Z",
          },
          reviewTopicId: "memory-topic-1",
          decision: {
            id: "memory-decision-1",
            candidateRevisionId: "memory-candidate-r1",
            candidateRevisionHash: "a".repeat(64),
            qualityGateResultId: "memory-gate-1",
            decision: "accepted",
            decidedBy: {
              type: "human",
              id: "local-user",
              authenticatedBy: "local-session",
            },
            createdAt: "2026-07-27T00:01:00.000Z",
            entryId: "memory-entry-1",
          },
          createdAt: "2026-07-27T00:00:00.000Z",
          updatedAt: "2026-07-27T00:01:00.000Z",
        },
        messages.en.none,
      ),
      "accepted · gate memory-gate-1 · entry memory-entry-1",
    );
  });

  it("cleans up the live Run polling timer", () => {
    let timerCallback: (() => void) | undefined;
    let cleared: ReturnType<Window["setInterval"]> | undefined;
    const stop = startRunProgressPolling(() => undefined, {
      setInterval: (callback, delay) => {
        timerCallback =
          typeof callback === "function" ? (callback as () => void) : undefined;
        assert.equal(delay, RUN_PROGRESS_POLL_INTERVAL_MS);
        return 42 as unknown as ReturnType<Window["setInterval"]>;
      },
      clearInterval: (timer) => {
        cleared = timer;
      },
    });

    assert.ok(timerCallback);
    stop();
    assert.equal(cleared, 42);
  });

  it("coalesces concurrent Run Collaboration rebinds and reuses the restored current-node Session", async () => {
    const collaborationRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: { ...scriptedDepartmentRun.run, status: "running" },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          pipelineVersion: {
            ...scriptedDepartmentRun.snapshot.payload.pipelineVersion,
            graph: {
              nodes: [
                {
                  id: "start",
                  type: "start",
                  name: "Start",
                  positionId: "engineer",
                },
                { id: "complete", type: "complete", name: "Complete" },
              ],
              edges: [{ from: "start", to: "complete" }],
            },
          },
          positions: [
            {
              id: "engineer",
              revision: 1,
              name: "Software Engineer",
              responsibility: "Implement the change",
              defaultAgentId: "codex",
              resolvedAgentId: "codex",
              agentSource: "position-default",
              skillIds: [],
              aiMember: {
                id: "engineer-member",
                displayName: "Ada",
                profile: "",
                responsibilityMetadata: {},
                status: "active",
              },
            },
          ],
        },
      },
      nodes: [
        { ...scriptedDepartmentRun.nodes[0]!, status: "running" },
        scriptedDepartmentRun.nodes[1]!,
      ],
    };
    const participantInputs: Array<Record<string, string>> = [];
    let sessionCreated = false;
    const existingInteraction = {
      session: {
        id: "session-1",
        mode: "run-collaboration" as const,
        projectId: "project-1",
        runId: "run-1",
        nodeRunId: "node-run-start",
        status: "active" as const,
        createdAt: "2026-07-15T00:00:00.000Z",
        closedAt: null,
      },
      participants: [],
      messages: [],
      turns: [],
      permissions: [],
    };
    const runtime = {
      interactions: async () => (sessionCreated ? [existingInteraction] : []),
      createInteractionSession: async (input: Record<string, string>) => {
        participantInputs.push({ session: "create", ...input });
        sessionCreated = true;
        return existingInteraction.session;
      },
      addInteractionParticipant: async (input: Record<string, string>) => {
        participantInputs.push(input);
        return {
          id: `participant-${participantInputs.length}`,
          sessionId: "session-1",
          participantType: input.participantType as "human" | "ai-member",
          participantRef: input.participantRef,
          role: input.role,
          createdAt: "2026-07-15T00:00:00.000Z",
        };
      },
      inspectInteraction: async () => existingInteraction,
    } as unknown as Parameters<typeof createRunCollaborationSession>[0];

    const [first, second] = await Promise.all([
      createRunCollaborationSession(runtime, "project-1", collaborationRun),
      createRunCollaborationSession(runtime, "project-1", collaborationRun),
    ]);

    assert.equal(first?.session.id, "session-1");
    assert.equal(second?.session.id, "session-1");
    const restored = await createRunCollaborationSession(
      runtime,
      "project-1",
      collaborationRun,
    );
    assert.equal(restored?.session.id, "session-1");

    assert.deepEqual(participantInputs, [
      {
        session: "create",
        projectId: "project-1",
        mode: "run-collaboration",
        runId: "run-1",
        nodeRunId: "node-run-start",
      },
      {
        sessionId: "session-1",
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      },
      {
        sessionId: "session-1",
        participantType: "ai-member",
        participantRef: "engineer-member",
        role: "current-node-agent",
      },
    ]);
  });

  it("renders the PRD AI Member conversation workspace instead of a Runtime event debugger", () => {
    const markup = renderToStaticMarkup(
      <CompanyInteractionPage t={messages.en} />,
    );

    assert.match(markup, /data-interaction-member-directory/);
    assert.match(markup, /data-interaction-conversation/);
    assert.match(markup, /data-interaction-context/);
    assert.match(markup, /class="primary-button"/);
    assert.doesNotMatch(markup, /AG-UI: RAW_RUNTIME_EVENT/);
  });

  it("keeps interaction context rows single-column and renders active Run progress", () => {
    const activeRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: { ...scriptedDepartmentRun.run, status: "running" },
    };
    const markup = renderToStaticMarkup(
      <>
        <CompanyInteractionPage t={messages.en} />
        <InteractionRunPanel
          currentRunId={activeRun.run.id}
          onCollaborate={() => undefined}
          onSelectRun={() => undefined}
          runs={[activeRun]}
          selectedRunId={activeRun.run.id}
          t={messages.en}
        />
      </>,
    );

    assert.match(markup, /class="interaction-context-list"/);
    assert.match(markup, /class="interaction-context-item"/);
    assert.match(markup, /data-interaction-active-run/);
    assert.match(markup, /data-interaction-run-progress/);
    assert.match(markup, /data-interaction-current-node/);
  });

  it("shows the latest completed Run when the project has no active Run", () => {
    const completedRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: { ...scriptedDepartmentRun.run, status: "completed" },
      nodes: scriptedDepartmentRun.nodes.map((node) => ({
        ...node,
        status: "succeeded" as const,
      })),
    };
    const markup = renderToStaticMarkup(
      <InteractionRunPanel
        currentRunId={completedRun.run.id}
        onCollaborate={() => undefined}
        onSelectRun={() => undefined}
        runs={[completedRun]}
        selectedRunId={completedRun.run.id}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-interaction-run="run-1"/);
    assert.match(markup, /Completed/);
    assert.match(markup, /2 \/ 2 \(100%\)/);
  });
});
