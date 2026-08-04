import { useState } from "react";
import type {
  ImprovementApplicationOperationView,
  ImprovementProposalView,
  StatisticsEvidenceSnapshotView,
  StatisticsInspectInput,
  StatisticsMetricId,
  StatisticsMetricObservation,
  StatisticsView,
  StatisticsWindow,
} from "../runtime/interface.js";
import type { Messages } from "./i18n.js";

export interface ImprovementProposalDraft {
  readonly metricId: StatisticsMetricId | "";
  readonly targetOwnerId: string;
  readonly governedHeadRevisionId: string;
  readonly governedHeadRevisionHash: string;
  readonly principle: string;
  readonly constitution: string;
  readonly rule: string;
  readonly rootCauseHypothesis: string;
  readonly rolloutNotes: string;
  readonly rollbackRevisionId: string;
  readonly rollbackRevisionHash: string;
}

const metricLabel = (t: Messages, metricId: StatisticsMetricId): string => {
  const labels: Readonly<Record<StatisticsMetricId, string>> = {
    "product-baseline-confirmation-count":
      t.statisticsMetricBaselineConfirmationCount,
    "product-baseline-confirmation-latency":
      t.statisticsMetricBaselineConfirmationLatency,
    "review-finding-count": t.statisticsMetricReviewFindingCount,
    "review-discussion-round-count":
      t.statisticsMetricReviewDiscussionRoundCount,
    "review-recheck-pass-rate": t.statisticsMetricReviewRecheckPassRate,
    "readiness-blocker-count": t.statisticsMetricReadinessBlockerCount,
    "governed-execution-concurrency":
      t.statisticsMetricGovernedExecutionConcurrency,
    "ordinary-retry-count": t.statisticsMetricOrdinaryRetryCount,
    "recovery-attempt-count": t.statisticsMetricRecoveryAttemptCount,
    "code-review-defect-incidence": t.statisticsMetricCodeReviewDefectIncidence,
    "integration-conflict-rate": t.statisticsMetricIntegrationConflictRate,
    "test-pass-rate": t.statisticsMetricTestPassRate,
    "electron-ui-runtime-mismatch-rate":
      t.statisticsMetricElectronUiRuntimeMismatchRate,
    "department-run-failure-rate": t.statisticsMetricDepartmentRunFailureRate,
    "node-attempt-failure-rate": t.statisticsMetricNodeAttemptFailureRate,
    "lease-interruption-rate": t.statisticsMetricLeaseInterruptionRate,
    "human-approval-wait": t.statisticsMetricHumanApprovalWait,
    "governed-intervention-rate": t.statisticsMetricGovernedInterventionRate,
    "delivery-candidate-acceptance-rate":
      t.statisticsMetricDeliveryCandidateAcceptanceRate,
    "release-item-success-rate": t.statisticsMetricReleaseItemSuccessRate,
    "memory-promotion-rate": t.statisticsMetricMemoryPromotionRate,
    "memory-selection-rate": t.statisticsMetricMemorySelectionRate,
    "security-operability-high-risk-closure-rate":
      t.statisticsMetricSecurityOperabilityHighRiskClosureRate,
    "whole-run-token-cost": t.statisticsMetricWholeRunTokenCost,
    "complete-model-attribution": t.statisticsMetricCompleteModelAttribution,
    "heterogeneous-defect-aggregate-rate":
      t.statisticsMetricHeterogeneousDefectAggregateRate,
  };
  return labels[metricId];
};

const measurementText = (
  observation: Extract<StatisticsMetricObservation, { status: "available" }>,
): string => {
  switch (observation.measurement.kind) {
    case "count":
      return String(observation.measurement.value);
    case "duration":
      return `${observation.measurement.milliseconds} ms`;
    case "rate":
      return `${observation.measurement.numerator} / ${observation.measurement.denominator} (${Math.round(observation.measurement.value * 100)}%)`;
    case "concurrency":
      return `${observation.measurement.maximum} / ${observation.measurement.intervalCount}`;
  }
};

const observationText = (
  t: Messages,
  observation: StatisticsMetricObservation,
): string => {
  if (observation.status === "available") return measurementText(observation);
  return `${observation.status === "incomplete" ? t.statisticsIncomplete : t.statisticsUnavailable}: ${observation.reason}`;
};

const applicationStateLabel = (
  t: Messages,
  state: ImprovementApplicationOperationView["state"],
): string =>
  ({
    applying: t.improvementApplicationStateApplying,
    applied: t.improvementApplicationStateApplied,
    "apply-failed": t.improvementApplicationStateApplyFailed,
    reconciling: t.improvementApplicationStateReconciling,
    unknown: t.improvementApplicationStateUnknown,
    validated: t.improvementApplicationStateValidated,
    "rollback-requested": t.improvementApplicationStateRollbackRequested,
    "rolled-back": t.improvementApplicationStateRolledBack,
    "rollback-failed": t.improvementApplicationStateRollbackFailed,
  })[state];

const validationOutcomeLabel = (
  t: Messages,
  outcome: ImprovementApplicationOperationView["validations"][number]["outcome"],
): string =>
  ({
    improved: t.improvementValidationImproved,
    unchanged: t.improvementValidationUnchanged,
    regressed: t.improvementValidationRegressed,
  })[outcome];

function ImprovementTargetContent({
  target,
}: {
  readonly target: ImprovementProposalView["revisions"][number]["content"]["target"];
}) {
  switch (target.targetKind) {
    case "harness":
      return (
        <div data-improvement-target-content={target.targetKind}>
          {target.content.principles.join(" · ")} ·{" "}
          {target.content.constitution}
        </div>
      );
    case "project-spec":
      return (
        <div data-improvement-target-content={target.targetKind}>
          {target.content.outcome} ·{" "}
          {target.content.acceptanceCriteria.join(" · ")}
        </div>
      );
    case "application-spec":
      return (
        <div data-improvement-target-content={target.targetKind}>
          <span data-improvement-target-lineage>
            {target.content.lineage.projectId} ·{" "}
            {target.content.lineage.applicationId} ·{" "}
            {target.content.lineage.promotedProjectSpecRevisionId} ·{" "}
            {target.content.lineage.promotedProjectSpecHash}
          </span>
          {" · "}
          {target.content.content.design}
        </div>
      );
    case "template":
      return (
        <div data-improvement-target-content={target.targetKind}>
          {target.content.manifest
            .map((file) => `${file.path} · ${file.contentHash}`)
            .join(" · ")}
        </div>
      );
    case "skill-flow":
      return (
        <div data-improvement-target-content={target.targetKind}>
          {target.content.positionId} · {target.content.name} ·{" "}
          {target.content.skillIds.join(" → ")}
        </div>
      );
  }
}

function StatisticsObservations({
  t,
  observations,
  evidence = false,
}: {
  readonly t: Messages;
  readonly observations: readonly StatisticsMetricObservation[];
  readonly evidence?: boolean;
}) {
  return (
    <div className="overview-inventory statistics-observations">
      {observations.map((observation) => (
        <div
          data-statistics-evidence-observation-status={
            evidence ? observation.status : undefined
          }
          data-statistics-metric={observation.metricId}
          data-statistics-observation-status={
            evidence ? undefined : observation.status
          }
          key={observation.metricId}
        >
          <dt>{metricLabel(t, observation.metricId)}</dt>
          <dd>{observationText(t, observation)}</dd>
        </div>
      ))}
    </div>
  );
}

export function ProjectImprovementsPanel({
  t,
  query,
  view,
  evidence,
  evidenceSnapshotId,
  busy,
  diagnostic,
  onWindowChange,
  onEvidenceSnapshotIdChange,
  onInspect,
  onFreeze,
  onInspectEvidence,
  proposals,
  onCreateProposal,
  onReviseProposal,
  onProposeProposal,
  onRequestDecision,
  onDecideProposal,
  applications,
  onApplyProposal,
  onReconcileApplication,
  onValidateApplication,
  onRollbackApplication,
}: {
  readonly t: Messages;
  readonly query: StatisticsInspectInput;
  readonly view: StatisticsView | null;
  readonly evidence: StatisticsEvidenceSnapshotView | null;
  readonly evidenceSnapshotId: string;
  readonly busy: boolean;
  readonly diagnostic: string | null;
  readonly onWindowChange: (window: StatisticsWindow) => void;
  readonly onEvidenceSnapshotIdChange: (value: string) => void;
  readonly onInspect: () => void;
  readonly onFreeze: () => void;
  readonly onInspectEvidence: () => void;
  readonly proposals?: readonly ImprovementProposalView[];
  readonly onCreateProposal?: (draft: ImprovementProposalDraft) => void;
  readonly onReviseProposal?: (
    proposal: ImprovementProposalView,
    draft: ImprovementProposalDraft,
  ) => void;
  readonly onProposeProposal?: (proposal: ImprovementProposalView) => void;
  readonly onRequestDecision?: (
    proposal: ImprovementProposalView,
    confirmation: string,
  ) => void;
  readonly onDecideProposal?: (
    proposal: ImprovementProposalView,
    decision: "approved" | "rejected",
    confirmation: string,
    reason: string,
  ) => void;
  readonly applications?: readonly ImprovementApplicationOperationView[];
  readonly onApplyProposal?: (
    proposal: ImprovementProposalView,
    operationId: string,
    confirmation: string,
    reason: string,
  ) => void;
  readonly onReconcileApplication?: (
    application: ImprovementApplicationOperationView,
  ) => void;
  readonly onValidateApplication?: (
    application: ImprovementApplicationOperationView,
    afterEvidence: StatisticsEvidenceSnapshotView,
    reason: string,
  ) => void;
  readonly onRollbackApplication?: (
    application: ImprovementApplicationOperationView,
    confirmation: string,
    reason: string,
  ) => void;
}) {
  const [proposalDraft, setProposalDraft] = useState<ImprovementProposalDraft>({
    metricId: "",
    targetOwnerId: "",
    governedHeadRevisionId: "",
    governedHeadRevisionHash: "",
    principle: "",
    constitution: "",
    rule: "",
    rootCauseHypothesis: "",
    rolloutNotes: "",
    rollbackRevisionId: "",
    rollbackRevisionHash: "",
  });
  const updateProposalDraft = <Key extends keyof ImprovementProposalDraft>(
    key: Key,
    value: ImprovementProposalDraft[Key],
  ): void => setProposalDraft((current) => ({ ...current, [key]: value }));
  const [decisionConfirmation, setDecisionConfirmation] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [applicationOperationId, setApplicationOperationId] = useState("");
  const [applicationConfirmation, setApplicationConfirmation] = useState("");
  const [applicationReason, setApplicationReason] = useState("");
  const [validationReason, setValidationReason] = useState("");
  const [rollbackConfirmation, setRollbackConfirmation] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const isHash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
  const hasGovernedHead =
    proposalDraft.governedHeadRevisionId.trim().length > 0 ||
    proposalDraft.governedHeadRevisionHash.trim().length > 0;
  const proposalMetricAvailable = evidence?.observations.some(
    (observation) =>
      observation.metricId === proposalDraft.metricId &&
      observation.status === "available",
  );
  const proposalDraftValid =
    proposalMetricAvailable === true &&
    proposalDraft.targetOwnerId.trim().length > 0 &&
    proposalDraft.principle.trim().length > 0 &&
    proposalDraft.constitution.trim().length > 0 &&
    proposalDraft.rule.trim().length > 0 &&
    proposalDraft.rootCauseHypothesis.trim().length > 0 &&
    proposalDraft.rolloutNotes.trim().length > 0 &&
    proposalDraft.rollbackRevisionId.trim().length > 0 &&
    isHash(proposalDraft.rollbackRevisionHash.trim()) &&
    (!hasGovernedHead ||
      (proposalDraft.governedHeadRevisionId.trim().length > 0 &&
        isHash(proposalDraft.governedHeadRevisionHash.trim())));
  return (
    <section className="project-improvements" data-project-improvements>
      <header className="section-heading">
        <div>
          <span className="eyebrow">{t.projectImprovementsTab}</span>
          <h2>{t.statisticsTitle}</h2>
          <p>{t.statisticsBody}</p>
        </div>
      </header>
      {diagnostic ? <div className="warn">{diagnostic}</div> : null}
      <div className="create-panel statistics-query-panel">
        <div className="field-grid two-column">
          <label>
            <span>{t.statisticsWindowStart}</span>
            <input
              disabled={busy}
              onChange={(event) =>
                onWindowChange({
                  ...query.window,
                  startInclusive: event.target.value,
                })
              }
              type="text"
              value={query.window.startInclusive}
            />
          </label>
          <label>
            <span>{t.statisticsWindowEnd}</span>
            <input
              disabled={busy}
              onChange={(event) =>
                onWindowChange({
                  ...query.window,
                  endExclusive: event.target.value,
                })
              }
              type="text"
              value={query.window.endExclusive}
            />
          </label>
        </div>
        <div className="form-actions">
          <button disabled={busy} onClick={onInspect} type="button">
            {t.statisticsInspect}
          </button>
          <button
            className="primary-button"
            disabled={busy || view === null}
            onClick={onFreeze}
            type="button"
          >
            {t.statisticsFreeze}
          </button>
        </div>
      </div>
      {view ? (
        <section
          className="create-panel"
          data-statistics-as-of-sequence={view.asOfSequence}
          data-statistics-catalog={view.query.catalogVersion}
          data-statistics-completeness={view.completeness.status}
        >
          <h3>{t.statisticsLiveView}</h3>
          <p>
            {t.statisticsCatalog}: {view.query.catalogVersion} ·{" "}
            {t.statisticsAsOf} {view.asOfSequence}
          </p>
          <StatisticsObservations observations={view.observations} t={t} />
        </section>
      ) : (
        <div className="empty-state" data-statistics-empty>
          {busy ? t.statisticsLoading : t.statisticsNotInspected}
        </div>
      )}
      <section className="create-panel" data-statistics-evidence-panel>
        <h3>{t.statisticsEvidenceTitle}</h3>
        <label>
          <span>{t.statisticsEvidenceId}</span>
          <input
            disabled={busy}
            onChange={(event) => onEvidenceSnapshotIdChange(event.target.value)}
            type="text"
            value={evidenceSnapshotId}
          />
        </label>
        <button
          disabled={busy || evidenceSnapshotId.trim() === ""}
          onClick={onInspectEvidence}
          type="button"
        >
          {t.statisticsInspectEvidence}
        </button>
        {evidence ? (
          <>
            <dl data-statistics-evidence={evidence.id}>
              <div>
                <dt>{t.statisticsEvidenceId}</dt>
                <dd>{evidence.id}</dd>
              </div>
              <div>
                <dt>{t.statisticsEvidenceHash}</dt>
                <dd>{evidence.hash}</dd>
              </div>
              <div>
                <dt>{t.statisticsAsOf}</dt>
                <dd>{evidence.asOfSequence}</dd>
              </div>
              <div>
                <dt>{t.statisticsFrozenBy}</dt>
                <dd>{evidence.frozenBy.id}</dd>
              </div>
            </dl>
            <StatisticsObservations
              evidence
              observations={evidence.observations}
              t={t}
            />
          </>
        ) : (
          <p>{t.statisticsNoEvidence}</p>
        )}
      </section>
      <section className="create-panel" data-improvement-proposals>
        <h3>{t.improvementProposalsTitle}</h3>
        <p>{t.improvementProposalsBody}</p>
        <div className="field-grid two-column">
          <label>
            <span>{t.improvementValidationMetric}</span>
            <select
              value={proposalDraft.metricId}
              onChange={(event) =>
                updateProposalDraft(
                  "metricId",
                  event.currentTarget.value as StatisticsMetricId | "",
                )
              }
            >
              <option value="">{t.improvementSelectMetric}</option>
              {(evidence?.observations ?? [])
                .filter((observation) => observation.status === "available")
                .map((observation) => (
                  <option
                    key={observation.metricId}
                    value={observation.metricId}
                  >
                    {metricLabel(t, observation.metricId)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>{t.improvementTargetOwner}</span>
            <input
              value={proposalDraft.targetOwnerId}
              onChange={(event) =>
                updateProposalDraft("targetOwnerId", event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementGovernedHeadRevisionId}</span>
            <input
              value={proposalDraft.governedHeadRevisionId}
              onChange={(event) =>
                updateProposalDraft(
                  "governedHeadRevisionId",
                  event.currentTarget.value,
                )
              }
            />
          </label>
          <label>
            <span>{t.improvementGovernedHeadRevisionHash}</span>
            <input
              value={proposalDraft.governedHeadRevisionHash}
              onChange={(event) =>
                updateProposalDraft(
                  "governedHeadRevisionHash",
                  event.currentTarget.value,
                )
              }
            />
          </label>
          <label>
            <span>{t.improvementHarnessPrinciple}</span>
            <input
              value={proposalDraft.principle}
              onChange={(event) =>
                updateProposalDraft("principle", event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementHarnessConstitution}</span>
            <textarea
              value={proposalDraft.constitution}
              onChange={(event) =>
                updateProposalDraft("constitution", event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementHarnessRule}</span>
            <textarea
              value={proposalDraft.rule}
              onChange={(event) =>
                updateProposalDraft("rule", event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementRootCause}</span>
            <textarea
              value={proposalDraft.rootCauseHypothesis}
              onChange={(event) =>
                updateProposalDraft(
                  "rootCauseHypothesis",
                  event.currentTarget.value,
                )
              }
            />
          </label>
          <label>
            <span>{t.improvementRolloutNotes}</span>
            <textarea
              value={proposalDraft.rolloutNotes}
              onChange={(event) =>
                updateProposalDraft("rolloutNotes", event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementRollbackRevisionId}</span>
            <input
              value={proposalDraft.rollbackRevisionId}
              onChange={(event) =>
                updateProposalDraft(
                  "rollbackRevisionId",
                  event.currentTarget.value,
                )
              }
            />
          </label>
          <label>
            <span>{t.improvementRollbackRevisionHash}</span>
            <input
              value={proposalDraft.rollbackRevisionHash}
              onChange={(event) =>
                updateProposalDraft(
                  "rollbackRevisionHash",
                  event.currentTarget.value,
                )
              }
            />
          </label>
        </div>
        <div className="form-actions">
          <button
            disabled={busy || !proposalDraftValid || !onCreateProposal}
            onClick={() => onCreateProposal?.(proposalDraft)}
            type="button"
          >
            {t.improvementCreateDraft}
          </button>
        </div>
        <div className="field-grid two-column">
          <label>
            <span>{t.improvementDecisionConfirmation}</span>
            <textarea
              value={decisionConfirmation}
              onChange={(event) =>
                setDecisionConfirmation(event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementDecisionReason}</span>
            <textarea
              value={decisionReason}
              onChange={(event) => setDecisionReason(event.currentTarget.value)}
            />
          </label>
        </div>
        <div className="field-grid two-column">
          <label>
            <span>{t.improvementApplicationOperationId}</span>
            <input
              id="improvement-application-operation-id"
              value={applicationOperationId}
              onChange={(event) =>
                setApplicationOperationId(event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementApplicationConfirmation}</span>
            <textarea
              id="improvement-application-confirmation"
              value={applicationConfirmation}
              onChange={(event) =>
                setApplicationConfirmation(event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>{t.improvementApplicationReason}</span>
            <textarea
              id="improvement-application-reason"
              value={applicationReason}
              onChange={(event) =>
                setApplicationReason(event.currentTarget.value)
              }
            />
          </label>
        </div>
        <div className="overview-inventory" data-improvement-proposal-history>
          {(proposals ?? []).map((proposal) => {
            const currentRevision = proposal.revisions.find(
              (revision) => revision.id === proposal.currentRevisionId,
            );
            const requestedConfirmation =
              currentRevision?.lifecycle
                .slice()
                .reverse()
                .find((entry) => entry.state === "awaiting-human")
                ?.confirmation ?? null;
            return (
              <article
                data-improvement-proposal={proposal.id}
                key={proposal.id}
              >
                <div className="project-card-top">
                  <strong>{proposal.id}</strong>
                  <span className="pill">{proposal.currentState}</span>
                </div>
                {currentRevision ? (
                  <dl>
                    <div>
                      <dt>{t.improvementRevision}</dt>
                      <dd>
                        {currentRevision.revision} · {currentRevision.hash}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.improvementEvidence}</dt>
                      <dd>
                        {currentRevision.content.evidence.id} ·{" "}
                        {currentRevision.content.evidence.hash}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.improvementTarget}</dt>
                      <dd>
                        {currentRevision.content.target.targetKind} ·{" "}
                        {currentRevision.content.target.ownerId}
                        <ImprovementTargetContent
                          target={currentRevision.content.target}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>{t.improvementRootCause}</dt>
                      <dd>{currentRevision.content.rootCauseHypothesis}</dd>
                    </div>
                    {requestedConfirmation ? (
                      <div>
                        <dt>{t.improvementRequestedConfirmation}</dt>
                        <dd>{requestedConfirmation}</dd>
                      </div>
                    ) : null}
                    {currentRevision.decision ? (
                      <div>
                        <dt>{t.improvementDecisionOutcome}</dt>
                        <dd>
                          {currentRevision.decision.decision === "approved"
                            ? t.improvementDecisionApproved
                            : t.improvementDecisionRejected}
                          {" · "}
                          {currentRevision.decision.reason}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
                <ol data-improvement-revision-timeline>
                  {proposal.revisions.map((revision) => (
                    <li key={revision.id}>
                      {t.improvementRevision} {revision.revision} ·{" "}
                      {revision.id} ·{" "}
                      {revision.lifecycle
                        .map((entry) => entry.state)
                        .join(" → ")}
                    </li>
                  ))}
                </ol>
                <div className="form-actions">
                  {proposal.nextActions.includes("revise") ? (
                    <button
                      disabled={
                        busy || !proposalDraftValid || !onReviseProposal
                      }
                      onClick={() =>
                        onReviseProposal?.(proposal, proposalDraft)
                      }
                      type="button"
                    >
                      {t.improvementReviseDraft}
                    </button>
                  ) : null}
                  {proposal.nextActions.includes("propose") ? (
                    <button
                      disabled={busy || !onProposeProposal}
                      onClick={() => onProposeProposal?.(proposal)}
                      type="button"
                    >
                      {t.improvementPropose}
                    </button>
                  ) : null}
                  {proposal.nextActions.includes("request-decision") ? (
                    <button
                      disabled={
                        busy ||
                        decisionConfirmation.trim().length === 0 ||
                        !onRequestDecision
                      }
                      onClick={() =>
                        onRequestDecision?.(
                          proposal,
                          decisionConfirmation.trim(),
                        )
                      }
                      type="button"
                    >
                      {t.improvementRequestDecision}
                    </button>
                  ) : null}
                  {proposal.nextActions.includes("approve") &&
                  requestedConfirmation ? (
                    <button
                      disabled={
                        busy ||
                        decisionReason.trim().length === 0 ||
                        !onDecideProposal
                      }
                      onClick={() =>
                        onDecideProposal?.(
                          proposal,
                          "approved",
                          requestedConfirmation,
                          decisionReason.trim(),
                        )
                      }
                      type="button"
                    >
                      {t.improvementApprove}
                    </button>
                  ) : null}
                  {proposal.nextActions.includes("reject") &&
                  requestedConfirmation ? (
                    <button
                      disabled={
                        busy ||
                        decisionReason.trim().length === 0 ||
                        !onDecideProposal
                      }
                      onClick={() =>
                        onDecideProposal?.(
                          proposal,
                          "rejected",
                          requestedConfirmation,
                          decisionReason.trim(),
                        )
                      }
                      type="button"
                    >
                      {t.improvementReject}
                    </button>
                  ) : null}
                  {proposal.nextActions.includes("apply") ? (
                    <button
                      data-improvement-apply-proposal={proposal.id}
                      disabled={
                        busy ||
                        applicationOperationId.trim().length === 0 ||
                        applicationConfirmation.trim().length === 0 ||
                        applicationReason.trim().length === 0 ||
                        !onApplyProposal
                      }
                      onClick={() =>
                        onApplyProposal?.(
                          proposal,
                          applicationOperationId.trim(),
                          applicationConfirmation.trim(),
                          applicationReason.trim(),
                        )
                      }
                      type="button"
                    >
                      {t.improvementApplicationApply}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
          {(proposals ?? []).length === 0 ? (
            <p>{t.improvementNoProposals}</p>
          ) : null}
        </div>
      </section>
      <section className="create-panel" data-improvement-applications>
        <h3>{t.improvementApplicationsTitle}</h3>
        <div className="overview-inventory">
          {(applications ?? []).map((application) => (
            <article
              data-improvement-application={application.id}
              key={application.id}
            >
              <div className="project-card-top">
                <strong>{application.id}</strong>
                <span className="pill">
                  {applicationStateLabel(t, application.state)}
                </span>
              </div>
              <dl>
                <div>
                  <dt>{t.improvementRevision}</dt>
                  <dd>
                    {application.proposalRevisionId} ·{" "}
                    {application.proposalRevisionHash}
                  </dd>
                </div>
                <div>
                  <dt>{t.improvementTarget}</dt>
                  <dd>
                    {application.target.targetKind} ·{" "}
                    {application.target.ownerId}
                    <ImprovementTargetContent target={application.target} />
                  </dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationState}</dt>
                  <dd>{applicationStateLabel(t, application.state)}</dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationEffect}</dt>
                  <dd>{application.deterministicEffectId}</dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationConfirmation}</dt>
                  <dd>{application.confirmation}</dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationReason}</dt>
                  <dd>{application.reason}</dd>
                </div>
                <div>
                  <dt>{t.improvementEvidence}</dt>
                  <dd>{application.evidenceRefs.join(" · ")}</dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationAppliedBy}</dt>
                  <dd>{application.appliedBy.id}</dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationReceipts}</dt>
                  <dd>
                    {application.receipts
                      .map(
                        (receipt) =>
                          `${receipt.phase}:${receipt.disposition}:${receipt.targetRevision?.revisionId ?? "none"}`,
                      )
                      .join(" · ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt>{t.improvementApplicationObservations}</dt>
                  <dd>
                    {application.observations
                      .map(
                        (observation) =>
                          `${observation.phase}:${observation.outcome}`,
                      )
                      .join(" · ") || "—"}
                  </dd>
                </div>
                {application.latestError ? (
                  <div>
                    <dt>{t.improvementApplicationError}</dt>
                    <dd>
                      {application.latestError.code}:{" "}
                      {application.latestError.message}
                    </dd>
                  </div>
                ) : null}
                {application.validations.map((validation) => (
                  <div key={validation.id}>
                    <dt>{t.improvementValidationOutcome}</dt>
                    <dd>
                      {validationOutcomeLabel(t, validation.outcome)} ·{" "}
                      {validation.beforeEvidence.id} (
                      {validation.beforeEvidence.hash}) →{" "}
                      {validation.afterEvidence.id} (
                      {validation.afterEvidence.hash}) ·{" "}
                      {t.improvementValidatedBy} {validation.validatedBy.id}
                    </dd>
                  </div>
                ))}
                {application.rollbacks.map((rollback) => (
                  <div key={rollback.id}>
                    <dt>{t.improvementRollbackHistory}</dt>
                    <dd>
                      {rollback.state} · {t.improvementRollbackAppliedRevision}{" "}
                      {rollback.appliedRevision.revisionId} ·{" "}
                      {t.improvementRollbackSourceRevision}{" "}
                      {rollback.sourceRevision.revisionId} ·{" "}
                      {t.improvementRollbackRestoringRevision}{" "}
                      {rollback.restoringRevision?.revisionId ?? "—"} ·{" "}
                      {rollback.confirmation} · {rollback.reason}
                    </dd>
                  </div>
                ))}
              </dl>
              {application.nextActions.includes("validate") ? (
                <div className="field-grid two-column">
                  <label>
                    <span>{t.improvementValidationAfterEvidence}</span>
                    <input readOnly value={evidence?.id ?? ""} />
                  </label>
                  <label>
                    <span>{t.improvementValidationReason}</span>
                    <textarea
                      value={validationReason}
                      onChange={(event) =>
                        setValidationReason(event.currentTarget.value)
                      }
                    />
                  </label>
                  <button
                    disabled={
                      busy ||
                      !evidence ||
                      validationReason.trim().length === 0 ||
                      !onValidateApplication
                    }
                    onClick={() =>
                      evidence &&
                      onValidateApplication?.(
                        application,
                        evidence,
                        validationReason.trim(),
                      )
                    }
                    type="button"
                  >
                    {t.improvementValidationAction}
                  </button>
                </div>
              ) : null}
              {application.nextActions.includes("rollback") ? (
                <div className="field-grid two-column">
                  <label>
                    <span>{t.improvementRollbackConfirmation}</span>
                    <textarea
                      value={rollbackConfirmation}
                      onChange={(event) =>
                        setRollbackConfirmation(event.currentTarget.value)
                      }
                    />
                  </label>
                  <label>
                    <span>{t.improvementRollbackReason}</span>
                    <textarea
                      value={rollbackReason}
                      onChange={(event) =>
                        setRollbackReason(event.currentTarget.value)
                      }
                    />
                  </label>
                  <button
                    disabled={
                      busy ||
                      rollbackConfirmation.trim().length === 0 ||
                      rollbackReason.trim().length === 0 ||
                      !onRollbackApplication
                    }
                    onClick={() =>
                      onRollbackApplication?.(
                        application,
                        rollbackConfirmation.trim(),
                        rollbackReason.trim(),
                      )
                    }
                    type="button"
                  >
                    {t.improvementRollbackAction}
                  </button>
                </div>
              ) : null}
              {application.nextActions.includes("reconcile") ? (
                <button
                  data-improvement-reconcile-application={application.id}
                  disabled={busy || !onReconcileApplication}
                  onClick={() => onReconcileApplication?.(application)}
                  type="button"
                >
                  {t.improvementApplicationReconcile}
                </button>
              ) : null}
            </article>
          ))}
          {(applications ?? []).length === 0 ? (
            <p>{t.improvementNoApplications}</p>
          ) : null}
        </div>
      </section>
    </section>
  );
}
