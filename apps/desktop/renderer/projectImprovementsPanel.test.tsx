import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ImprovementApplicationOperationView,
  ImprovementProposalView,
  StatisticsEvidenceSnapshotView,
  StatisticsInspectInput,
  StatisticsView,
} from "../runtime/interface.js";
import { messages, type Messages } from "./i18n.js";
import { ProjectImprovementsPanel } from "./projectImprovementsPanel.js";

const hash = "a".repeat(64);

const query: StatisticsInspectInput = {
  projectId: "project-1",
  window: {
    kind: "explicit-utc-half-open",
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-02T00:00:00.000Z",
  },
  cohort: { id: "cohort:baseline-quality" },
  comparisonSet: {
    id: "comparison:baseline-quality",
    metricIds: [
      "product-baseline-confirmation-count",
      "product-baseline-confirmation-latency",
      "readiness-blocker-count",
      "review-discussion-round-count",
      "review-finding-count",
      "review-recheck-pass-rate",
    ],
  },
};

const canonicalQuery = {
  ...query,
  catalogVersion: "statistics@1" as const,
  filters: {
    departmentIds: [],
    aiMemberIds: [],
    modelIds: [],
    repositoryIds: [],
    workPackageIds: [],
    pipelineVersionIds: [],
  },
  cohort: {
    id: query.cohort.id,
    filters: {
      departmentIds: [],
      aiMemberIds: [],
      modelIds: [],
      repositoryIds: [],
      workPackageIds: [],
      pipelineVersionIds: [],
    },
  },
};

describe("Project Improvements panel", () => {
  it("renders available zero, incomplete, unavailable, and frozen evidence as distinct authoritative states", () => {
    const view: StatisticsView = {
      query: canonicalQuery,
      asOfSequence: 42,
      observations: [
        {
          metricId: "product-baseline-confirmation-count",
          status: "available",
          measurement: { kind: "count", value: 0 },
          sourceFactFamily: "product-baseline",
          sourceFactRefs: [],
        },
        {
          metricId: "product-baseline-confirmation-latency",
          status: "incomplete",
          reason: "One timestamp pair is invalid.",
          missingFactKinds: ["valid-product-baseline-timestamp-pair"],
          sourceFactFamily: "product-baseline",
          sourceFactRefs: ["product-baseline-1"],
        },
        {
          metricId: "review-recheck-pass-rate",
          status: "unavailable",
          reason: "No authoritative denominator exists.",
          unavailableReasonCode: "missing-denominator-authority",
          sourceFactFamily: "review-recheck",
          sourceFactRefs: [],
        },
      ],
      completeness: {
        status: "incomplete",
        incompleteMetricIds: ["product-baseline-confirmation-latency"],
        unavailableMetricIds: ["review-recheck-pass-rate"],
      },
      generatedAt: "2026-08-04T00:00:00.000Z",
    };
    const evidence: StatisticsEvidenceSnapshotView = {
      id: "statistics-evidence-1",
      query: canonicalQuery,
      queryHash: hash,
      asOfSequence: 42,
      observations: view.observations,
      completeness: view.completeness,
      frozenBy: {
        type: "human",
        id: "verified-local-human",
        authenticatedBy: "local-session",
      },
      hash,
      createdAt: "2026-08-04T00:01:00.000Z",
    };

    const markup = renderToStaticMarkup(
      <ProjectImprovementsPanel
        busy={false}
        diagnostic={null}
        evidence={evidence}
        evidenceSnapshotId={evidence.id}
        onEvidenceSnapshotIdChange={() => undefined}
        onFreeze={() => undefined}
        onInspect={() => undefined}
        onInspectEvidence={() => undefined}
        onWindowChange={() => undefined}
        query={query}
        t={messages.en}
        view={view}
      />,
    );

    assert.match(markup, /data-statistics-catalog="statistics@1"/);
    assert.match(markup, /data-statistics-as-of-sequence="42"/);
    assert.match(
      markup,
      /data-statistics-observation-status="available"[^>]*>[\s\S]*>0</,
    );
    assert.match(markup, /Incomplete: One timestamp pair is invalid\./);
    assert.match(markup, /Unavailable: No authoritative denominator exists\./);
    assert.match(markup, /statistics-evidence-1/);
    assert.match(markup, new RegExp(hash));
    assert.match(markup, /Freeze exact evidence/);
  });

  it("renders the Project Improvements workflow in Chinese", () => {
    const markup = renderToStaticMarkup(
      <ProjectImprovementsPanel
        busy={false}
        diagnostic={null}
        evidence={null}
        evidenceSnapshotId=""
        onEvidenceSnapshotIdChange={() => undefined}
        onFreeze={() => undefined}
        onInspect={() => undefined}
        onInspectEvidence={() => undefined}
        onWindowChange={() => undefined}
        query={query}
        t={messages.zh}
        view={null}
      />,
    );

    assert.match(markup, /统计/);
    assert.match(markup, /检查统计/);
    assert.match(markup, /冻结精确证据/);
    assert.match(markup, /尚未检查统计数据/);
  });

  it("renders strict Improvement proposal authoring and immutable revision history in English and Chinese", () => {
    const evidence: StatisticsEvidenceSnapshotView = {
      id: "statistics-evidence-proposal",
      query: canonicalQuery,
      queryHash: hash,
      asOfSequence: 42,
      observations: [
        {
          metricId: "review-finding-count",
          status: "available",
          measurement: { kind: "count", value: 2 },
          sourceFactFamily: "review-finding",
          sourceFactRefs: ["finding:1", "finding:2"],
        },
      ],
      completeness: {
        status: "complete",
        incompleteMetricIds: [],
        unavailableMetricIds: [],
      },
      frozenBy: {
        type: "runtime-worker",
        id: "runtime-worker:improvements",
        authenticatedBy: "runtime",
      },
      hash,
      createdAt: "2026-08-04T00:01:00.000Z",
    };
    const proposal: ImprovementProposalView = {
      id: "improvement-proposal:1",
      projectId: "project-1",
      departmentId: null,
      currentRevisionId: "improvement-proposal-revision:2",
      currentState: "draft" as const,
      revisions: [
        {
          id: "improvement-proposal-revision:1",
          revision: 1,
          supersedesRevisionId: null,
          content: {
            evidence,
            target: {
              targetKind: "harness" as const,
              ownerId: "harness:review",
              governedHead: { revisionId: null, revisionHash: null },
              content: {
                principles: ["Use exact evidence."],
                constitution: "Review immutable contracts.",
                rules: ["Bind recommendations to frozen evidence."],
                examples: { positive: [], negative: [] },
                impactScope: ["project-1"],
              },
            },
            rootCauseHypothesis: "Review guidance permits moving evidence.",
            impactScope: {
              projectIds: ["project-1"],
              departmentIds: [],
              positionIds: [],
            },
            expectedMetrics: [
              {
                metricId: "review-finding-count" as const,
                direction: "decrease" as const,
              },
            ],
            validationPolicy: {
              metricIds: ["review-finding-count" as const],
              minimumComparableObservations: 1,
            },
            rolloutNotes: "Validate the next cohort.",
            rollbackSource: {
              revisionId: "harness:source",
              revisionHash: hash,
            },
          },
          hash,
          authoredBy: {
            type: "runtime-worker" as const,
            id: "runtime-worker:improvements",
            authenticatedBy: "runtime" as const,
          },
          lifecycle: [
            {
              state: "draft" as const,
              confirmation: null,
              createdAt: "2026-08-04T00:02:00.000Z",
            },
          ],
          decision: null,
          createdAt: "2026-08-04T00:02:00.000Z",
        },
      ],
      nextActions: ["revise" as const, "propose" as const],
      createdAt: "2026-08-04T00:02:00.000Z",
      updatedAt: "2026-08-04T00:02:00.000Z",
    };
    const firstRevision = proposal.revisions[0];
    if (!firstRevision) assert.fail("first proposal revision must exist");
    proposal.revisions.push({
      ...firstRevision,
      id: "improvement-proposal-revision:2",
      revision: 2,
      supersedesRevisionId: "improvement-proposal-revision:1",
      content: {
        ...firstRevision.content,
        rootCauseHypothesis:
          "Review guidance lacks a stable evidence identity.",
      },
    });
    const awaitingConfirmation =
      "I confirm this exact proposal revision, evidence, target head, and Harness content.";
    const proposedProposal: ImprovementProposalView = {
      ...proposal,
      id: "improvement-proposal:proposed",
      currentState: "proposed",
      revisions: proposal.revisions.map((revision, index) =>
        index === proposal.revisions.length - 1
          ? {
              ...revision,
              lifecycle: [
                ...revision.lifecycle,
                {
                  state: "proposed" as const,
                  confirmation: null,
                  createdAt: "2026-08-04T00:03:00.000Z",
                },
              ],
            }
          : revision,
      ),
      nextActions: ["revise", "request-decision"],
    };
    const awaitingProposal: ImprovementProposalView = {
      ...proposal,
      id: "improvement-proposal:awaiting-human",
      currentState: "awaiting-human",
      revisions: proposal.revisions.map((revision, index) =>
        index === proposal.revisions.length - 1
          ? {
              ...revision,
              lifecycle: [
                ...revision.lifecycle,
                {
                  state: "proposed" as const,
                  confirmation: null,
                  createdAt: "2026-08-04T00:03:00.000Z",
                },
                {
                  state: "awaiting-human" as const,
                  confirmation: awaitingConfirmation,
                  createdAt: "2026-08-04T00:04:00.000Z",
                },
              ],
            }
          : revision,
      ),
      nextActions: ["revise", "approve", "reject"],
    };
    const approvedRevision = awaitingProposal.revisions.at(-1);
    if (!approvedRevision) assert.fail("approved revision must exist");
    const decision = {
      id: "improvement-decision:approved",
      proposalId: "improvement-proposal:approved",
      proposalRevisionId: approvedRevision.id,
      proposalRevisionHash: approvedRevision.hash,
      evidenceSnapshotId: evidence.id,
      evidenceSnapshotHash: evidence.hash,
      target: approvedRevision.content.target,
      decision: "approved" as const,
      confirmation: awaitingConfirmation,
      actor: {
        type: "human" as const,
        id: "human:reviewer",
        authenticatedBy: "local-session" as const,
      },
      reason: "The exact Harness revision is bounded and evidence-backed.",
      evidenceRefs: [evidence.id],
      hash,
      createdAt: "2026-08-04T00:05:00.000Z",
    };
    const approvedProposal: ImprovementProposalView = {
      ...awaitingProposal,
      id: "improvement-proposal:approved",
      currentState: "approved",
      revisions: awaitingProposal.revisions.map((revision, index) =>
        index === awaitingProposal.revisions.length - 1
          ? { ...revision, decision }
          : revision,
      ),
      nextActions: ["revise", "apply"],
    };
    const application: ImprovementApplicationOperationView = {
      id: "improvement-application:1",
      projectId: "project-1",
      proposalId: approvedProposal.id,
      proposalRevisionId: approvedRevision.id,
      proposalRevisionHash: approvedRevision.hash,
      approvedDecisionId: decision.id,
      approvedDecisionHash: decision.hash,
      target: approvedRevision.content.target,
      canonicalRequestHash: hash,
      state: "unknown",
      deterministicEffectId: "improvement-effect:harness:1",
      confirmation: "I confirm applying this exact approved revision.",
      reason: "Apply the bounded Harness revision.",
      evidenceRefs: [evidence.id, decision.id],
      appliedBy: decision.actor,
      latestError: {
        code: "IMPROVEMENT_APPLICATION_UNKNOWN",
        message: "The target effect cannot yet be proven exactly.",
      },
      receipts: [],
      observations: [],
      reconciliations: [],
      validations: [],
      rollbacks: [],
      nextActions: ["reconcile"],
      createdAt: "2026-08-04T00:06:00.000Z",
      updatedAt: "2026-08-04T00:06:00.000Z",
    };
    const appliedApplication: ImprovementApplicationOperationView = {
      ...application,
      id: "improvement-application:applied",
      state: "applied",
      latestError: null,
      receipts: [
        {
          id: "improvement-receipt:applied",
          phase: "apply",
          disposition: "applied",
          targetRevision: {
            revisionId: "governed-harness-revision:applied",
            revisionHash: hash,
          },
          evidenceRefs: [evidence.id],
          hash,
          createdAt: "2026-08-04T00:07:00.000Z",
        },
      ],
      nextActions: ["validate", "rollback"],
      updatedAt: "2026-08-04T00:07:00.000Z",
    };
    const validatedApplication: ImprovementApplicationOperationView = {
      ...appliedApplication,
      id: "improvement-application:validated",
      state: "validated",
      validations: [
        {
          id: "improvement-validation:1",
          beforeEvidence: evidence,
          afterEvidence: {
            ...evidence,
            id: "statistics-evidence:after",
            createdAt: "2026-08-05T00:00:00.000Z",
          },
          outcome: "unchanged",
          hash,
          validatedBy: {
            type: "runtime-worker",
            id: "runtime-worker:improvement-validation",
            authenticatedBy: "runtime",
          },
          createdAt: "2026-08-05T00:01:00.000Z",
        },
      ],
      nextActions: ["rollback"],
      updatedAt: "2026-08-05T00:01:00.000Z",
    };
    const render = (t: Messages) =>
      renderToStaticMarkup(
        <ProjectImprovementsPanel
          busy={false}
          diagnostic={null}
          evidence={evidence}
          evidenceSnapshotId={evidence.id}
          onEvidenceSnapshotIdChange={() => undefined}
          onFreeze={() => undefined}
          onInspect={() => undefined}
          onInspectEvidence={() => undefined}
          onWindowChange={() => undefined}
          applications={[application, appliedApplication, validatedApplication]}
          proposals={[
            proposal,
            proposedProposal,
            awaitingProposal,
            approvedProposal,
          ]}
          query={query}
          t={t}
          view={null}
        />,
      );

    const english = render(messages.en);
    const chinese = render(messages.zh);
    assert.match(english, /Improvement proposals/);
    assert.match(english, /Expected and validation metric/);
    assert.match(english, /Select an available metric/);
    assert.match(english, /Harness owner ID/);
    assert.match(english, /Create proposal draft/);
    assert.match(english, /Create revised draft/);
    assert.match(english, /Propose exact revision/);
    assert.match(english, /Decision confirmation/);
    assert.match(english, /Request exact human decision/);
    assert.match(english, /Requested confirmation/);
    assert.match(english, new RegExp(awaitingConfirmation));
    assert.match(english, /Decision reason/);
    assert.match(english, /Approve exact revision/);
    assert.match(english, /Reject exact revision/);
    assert.match(english, /Application operation ID/);
    assert.match(english, /Apply exact approved revision/);
    assert.match(english, /Application operations/);
    assert.match(english, /Unknown outcome/);
    assert.match(english, /Inspect exact effect again/);
    assert.match(english, /After evidence snapshot/);
    assert.match(english, /Validate exact comparable evidence/);
    assert.match(english, /Validation outcome/);
    assert.match(english, /Unchanged/);
    assert.match(english, /runtime-worker:improvement-validation/);
    assert.match(english, /IMPROVEMENT_APPLICATION_UNKNOWN/);
    assert.match(english, /improvement-proposal-revision:1/);
    assert.match(english, /improvement-proposal-revision:2/);
    assert.match(english, /statistics-evidence-proposal/);
    assert.match(english, /Review guidance lacks a stable evidence identity/);
    assert.match(chinese, /改进提案/);
    assert.match(chinese, /预期与验证指标/);
    assert.match(chinese, /选择可用指标/);
    assert.match(chinese, /Harness 所有者 ID/);
    assert.match(chinese, /创建提案草稿/);
    assert.match(chinese, /创建修订草稿/);
    assert.match(chinese, /提交精确修订版/);
    assert.match(chinese, /决定确认文本/);
    assert.match(chinese, /请求精确人工决定/);
    assert.match(chinese, /请求时确认文本/);
    assert.match(chinese, /决定理由/);
    assert.match(chinese, /批准精确修订版/);
    assert.match(chinese, /拒绝精确修订版/);
    assert.match(chinese, /应用操作 ID/);
    assert.match(chinese, /应用精确的已批准修订版/);
    assert.match(chinese, /应用操作/);
    assert.match(chinese, /结果未知/);
    assert.match(chinese, /再次检查精确 effect/);
    assert.match(chinese, /验证后证据快照/);
    assert.match(chinese, /验证精确可比证据/);
    assert.match(chinese, /验证结果/);
    assert.match(chinese, /未变化/);
  });

  it("renders governed execution reliability evidence consistently in English and Chinese", () => {
    const reliabilityQuery = {
      ...canonicalQuery,
      comparisonSet: {
        id: "comparison:execution-reliability",
        metricIds: [
          "governed-execution-concurrency" as const,
          "human-approval-wait" as const,
        ],
      },
    };
    const observations = [
      {
        metricId: "governed-execution-concurrency" as const,
        status: "available" as const,
        measurement: {
          kind: "concurrency" as const,
          maximum: 2,
          intervalCount: 3,
        },
        sourceFactFamily: "execution-lease",
        sourceFactRefs: ["lease-1", "lease-2", "lease-3"],
      },
      {
        metricId: "human-approval-wait" as const,
        status: "available" as const,
        measurement: { kind: "duration" as const, milliseconds: 600_000 },
        sourceFactFamily: "approval",
        sourceFactRefs: ["approval-1"],
      },
    ];
    const view: StatisticsView = {
      query: reliabilityQuery,
      asOfSequence: 43,
      observations,
      completeness: {
        status: "complete",
        incompleteMetricIds: [],
        unavailableMetricIds: [],
      },
      generatedAt: "2026-08-04T00:00:00.000Z",
    };
    const evidence: StatisticsEvidenceSnapshotView = {
      id: "statistics-evidence-reliability",
      query: reliabilityQuery,
      queryHash: hash,
      asOfSequence: 43,
      observations,
      completeness: view.completeness,
      frozenBy: {
        type: "human",
        id: "verified-local-human",
        authenticatedBy: "local-session",
      },
      hash,
      createdAt: "2026-08-04T00:01:00.000Z",
    };
    const render = (t: Messages) =>
      renderToStaticMarkup(
        <ProjectImprovementsPanel
          busy={false}
          diagnostic={null}
          evidence={evidence}
          evidenceSnapshotId={evidence.id}
          onEvidenceSnapshotIdChange={() => undefined}
          onFreeze={() => undefined}
          onInspect={() => undefined}
          onInspectEvidence={() => undefined}
          onWindowChange={() => undefined}
          query={query}
          t={t}
          view={view}
        />,
      );

    const english = render(messages.en);
    const chinese = render(messages.zh);
    assert.match(english, /Governed execution concurrency/);
    assert.match(english, /Human approval wait/);
    assert.match(chinese, /受治理执行并发度/);
    assert.match(chinese, /人工审批等待时间/);
    assert.equal(
      (english.match(/data-statistics-evidence-observation-status/g) ?? [])
        .length,
      2,
    );
    assert.match(english, />2 \/ 3</);
    assert.match(english, />600000 ms</);
  });

  it("renders live and frozen quality, delivery, Memory, and unsupported catalog evidence bilingually", () => {
    const metricIds = [
      "code-review-defect-incidence",
      "complete-model-attribution",
      "delivery-candidate-acceptance-rate",
      "electron-ui-runtime-mismatch-rate",
      "heterogeneous-defect-aggregate-rate",
      "integration-conflict-rate",
      "memory-promotion-rate",
      "memory-selection-rate",
      "release-item-success-rate",
      "security-operability-high-risk-closure-rate",
      "test-pass-rate",
      "whole-run-token-cost",
    ] as const;
    const qualityQuery = {
      ...canonicalQuery,
      comparisonSet: {
        id: "comparison:quality-delivery-memory",
        metricIds: [...metricIds],
      },
    };
    const observations: StatisticsView["observations"] = metricIds.map(
      (metricId) =>
        [
          "complete-model-attribution",
          "heterogeneous-defect-aggregate-rate",
          "security-operability-high-risk-closure-rate",
          "whole-run-token-cost",
        ].includes(metricId)
          ? {
              metricId,
              status: "unavailable" as const,
              reason: "Not supported by statistics@1.",
              unavailableReasonCode: "unsupported-by-statistics-at-1" as const,
              sourceFactFamily: "statistics@1",
              sourceFactRefs: [],
            }
          : {
              metricId,
              status: "available" as const,
              measurement: {
                kind: "rate" as const,
                numerator: metricId === "code-review-defect-incidence" ? 0 : 1,
                denominator:
                  metricId === "code-review-defect-incidence" ? 1 : 2,
                value: metricId === "code-review-defect-incidence" ? 0 : 0.5,
              },
              sourceFactFamily: "authoritative-fact",
              sourceFactRefs: ["fact:1", "fact:2"],
            },
    );
    const view: StatisticsView = {
      query: qualityQuery,
      asOfSequence: 44,
      observations,
      completeness: {
        status: "unavailable",
        incompleteMetricIds: [],
        unavailableMetricIds: [
          "complete-model-attribution",
          "heterogeneous-defect-aggregate-rate",
          "security-operability-high-risk-closure-rate",
          "whole-run-token-cost",
        ],
      },
      generatedAt: "2026-08-04T00:00:00.000Z",
    };
    const evidence: StatisticsEvidenceSnapshotView = {
      id: "statistics-evidence-quality-delivery-memory",
      query: qualityQuery,
      queryHash: hash,
      asOfSequence: 44,
      observations,
      completeness: view.completeness,
      frozenBy: {
        type: "runtime-worker",
        id: "runtime-worker:statistics",
        authenticatedBy: "runtime",
      },
      hash,
      createdAt: "2026-08-04T00:01:00.000Z",
    };
    const render = (t: Messages) =>
      renderToStaticMarkup(
        <ProjectImprovementsPanel
          busy={false}
          diagnostic={null}
          evidence={evidence}
          evidenceSnapshotId={evidence.id}
          onEvidenceSnapshotIdChange={() => undefined}
          onFreeze={() => undefined}
          onInspect={() => undefined}
          onInspectEvidence={() => undefined}
          onWindowChange={() => undefined}
          query={qualityQuery}
          t={t}
          view={view}
        />,
      );

    const english = render(messages.en);
    const chinese = render(messages.zh);
    assert.match(english, /Code Review defect incidence/);
    assert.match(english, /Delivery candidate acceptance rate/);
    assert.match(english, /Electron UI\/Runtime mismatch rate/);
    assert.match(english, /Integration conflict rate/);
    assert.match(english, /Memory promotion rate/);
    assert.match(english, /Memory selection rate/);
    assert.match(english, /Release item success rate/);
    assert.match(english, /Test pass rate/);
    assert.match(english, /Complete Model attribution/);
    assert.match(english, /Heterogeneous Defect aggregate rate/);
    assert.match(english, /Security\/Operability high-risk closure rate/);
    assert.match(english, /Whole-Run Token\/cost/);
    assert.match(chinese, /代码评审缺陷发生率/);
    assert.match(chinese, /交付候选接受率/);
    assert.match(chinese, /Electron 界面\/Runtime 不匹配率/);
    assert.match(chinese, /集成冲突率/);
    assert.match(chinese, /记忆晋升率/);
    assert.match(chinese, /记忆选择率/);
    assert.match(chinese, /发布项成功率/);
    assert.match(chinese, /测试通过率/);
    assert.match(chinese, /完整模型归因/);
    assert.match(chinese, /异构缺陷聚合率/);
    assert.match(chinese, /安全性\/可运维性高风险关闭率/);
    assert.match(chinese, /整次运行 Token\/成本/);
    assert.match(english, />0 \/ 1 \(0%\)</);
    assert.match(english, />1 \/ 2 \(50%\)</);
    assert.match(english, /Unavailable: Not supported by statistics@1\./);
    assert.match(chinese, /不可用: Not supported by statistics@1\./);
    assert.equal(
      (english.match(/data-statistics-observation-status/g) ?? []).length,
      12,
    );
    assert.equal(
      (english.match(/data-statistics-evidence-observation-status/g) ?? [])
        .length,
      12,
    );
  });
});
