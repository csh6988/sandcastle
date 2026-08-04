import type {
  StatisticsEvidenceSnapshotView,
  StatisticsInspectInput,
  StatisticsMetricId,
  StatisticsMetricObservation,
  StatisticsView,
  StatisticsWindow,
} from "../runtime/interface.js";
import type { Messages } from "./i18n.js";

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
}) {
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
    </section>
  );
}
