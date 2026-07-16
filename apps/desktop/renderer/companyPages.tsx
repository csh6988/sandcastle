import { useEffect, useState } from "react";
import type {
  ArtifactContract,
  ArtifactVersionView,
  ArtifactLineageView,
  InteractionView,
  AgUiReplayView,
  MemoryCandidateView,
  CompanyDepartment,
  CompanyOverview,
  CompanyProject,
  DepartmentInspect,
  DepartmentRunView,
  DepartmentPipelineDraftGraph,
  DepartmentPipelineEditorView,
  PipelineValidationResult,
  ProjectEditorView,
  RuntimeDiagnosticsView,
  RuntimeBackupView,
  SkillConfigurationView,
} from "../runtime/interface.js";
import {
  departmentName,
  pipelineNodeName,
  positionName,
  statusName,
  type Language,
  type Messages,
} from "./i18n.js";

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ? error.message
      : String(error);

const runtimeErrorCode = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : errorMessage(error).includes("VERSION_CONFLICT")
      ? "VERSION_CONFLICT"
      : null;

const skillRuntimeErrorMessage = (
  t: Messages,
  code: string | null,
  fallback: string,
): string => {
  const messagesByCode: Readonly<Record<string, string>> = {
    DEPARTMENT_NOT_FOUND: t.skillErrorDepartmentNotFound,
    SKILL_NOT_FOUND: t.skillErrorSkillNotFound,
    SKILL_ARCHIVED: t.skillErrorSkillArchived,
    SKILL_IN_USE: t.skillErrorSkillInUse,
    POSITION_OUTSIDE_DEPARTMENT: t.skillErrorPositionOutsideDepartment,
    POSITION_SKILL_IN_USE: t.skillErrorPositionSkillInUse,
    SKILL_SELECTION_DUPLICATE: t.skillErrorSelectionDuplicate,
    SKILL_FLOW_NOT_FOUND: t.skillErrorFlowNotFound,
    SKILL_FLOW_ARCHIVED: t.skillErrorFlowArchived,
    SKILL_FLOW_OUTSIDE_DEPARTMENT: t.skillErrorFlowOutsideDepartment,
    SKILL_FLOW_POSITION_IMMUTABLE: t.skillErrorFlowPositionImmutable,
    SKILL_NOT_BOUND_TO_POSITION: t.skillErrorNotBoundToPosition,
    SKILL_FLOW_IN_USE: t.skillErrorFlowInUse,
    VERSION_CONFLICT: t.skillErrorVersionConflict,
  };
  return code ? (messagesByCode[code] ?? fallback) : fallback;
};

type SandcastleBridgeRuntimeSaveExecutionProfile = (
  input: Parameters<typeof window.sandcastle.runtime.saveExecutionProfile>[0],
) => Promise<void>;

export function CompanyOverviewPage({ t }: { readonly t: Messages }) {
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.sandcastle.runtime
      .overview()
      .then(setOverview)
      .catch((nextError: unknown) => setError(errorMessage(nextError)));
  }, []);

  return (
    <section className="page" data-page="company-overview">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{t.overviewEyebrow}</span>
          <h1>{overview?.company.name ?? t.overviewTitle}</h1>
          <p>{t.overviewBody}</p>
        </div>
      </header>
      {error ? <div className="warn">{error}</div> : null}
      <div className="metric-row overview-metrics">
        <Metric
          label={t.metricActiveRuns}
          value={overview?.metrics.activeRuns ?? 0}
        />
        <Metric
          label={t.metricWaitingApproval}
          value={overview?.metrics.waitingApprovalRuns ?? 0}
        />
        <Metric
          label={t.metricBlockedRuns}
          value={overview?.metrics.blockedRuns ?? 0}
        />
        <Metric
          label={t.metricCompletedRuns}
          value={overview?.metrics.completedRuns ?? 0}
        />
      </div>
      <div className="project-dashboard">
        <section className="create-panel">
          <h2>{t.attentionQueue}</h2>
          {overview?.attention.length ? (
            overview.attention.map((item) => (
              <div className="task-card" key={`${item.kind}:${item.runId}`}>
                <strong>{item.title}</strong>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <strong>{t.noAttentionNeeded}</strong>
              <span>{t.noAttentionBody}</span>
            </div>
          )}
        </section>
        <aside className="create-panel">
          <h2>{t.companyInventory}</h2>
          <dl className="overview-inventory">
            <div>
              <dt>{t.metricProjects}</dt>
              <dd>{overview?.metrics.projects ?? 0}</dd>
            </div>
            <div>
              <dt>{t.navDepartments}</dt>
              <dd>{overview?.metrics.departments ?? 0}</dd>
            </div>
            <div>
              <dt>{t.navArtifacts}</dt>
              <dd>{overview?.metrics.artifacts ?? 0}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

export function ProjectsPage({ t }: { readonly t: Messages }) {
  const [projects, setProjects] = useState<readonly CompanyProject[] | null>(
    null,
  );
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [projectErrorCode, setProjectErrorCode] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] =
    useState<ProjectEditorView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = () => {
    window.sandcastle.runtime
      .projects()
      .then(setProjects)
      .catch((nextError: unknown) => {
        setError(errorMessage(nextError));
        setProjects([]);
      });
  };

  useEffect(refresh, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const created = await window.sandcastle.runtime.createProject({
        name: name.trim(),
        goal: goal.trim(),
      });
      setName("");
      setGoal("");
      refresh();
      setSelectedProject(
        await window.sandcastle.runtime.inspectProject(created.id),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const inspectProject = async (projectId: string) => {
    setError(null);
    setProjectErrorCode(null);
    setDetailLoading(true);
    try {
      setSelectedProject(
        await window.sandcastle.runtime.inspectProject(projectId),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      setProjectErrorCode(runtimeErrorCode(nextError));
    } finally {
      setDetailLoading(false);
    }
  };

  const updateProject = async (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly goal: string;
    readonly sharedContext: string;
    readonly repositoryReferences: readonly string[];
  }): Promise<ProjectEditorView> => {
    setError(null);
    setProjectErrorCode(null);
    setDetailLoading(true);
    try {
      const updated = await window.sandcastle.runtime.updateProject(input);
      setSelectedProject(updated);
      refresh();
      return updated;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setProjectErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const archiveProject = async (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
  }): Promise<ProjectEditorView> => {
    setError(null);
    setProjectErrorCode(null);
    setDetailLoading(true);
    try {
      const archived = await window.sandcastle.runtime.archiveProject(input);
      setSelectedProject(null);
      refresh();
      return archived;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setProjectErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  if (selectedProject) {
    return (
      <ProjectDetailView
        busy={detailLoading}
        error={error}
        errorCode={projectErrorCode}
        onArchive={archiveProject}
        onBack={() => setSelectedProject(null)}
        onSave={updateProject}
        project={selectedProject}
        t={t}
      />
    );
  }

  return (
    <section className="page" data-page="projects">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t.projectsEyebrow}</span>
          <h1>{t.projectsTitle}</h1>
          <p>{t.projectsBody}</p>
        </div>
      </div>
      {error ? <div className="warn">{error}</div> : null}
      <div className="project-dashboard">
        <section className="project-grid" aria-label={t.projectsTitle}>
          {projects === null ? (
            <div className="empty-state">{t.loadingProjects}</div>
          ) : projects.length === 0 ? (
            <div className="empty-state">
              <strong>{t.noProjectsYet}</strong>
              <span>{t.noProjectsBody}</span>
            </div>
          ) : (
            projects.map((project) => (
              <button
                className="project-card"
                data-project-id={project.id}
                disabled={detailLoading}
                key={project.id}
                onClick={() => void inspectProject(project.id)}
                type="button"
              >
                <span className="project-card-top">
                  <strong>{project.name}</strong>
                  <span className="pill primary">
                    {statusName(t, project.status)}
                  </span>
                </span>
                <span className="project-summary">{project.goal}</span>
                <span className="project-meta-grid">
                  <span>
                    {t.status} <strong>{statusName(t, project.status)}</strong>
                  </span>
                  <span>
                    {t.artifacts} <strong>0</strong>
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
        <aside className="create-panel">
          <h2>{t.createProject}</h2>
          <form className="form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="company-project-name">{t.projectName}</label>
            <input
              id="company-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <label htmlFor="company-project-goal">{t.projectSummary}</label>
            <textarea
              id="company-project-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={5}
              required
            />
            <button type="submit">{t.createProjectButton}</button>
          </form>
        </aside>
      </div>
    </section>
  );
}

export function DepartmentRunDetail({
  run,
  t,
  busy,
  onDecision,
  onRetry,
  onContinue,
  onControl,
  onRecover,
  onFork,
}: {
  readonly run: DepartmentRunView;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onDecision: (input: {
    readonly nodeRunId: string;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
  }) => void;
  readonly onRetry: (input: {
    readonly nodeRunId: string;
    readonly feedback?: string;
  }) => void;
  readonly onContinue: () => void;
  readonly onControl: (action: "pause" | "resume" | "cancel") => void;
  readonly onFork?: (nodeRunId: string) => void;
  readonly onRecover: (input: {
    readonly nodeRunId: string;
    readonly override: {
      readonly providerRef?: string;
      readonly model?: string;
      readonly sandboxRef?: string;
      readonly timeoutSeconds?: number;
    };
  }) => void;
}) {
  const [approvalFeedback, setApprovalFeedback] = useState("");
  const [retryFeedback, setRetryFeedback] = useState("");
  const [recoveryProvider, setRecoveryProvider] = useState("");
  const [recoveryModel, setRecoveryModel] = useState("");
  const [recoverySandbox, setRecoverySandbox] = useState("");
  const [recoveryTimeout, setRecoveryTimeout] = useState("");
  const waitingApproval = run.nodes.find(
    (node) =>
      node.nodeType === "human-approval" && node.status === "waiting-approval",
  );
  const failedAiTask = run.nodes.find(
    (node) => node.nodeType === "ai-task" && node.status === "failed",
  );
  const failedPipelineNode = failedAiTask
    ? run.snapshot.payload.pipelineVersion.graph.nodes.find(
        (node) => node.id === failedAiTask.pipelineNodeId,
      )
    : undefined;
  const executionProfileId =
    failedPipelineNode?.executionProfileId ??
    run.snapshot.payload.department.defaultExecutionProfileId;
  const executionProfile = run.snapshot.payload.executionProfiles.find(
    (profile) => profile.id === executionProfileId,
  );
  const maxRetries =
    failedPipelineNode?.retryMaxAttempts ??
    executionProfile?.retryPolicy.maxAttempts ??
    0;
  const usedRetries =
    failedAiTask?.attempts.filter((attempt) => attempt.reason === "retry")
      .length ?? 0;
  const retriesRemaining = Math.max(0, maxRetries - usedRetries);
  const canContinue =
    ["running", "recovering"].includes(run.run.status) &&
    run.nodes.some((node) =>
      node.attempts.some((attempt) => attempt.status === "ready"),
    );
  const canPause = [
    "ready",
    "running",
    "waiting-approval",
    "blocked",
    "recovering",
  ].includes(run.run.status);
  const canResume = run.run.status === "paused";
  const canCancel = !["completed", "cancelled"].includes(run.run.status);
  return (
    <article
      className="run-detail"
      data-run-detail={run.run.id}
      data-run-status={run.run.status}
    >
      <div className="project-card-top">
        <strong>{run.snapshot.payload.department.name}</strong>
        <span className="pill primary">{statusName(t, run.run.status)}</span>
      </div>
      <dl className="overview-inventory">
        <div>
          <dt>{t.runSnapshot}</dt>
          <dd>
            r{run.snapshot.revision} · {run.snapshot.hash.slice(0, 12)}
          </dd>
        </div>
        <div>
          <dt>{t.publishedPipeline}</dt>
          <dd>v{run.snapshot.payload.pipelineVersion.version}</dd>
        </div>
        <div>
          <dt>{t.runRevision}</dt>
          <dd>{run.run.revision}</dd>
        </div>
      </dl>
      <ol className="run-node-list">
        {run.nodes.map((nodeRun) => {
          const node = run.snapshot.payload.pipelineVersion.graph.nodes.find(
            (candidate) => candidate.id === nodeRun.pipelineNodeId,
          );
          return (
            <li
              data-node-run-id={nodeRun.id}
              data-node-run-status={nodeRun.status}
              key={nodeRun.id}
            >
              <strong>
                {node ? pipelineNodeName(t, node) : nodeRun.pipelineNodeId}
              </strong>
              <span>{statusName(t, nodeRun.status)}</span>
              <span>
                {t.nodeAttempts}: {nodeRun.attemptCount}
              </span>
              {nodeRun.failure ? (
                <span data-node-failure-code={nodeRun.failure.code}>
                  {nodeRun.failure.code}: {nodeRun.failure.message}
                </span>
              ) : null}
              {nodeRun.attempts.length > 0 ? (
                <details>
                  <summary>{t.attemptHistory}</summary>
                  <ol>
                    {nodeRun.attempts.map((attempt) => (
                      <li
                        data-node-attempt={attempt.attemptNumber}
                        data-node-attempt-status={attempt.status}
                        key={attempt.id}
                      >
                        <span>
                          #{attempt.attemptNumber} · {attempt.reason} · r
                          {run.snapshot.revision} ·{" "}
                          {statusName(t, attempt.status)}
                        </span>
                        {attempt.failure ? (
                          <span>
                            {attempt.failure.code}: {attempt.failure.message}
                          </span>
                        ) : null}
                        {attempt.feedback.map((feedback) => (
                          <p data-node-feedback={feedback.id} key={feedback.id}>
                            {feedback.content}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              {nodeRun.approvals.length > 0 ? (
                <details>
                  <summary>{t.approvalHistory}</summary>
                  <ol>
                    {nodeRun.approvals.map((approval) => (
                      <li
                        data-run-approval-cycle={approval.cycle}
                        key={approval.id}
                      >
                        #{approval.cycle} ·{" "}
                        {approval.decision ?? approval.status}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              {nodeRun.status !== "queued" ? (
                <button
                  data-run-fork-node={nodeRun.id}
                  disabled={busy}
                  onClick={() => onFork?.(nodeRun.id)}
                  type="button"
                >
                  {t.forkRun}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {waitingApproval ? (
        <div className="run-approval-actions">
          <label htmlFor={`run-approval-feedback-${waitingApproval.id}`}>
            {t.nodeFeedback}
          </label>
          <textarea
            data-run-approval-feedback
            id={`run-approval-feedback-${waitingApproval.id}`}
            maxLength={10_000}
            onChange={(event) => setApprovalFeedback(event.target.value)}
            rows={3}
            value={approvalFeedback}
          />
          <div className="action-bar">
            <button
              data-run-approval-decision="approve"
              disabled={busy}
              onClick={() =>
                onDecision({
                  nodeRunId: waitingApproval.id,
                  decision: "approve",
                })
              }
              type="button"
            >
              {t.approve}
            </button>
            <button
              data-run-approval-decision="request-changes"
              disabled={busy || approvalFeedback.trim() === ""}
              onClick={() =>
                onDecision({
                  nodeRunId: waitingApproval.id,
                  decision: "request-changes",
                  feedback: approvalFeedback,
                })
              }
              type="button"
            >
              {t.requestChanges}
            </button>
            <button
              className="danger-button"
              data-run-approval-decision="reject"
              disabled={busy}
              onClick={() =>
                onDecision({
                  nodeRunId: waitingApproval.id,
                  decision: "reject",
                })
              }
              type="button"
            >
              {t.reject}
            </button>
          </div>
        </div>
      ) : null}
      {failedAiTask ? (
        <div className="run-retry-actions">
          <span>
            {t.retriesRemaining}: {retriesRemaining}
          </span>
          <label htmlFor={`run-retry-feedback-${failedAiTask.id}`}>
            {t.nodeFeedback}
          </label>
          <textarea
            data-run-retry-feedback
            id={`run-retry-feedback-${failedAiTask.id}`}
            maxLength={10_000}
            onChange={(event) => setRetryFeedback(event.target.value)}
            rows={3}
            value={retryFeedback}
          />
          <button
            data-run-node-retry={failedAiTask.id}
            disabled={busy || retriesRemaining === 0}
            onClick={() =>
              onRetry({
                nodeRunId: failedAiTask.id,
                ...(retryFeedback.trim() ? { feedback: retryFeedback } : {}),
              })
            }
            type="button"
          >
            {t.retryNode}
          </button>
        </div>
      ) : null}
      {failedAiTask && executionProfile ? (
        <div className="run-recovery-actions" data-run-recovery>
          <h3>{t.recoveryOverride}</h3>
          <label>
            {t.recoveryProvider}
            <input
              data-run-recovery-provider
              onChange={(event) => setRecoveryProvider(event.target.value)}
              placeholder={executionProfile.providerRef}
              value={recoveryProvider}
            />
          </label>
          <label>
            {t.recoveryModel}
            <input
              data-run-recovery-model
              onChange={(event) => setRecoveryModel(event.target.value)}
              placeholder={executionProfile.model}
              value={recoveryModel}
            />
          </label>
          <label>
            {t.recoverySandbox}
            <input
              data-run-recovery-sandbox
              onChange={(event) => setRecoverySandbox(event.target.value)}
              placeholder={executionProfile.sandboxRef}
              value={recoverySandbox}
            />
          </label>
          <label>
            {t.recoveryTimeout}
            <input
              data-run-recovery-timeout
              inputMode="numeric"
              onChange={(event) => setRecoveryTimeout(event.target.value)}
              placeholder={String(executionProfile.limits.timeoutSeconds)}
              value={recoveryTimeout}
            />
          </label>
          <button
            data-run-recover
            disabled={busy}
            onClick={() =>
              onRecover({
                nodeRunId: failedAiTask.id,
                override: {
                  ...(recoveryProvider.trim()
                    ? { providerRef: recoveryProvider.trim() }
                    : {}),
                  ...(recoveryModel.trim()
                    ? { model: recoveryModel.trim() }
                    : {}),
                  ...(recoverySandbox.trim()
                    ? { sandboxRef: recoverySandbox.trim() }
                    : {}),
                  ...(recoveryTimeout.trim()
                    ? { timeoutSeconds: Number(recoveryTimeout) }
                    : {}),
                },
              })
            }
            type="button"
          >
            {t.recoverRun}
          </button>
        </div>
      ) : null}
      {canContinue ? (
        <button
          data-run-continue
          disabled={busy}
          onClick={onContinue}
          type="button"
        >
          {t.continueRun}
        </button>
      ) : null}
      {canPause || canResume || canCancel ? (
        <div className="action-bar" data-run-controls>
          {canPause ? (
            <button
              data-run-control="pause"
              disabled={busy}
              onClick={() => onControl("pause")}
              type="button"
            >
              {t.pauseRun}
            </button>
          ) : null}
          {canResume ? (
            <button
              data-run-control="resume"
              disabled={busy}
              onClick={() => onControl("resume")}
              type="button"
            >
              {t.resumeRun}
            </button>
          ) : null}
          {canCancel ? (
            <button
              className="danger-button"
              data-run-control="cancel"
              disabled={busy}
              onClick={() => onControl("cancel")}
              type="button"
            >
              {t.cancelRun}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ProjectDetailView({
  project,
  t,
  onBack,
  onSave,
  onArchive,
  busy = false,
  error = null,
  errorCode = null,
}: {
  readonly project: ProjectEditorView;
  readonly t: Messages;
  readonly onBack: () => void;
  readonly onSave: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly goal: string;
    readonly sharedContext: string;
    readonly repositoryReferences: readonly string[];
  }) => Promise<ProjectEditorView>;
  readonly onArchive: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
  }) => Promise<ProjectEditorView>;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly errorCode?: string | null;
}) {
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal);
  const [sharedContext, setSharedContext] = useState(project.sharedContext);
  const [repositoryReferences, setRepositoryReferences] = useState([
    ...project.repositoryReferences,
  ]);
  const [repositoryReference, setRepositoryReference] = useState("");
  const [runDepartments, setRunDepartments] = useState<
    readonly CompanyDepartment[]
  >([]);
  const [runs, setRuns] = useState<readonly DepartmentRunView[]>([]);
  const [selectedRun, setSelectedRun] = useState<DepartmentRunView | null>(
    null,
  );
  const [runDepartmentId, setRunDepartmentId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runErrorCode, setRunErrorCode] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name);
    setGoal(project.goal);
    setSharedContext(project.sharedContext);
    setRepositoryReferences([...project.repositoryReferences]);
    setRepositoryReference("");
  }, [project]);

  const refreshRuns = async (): Promise<readonly DepartmentRunView[]> => {
    const nextRuns = await window.sandcastle.runtime.runs(project.id);
    setRuns(nextRuns);
    setSelectedRun((current) =>
      current
        ? (nextRuns.find((run) => run.run.id === current.run.id) ?? current)
        : (nextRuns[0] ?? null),
    );
    return nextRuns;
  };

  useEffect(() => {
    let active = true;
    setRunError(null);
    Promise.all([
      window.sandcastle.runtime.departments(),
      window.sandcastle.runtime.runs(project.id),
    ])
      .then(([departments, nextRuns]) => {
        if (!active) return;
        const runnable = departments.filter(
          (department) => department.publishedPipelineVersion !== null,
        );
        setRunDepartments(runnable);
        setRunDepartmentId((current) => current || runnable[0]?.id || "");
        setRuns(nextRuns);
        setSelectedRun(nextRuns[0] ?? null);
      })
      .catch((nextError: unknown) => {
        if (!active) return;
        setRunError(errorMessage(nextError));
        setRunErrorCode(runtimeErrorCode(nextError));
      });
    return () => {
      active = false;
    };
  }, [project.id]);

  const startRun = async (): Promise<void> => {
    if (!runDepartmentId) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    let started: DepartmentRunView | null = null;
    try {
      started = await window.sandcastle.runtime.startRun({
        projectId: project.id,
        departmentId: runDepartmentId,
      });
      setSelectedRun(started);
      const advanced = await window.sandcastle.runtime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      setSelectedRun(advanced);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      if (started) {
        window.sandcastle.runtime
          .inspectRun(started.run.id)
          .then(setSelectedRun)
          .catch(() => undefined);
      }
    } finally {
      setRunBusy(false);
    }
  };

  const decideApproval = async (input: {
    readonly nodeRunId: string;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
  }): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const decided = await window.sandcastle.runtime.decideApproval({
        runId: selectedRun.run.id,
        nodeRunId: input.nodeRunId,
        expectedRevision: selectedRun.run.revision,
        decision: input.decision,
        feedback: input.feedback,
      });
      setSelectedRun(decided);
      if (
        input.decision === "approve" ||
        input.decision === "request-changes"
      ) {
        const advanced = await window.sandcastle.runtime.executeReady({
          runId: decided.run.id,
          expectedRevision: decided.run.revision,
        });
        setSelectedRun(advanced);
      }
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      window.sandcastle.runtime
        .inspectRun(selectedRun.run.id)
        .then(setSelectedRun)
        .catch(() => undefined);
    } finally {
      setRunBusy(false);
    }
  };

  const retryNode = async (input: {
    readonly nodeRunId: string;
    readonly feedback?: string;
  }): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const recovering = await window.sandcastle.runtime.retryNode({
        runId: selectedRun.run.id,
        nodeRunId: input.nodeRunId,
        expectedRevision: selectedRun.run.revision,
        feedback: input.feedback,
      });
      const advanced = await window.sandcastle.runtime.executeReady({
        runId: recovering.run.id,
        expectedRevision: recovering.run.revision,
      });
      setSelectedRun(advanced);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      window.sandcastle.runtime
        .inspectRun(selectedRun.run.id)
        .then(setSelectedRun)
        .catch(() => undefined);
    } finally {
      setRunBusy(false);
    }
  };

  const recoverRun = async (input: {
    readonly nodeRunId: string;
    readonly override: {
      readonly providerRef?: string;
      readonly model?: string;
      readonly sandboxRef?: string;
      readonly timeoutSeconds?: number;
    };
  }): Promise<void> => {
    if (!selectedRun || Object.keys(input.override).length === 0) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const recovering = await window.sandcastle.runtime.recoverRun({
        runId: selectedRun.run.id,
        nodeRunId: input.nodeRunId,
        expectedRevision: selectedRun.run.revision,
        override: input.override,
      });
      setSelectedRun(recovering);
      const advanced = await window.sandcastle.runtime.executeReady({
        runId: recovering.run.id,
        expectedRevision: recovering.run.revision,
      });
      setSelectedRun(advanced);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      window.sandcastle.runtime
        .inspectRun(selectedRun.run.id)
        .then(setSelectedRun)
        .catch(() => undefined);
    } finally {
      setRunBusy(false);
    }
  };

  const continueRun = async (): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const advanced = await window.sandcastle.runtime.executeReady({
        runId: selectedRun.run.id,
        expectedRevision: selectedRun.run.revision,
      });
      setSelectedRun(advanced);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const forkRun = async (fromNodeRunId: string): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const forked = await window.sandcastle.runtime.forkRun({
        runId: selectedRun.run.id,
        snapshotRevisionId: selectedRun.snapshot.id,
        fromNodeRunId,
      });
      setSelectedRun(forked);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const controlRun = async (
    action: "pause" | "resume" | "cancel",
  ): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const input = {
        runId: selectedRun.run.id,
        expectedRevision: selectedRun.run.revision,
      };
      const controlled =
        action === "pause"
          ? await window.sandcastle.runtime.pauseRun(input)
          : action === "resume"
            ? await window.sandcastle.runtime.resumeRun(input)
            : await window.sandcastle.runtime.cancelRun(input);
      setSelectedRun(controlled);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      window.sandcastle.runtime
        .inspectRun(selectedRun.run.id)
        .then(setSelectedRun)
        .catch(() => undefined);
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <section
      className="page"
      data-page="project-detail"
      data-runtime-project-id={project.id}
      data-project-revision={project.revision}
    >
      <header className="page-heading department-detail-heading">
        <div>
          <button className="text-button" onClick={onBack} type="button">
            {t.backToProjects}
          </button>
          <span className="eyebrow">{t.projectDetailEyebrow}</span>
          <h1>{project.name}</h1>
          <p>
            {t.projectRevision} {project.revision}
          </p>
        </div>
        <span className="pill primary">{statusName(t, project.status)}</span>
      </header>
      {error ? (
        <div className="warn" data-project-error-code={errorCode ?? undefined}>
          {errorCode ? `${errorCode}: ` : ""}
          {error}
        </div>
      ) : null}
      <div className="project-configuration-grid">
        <section className="create-panel">
          <h2>{t.projectDetailEyebrow}</h2>
          <form
            className="form"
            data-project-settings
            onSubmit={(event) => {
              event.preventDefault();
              void onSave({
                projectId: project.id,
                expectedRevision: project.revision,
                name: name.trim(),
                goal: goal.trim(),
                sharedContext,
                repositoryReferences,
              }).catch(() => undefined);
            }}
          >
            <label htmlFor="project-detail-name">{t.projectName}</label>
            <input
              id="project-detail-name"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
            <label htmlFor="project-detail-goal">{t.projectGoal}</label>
            <textarea
              id="project-detail-goal"
              onChange={(event) => setGoal(event.target.value)}
              required
              rows={4}
              value={goal}
            />
            <label htmlFor="project-shared-context">{t.sharedContext}</label>
            <textarea
              id="project-shared-context"
              onChange={(event) => setSharedContext(event.target.value)}
              rows={7}
              value={sharedContext}
            />
            <button disabled={busy} type="submit">
              {t.saveProject}
            </button>
          </form>
        </section>
        <section className="create-panel">
          <h2>{t.repositoryReferences}</h2>
          <div className="project-repository-list">
            {repositoryReferences.map((reference) => (
              <div data-project-repository={reference} key={reference}>
                <code>{reference}</code>
                <button
                  className="danger-button"
                  onClick={() =>
                    setRepositoryReferences((current) =>
                      current.filter((candidate) => candidate !== reference),
                    )
                  }
                  type="button"
                >
                  {t.removeRepositoryReference}
                </button>
              </div>
            ))}
          </div>
          <div className="form project-repository-add">
            <label htmlFor="project-repository-reference">
              {t.repositoryReference}
            </label>
            <input
              id="project-repository-reference"
              onChange={(event) => setRepositoryReference(event.target.value)}
              value={repositoryReference}
            />
            <button
              disabled={
                busy ||
                repositoryReference.trim() === "" ||
                repositoryReferences.includes(repositoryReference.trim())
              }
              onClick={() => {
                const reference = repositoryReference.trim();
                if (!reference || repositoryReferences.includes(reference)) {
                  return;
                }
                setRepositoryReferences((current) => [...current, reference]);
                setRepositoryReference("");
              }}
              type="button"
            >
              {t.addRepositoryReference}
            </button>
          </div>
        </section>
        <section className="create-panel" data-project-runs>
          <h2>{t.departmentRuns}</h2>
          <div className="form run-start-form">
            <label htmlFor="project-run-department">
              {t.selectRunDepartment}
            </label>
            <select
              id="project-run-department"
              onChange={(event) => setRunDepartmentId(event.target.value)}
              value={runDepartmentId}
            >
              <option value="">{t.none}</option>
              {runDepartments.map((department) => (
                <option key={department.id} value={department.id}>
                  {departmentName(t, department)}
                </option>
              ))}
            </select>
            <button
              data-start-department-run
              disabled={runBusy || runDepartmentId === ""}
              onClick={() => void startRun()}
              type="button"
            >
              {t.startDepartmentRun}
            </button>
          </div>
          {runError ? (
            <div
              className="warn"
              data-run-error-code={runErrorCode ?? undefined}
            >
              {runErrorCode ? `${runErrorCode}: ` : ""}
              {runError}
            </div>
          ) : null}
          {runs.length === 0 ? (
            <div className="empty-state">{t.noDepartmentRuns}</div>
          ) : (
            runs.map((run) => (
              <button
                className="task-card run-list-item"
                data-run-id={run.run.id}
                key={run.run.id}
                onClick={() => setSelectedRun(run)}
                type="button"
              >
                <strong>{run.snapshot.payload.department.name}</strong>
                <span>{statusName(t, run.run.status)}</span>
              </button>
            ))
          )}
          {selectedRun ? (
            <DepartmentRunDetail
              busy={runBusy}
              onDecision={(input) => void decideApproval(input)}
              onRetry={(input) => void retryNode(input)}
              onContinue={() => void continueRun()}
              onControl={(action) => void controlRun(action)}
              onRecover={(input) => void recoverRun(input)}
              onFork={(nodeRunId) => void forkRun(nodeRunId)}
              run={selectedRun}
              t={t}
            />
          ) : null}
        </section>
        <section className="create-panel department-actions-panel">
          <h2>{t.status}</h2>
          <button
            className="danger-button"
            data-project-archive
            disabled={busy}
            onClick={() =>
              void onArchive({
                projectId: project.id,
                expectedRevision: project.revision,
              }).catch(() => undefined)
            }
            type="button"
          >
            {t.archiveProject}
          </button>
        </section>
      </div>
    </section>
  );
}

export function DepartmentsPage({ t }: { readonly t: Messages }) {
  const [departments, setDepartments] = useState<
    readonly CompanyDepartment[] | null
  >(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedDepartment, setSelectedDepartment] =
    useState<DepartmentInspect | null>(null);
  const [pipelineEditor, setPipelineEditor] =
    useState<DepartmentPipelineEditorView | null>(null);
  const [skillConfiguration, setSkillConfiguration] =
    useState<SkillConfigurationView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<DepartmentTab>("overview");
  const [skillErrorCode, setSkillErrorCode] = useState<string | null>(null);

  const refresh = () => {
    window.sandcastle.runtime
      .departments()
      .then(setDepartments)
      .catch((nextError: unknown) => {
        setError(errorMessage(nextError));
        setDepartments([]);
      });
  };

  useEffect(refresh, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await window.sandcastle.runtime.createDepartment({ name: name.trim() });
      setName("");
      refresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const inspectDepartment = async (departmentId: string) => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const [department, pipeline, skills] = await Promise.all([
        window.sandcastle.runtime.inspectDepartment(departmentId),
        window.sandcastle.runtime.inspectPipeline(departmentId),
        window.sandcastle.runtime.inspectSkillConfiguration(departmentId),
      ]);
      setSelectedDepartment(department);
      setPipelineEditor(pipeline);
      setSkillConfiguration(skills);
      setActiveTab("overview");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDetailLoading(false);
    }
  };

  const updateDepartment = async (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly inputArtifactContracts: readonly ArtifactContract[];
    readonly outputArtifactContracts: readonly ArtifactContract[];
    readonly defaultExecutionProfileId: string | null;
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.updateDepartment(input),
      );
      setPipelineEditor(
        await window.sandcastle.runtime.inspectPipeline(input.departmentId),
      );
      refresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDetailLoading(false);
    }
  };

  const archiveDepartment = async (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      await window.sandcastle.runtime.archiveDepartment(input);
      setSelectedDepartment(null);
      setPipelineEditor(null);
      setSkillConfiguration(null);
      refresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDetailLoading(false);
    }
  };

  const copyDepartment = async (input: {
    readonly departmentId: string;
    readonly name: string;
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      const copied = await window.sandcastle.runtime.copyDepartment(input);
      setSelectedDepartment(copied);
      setPipelineEditor(
        await window.sandcastle.runtime.inspectPipeline(copied.id),
      );
      setSkillConfiguration(
        await window.sandcastle.runtime.inspectSkillConfiguration(copied.id),
      );
      setActiveTab("overview");
      refresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDetailLoading(false);
    }
  };

  const updatePosition = async (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
    readonly aiMemberStatus: "active" | "inactive";
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.updatePosition(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDetailLoading(false);
    }
  };

  const createPosition = async (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
  }) => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.createPosition(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const archivePosition = async (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
  }) => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.archivePosition(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const createSecretReference = async (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly providerScope: string;
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.createSecretReference(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const archiveSecretReference = async (input: {
    readonly departmentId: string;
    readonly secretReferenceId: string;
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.archiveSecretReference(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const saveExecutionProfile = async (
    input: Parameters<typeof window.sandcastle.runtime.saveExecutionProfile>[0],
  ) => {
    setError(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.saveExecutionProfile(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const archiveExecutionProfile = async (input: {
    readonly departmentId: string;
    readonly executionProfileId: string;
    readonly expectedRevision: number;
  }) => {
    setError(null);
    setDetailLoading(true);
    try {
      setSelectedDepartment(
        await window.sandcastle.runtime.archiveExecutionProfile(input),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const savePipelineDraft = async (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly graph: DepartmentPipelineDraftGraph;
  }): Promise<DepartmentPipelineEditorView> => {
    setError(null);
    setDetailLoading(true);
    try {
      const editor = await window.sandcastle.runtime.savePipelineDraft(input);
      setPipelineEditor(editor);
      return editor;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const validatePipeline = async (input: {
    readonly departmentId: string;
    readonly graph: DepartmentPipelineDraftGraph;
  }): Promise<PipelineValidationResult> => {
    setError(null);
    try {
      return await window.sandcastle.runtime.validatePipeline(input);
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    }
  };

  const publishPipeline = async (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentPipelineEditorView> => {
    setError(null);
    setDetailLoading(true);
    try {
      const editor = await window.sandcastle.runtime.publishPipeline(input);
      setPipelineEditor(editor);
      setSelectedDepartment(
        await window.sandcastle.runtime.inspectDepartment(input.departmentId),
      );
      refresh();
      return editor;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const setPositionSkills = async (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly skillIds: readonly string[];
  }): Promise<SkillConfigurationView> => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const configuration =
        await window.sandcastle.runtime.setPositionSkills(input);
      setSkillConfiguration(configuration);
      return configuration;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const saveSkill = async (input: {
    readonly departmentId: string;
    readonly skillId?: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly version: string;
    readonly locationReference: string;
  }): Promise<SkillConfigurationView> => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const configuration = await window.sandcastle.runtime.saveSkill(input);
      setSkillConfiguration(configuration);
      return configuration;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const archiveSkill = async (input: {
    readonly departmentId: string;
    readonly skillId: string;
    readonly expectedRevision: number;
  }): Promise<SkillConfigurationView> => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const configuration = await window.sandcastle.runtime.archiveSkill(input);
      setSkillConfiguration(configuration);
      return configuration;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const saveSkillFlow = async (input: {
    readonly departmentId: string;
    readonly skillFlowId?: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }): Promise<SkillConfigurationView> => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const configuration =
        await window.sandcastle.runtime.saveSkillFlow(input);
      setSkillConfiguration(configuration);
      return configuration;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  const archiveSkillFlow = async (input: {
    readonly departmentId: string;
    readonly skillFlowId: string;
    readonly expectedRevision: number;
  }): Promise<SkillConfigurationView> => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const configuration =
        await window.sandcastle.runtime.archiveSkillFlow(input);
      setSkillConfiguration(configuration);
      return configuration;
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setDetailLoading(false);
    }
  };

  if (selectedDepartment && pipelineEditor && skillConfiguration) {
    return (
      <DepartmentDetailView
        department={selectedDepartment}
        t={t}
        activeTab={activeTab}
        onBack={() => {
          setSelectedDepartment(null);
          setPipelineEditor(null);
          setSkillConfiguration(null);
        }}
        onTabChange={setActiveTab}
        onUpdateDepartment={updateDepartment}
        onArchiveDepartment={archiveDepartment}
        onCopyDepartment={copyDepartment}
        onUpdatePosition={updatePosition}
        onCreatePosition={createPosition}
        onArchivePosition={archivePosition}
        onCreateSecretReference={createSecretReference}
        onArchiveSecretReference={archiveSecretReference}
        onSaveExecutionProfile={saveExecutionProfile}
        onArchiveExecutionProfile={archiveExecutionProfile}
        pipelineEditor={pipelineEditor}
        skillConfiguration={skillConfiguration}
        skillErrorCode={skillErrorCode}
        onSetPositionSkills={setPositionSkills}
        onSaveSkill={saveSkill}
        onArchiveSkill={archiveSkill}
        onSaveSkillFlow={saveSkillFlow}
        onArchiveSkillFlow={archiveSkillFlow}
        onSavePipelineDraft={savePipelineDraft}
        onValidatePipeline={validatePipeline}
        onPublishPipeline={publishPipeline}
        busy={detailLoading}
        error={error}
      />
    );
  }

  return (
    <section className="page" data-page="departments">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t.departmentsEyebrow}</span>
          <h1>{t.departmentsTitle}</h1>
          <p>{t.departmentsBody}</p>
        </div>
      </div>
      {error ? <div className="warn">{error}</div> : null}
      <div className="project-dashboard">
        <section className="project-grid" aria-label={t.departmentsTitle}>
          {departments === null ? (
            <div className="empty-state">{t.loadingProjects}</div>
          ) : departments.length === 0 ? (
            <div className="empty-state">
              <strong>{t.noDepartments}</strong>
              <span>{t.noDepartmentsBody}</span>
            </div>
          ) : (
            departments.map((department) => (
              <button
                className="project-card department-card"
                data-department-id={department.id}
                disabled={detailLoading}
                key={department.id}
                onClick={() => void inspectDepartment(department.id)}
                type="button"
              >
                <span className="project-card-top">
                  <strong>{departmentName(t, department)}</strong>
                  <span className="pill primary">
                    {statusName(t, department.status)}
                  </span>
                </span>
                <span className="project-summary">
                  {department.description || t.departmentPipeline}
                </span>
                <span className="project-meta-grid">
                  <span>
                    {t.positionsTab} <strong>{department.positionCount}</strong>
                  </span>
                  <span>
                    {t.pipelineTab}{" "}
                    <strong>
                      {department.publishedPipelineVersion === null
                        ? t.none
                        : `v${department.publishedPipelineVersion}`}
                    </strong>
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
        <aside className="create-panel">
          <h2>{t.createDepartment}</h2>
          <form className="form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="company-department-name">{t.name}</label>
            <input
              id="company-department-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <button type="submit">{t.createDepartmentButton}</button>
          </form>
        </aside>
      </div>
    </section>
  );
}

export type DepartmentTab = "overview" | "positions" | "pipeline";

export function DepartmentDetailView({
  department,
  t,
  activeTab,
  onBack,
  onTabChange,
  onUpdateDepartment,
  onArchiveDepartment,
  onCopyDepartment,
  onCreatePosition,
  onUpdatePosition,
  onArchivePosition,
  onCreateSecretReference,
  onArchiveSecretReference,
  onSaveExecutionProfile,
  onArchiveExecutionProfile,
  pipelineEditor,
  onSavePipelineDraft,
  onValidatePipeline,
  onPublishPipeline,
  skillConfiguration,
  skillErrorCode = null,
  onSetPositionSkills,
  onSaveSkill,
  onArchiveSkill,
  onSaveSkillFlow,
  onArchiveSkillFlow,
  busy = false,
  error = null,
}: {
  readonly department: DepartmentInspect;
  readonly t: Messages;
  readonly activeTab: DepartmentTab;
  readonly onBack: () => void;
  readonly onTabChange: (tab: DepartmentTab) => void;
  readonly onUpdateDepartment: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly inputArtifactContracts: readonly ArtifactContract[];
    readonly outputArtifactContracts: readonly ArtifactContract[];
    readonly defaultExecutionProfileId: string | null;
  }) => Promise<void>;
  readonly onArchiveDepartment: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
  readonly onCopyDepartment: (input: {
    readonly departmentId: string;
    readonly name: string;
  }) => Promise<void>;
  readonly onCreatePosition: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
  }) => Promise<void>;
  readonly onUpdatePosition: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
    readonly aiMemberStatus: "active" | "inactive";
  }) => Promise<void>;
  readonly onArchivePosition: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
  readonly onCreateSecretReference: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly providerScope: string;
  }) => Promise<void>;
  readonly onArchiveSecretReference: (input: {
    readonly departmentId: string;
    readonly secretReferenceId: string;
  }) => Promise<void>;
  readonly onSaveExecutionProfile: SandcastleBridgeRuntimeSaveExecutionProfile;
  readonly onArchiveExecutionProfile: (input: {
    readonly departmentId: string;
    readonly executionProfileId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
  readonly pipelineEditor: DepartmentPipelineEditorView;
  readonly onSavePipelineDraft: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly graph: DepartmentPipelineDraftGraph;
  }) => Promise<DepartmentPipelineEditorView>;
  readonly onValidatePipeline: (input: {
    readonly departmentId: string;
    readonly graph: DepartmentPipelineDraftGraph;
  }) => Promise<PipelineValidationResult>;
  readonly onPublishPipeline: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }) => Promise<DepartmentPipelineEditorView>;
  readonly skillConfiguration: SkillConfigurationView;
  readonly skillErrorCode?: string | null;
  readonly onSetPositionSkills: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
  readonly onSaveSkill: (input: {
    readonly departmentId: string;
    readonly skillId?: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly version: string;
    readonly locationReference: string;
  }) => Promise<SkillConfigurationView>;
  readonly onArchiveSkill: (input: {
    readonly departmentId: string;
    readonly skillId: string;
    readonly expectedRevision: number;
  }) => Promise<SkillConfigurationView>;
  readonly onSaveSkillFlow: (input: {
    readonly departmentId: string;
    readonly skillFlowId?: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
  readonly onArchiveSkillFlow: (input: {
    readonly departmentId: string;
    readonly skillFlowId: string;
    readonly expectedRevision: number;
  }) => Promise<SkillConfigurationView>;
  readonly busy?: boolean;
  readonly error?: string | null;
}) {
  const [name, setName] = useState(department.name);
  const [description, setDescription] = useState(department.description);
  const [inputArtifactContracts, setInputArtifactContracts] = useState([
    ...department.inputArtifactContracts,
  ]);
  const [outputArtifactContracts, setOutputArtifactContracts] = useState([
    ...department.outputArtifactContracts,
  ]);
  const [defaultExecutionProfileId, setDefaultExecutionProfileId] = useState(
    department.defaultExecutionProfileId,
  );
  const [copyName, setCopyName] = useState(`${department.name} Copy`);
  useEffect(() => {
    setName(department.name);
    setDescription(department.description);
    setInputArtifactContracts([...department.inputArtifactContracts]);
    setOutputArtifactContracts([...department.outputArtifactContracts]);
    setDefaultExecutionProfileId(department.defaultExecutionProfileId);
    setCopyName(`${department.name} Copy`);
  }, [department]);
  return (
    <section
      className="page"
      data-page="department-detail"
      data-runtime-department-id={department.id}
    >
      <header className="page-heading department-detail-heading">
        <div>
          <button className="text-button" onClick={onBack} type="button">
            {t.backToDepartments}
          </button>
          <span className="eyebrow">{t.departmentDetailEyebrow}</span>
          <h1>{departmentName(t, department)}</h1>
          <p>{department.description}</p>
        </div>
        <div className="department-version-summary">
          <span className="pill primary">
            {department.builtIn ? t.builtInDepartment : t.customDepartment}
          </span>
          <strong>
            {department.pipeline
              ? `${t.publishedPipeline} v${department.pipeline.version}`
              : t.noPublishedPipelineShort}
          </strong>
        </div>
      </header>
      {error ? (
        <div
          className="warn"
          data-skill-error-code={skillErrorCode ?? undefined}
        >
          {skillRuntimeErrorMessage(t, skillErrorCode, error)}
        </div>
      ) : null}
      <div className="department-tabs" role="tablist">
        {(
          [
            ["overview", t.overviewTab],
            ["positions", t.positionsTab],
            ["pipeline", t.pipelineTab],
          ] as const
        ).map(([tab, label]) => (
          <button
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "on" : ""}
            data-department-tab={tab}
            key={tab}
            onClick={() => onTabChange(tab)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? (
        <section
          className="department-overview-grid"
          data-department-panel="overview"
        >
          <article className="create-panel">
            <h2>{t.departmentSettings}</h2>
            <form
              className="form department-settings-form"
              data-department-settings
              onSubmit={(event) => {
                event.preventDefault();
                void onUpdateDepartment({
                  departmentId: department.id,
                  expectedRevision: department.revision,
                  name: name.trim(),
                  description: description.trim(),
                  inputArtifactContracts,
                  outputArtifactContracts,
                  defaultExecutionProfileId,
                });
              }}
            >
              <label htmlFor="department-detail-name">{t.name}</label>
              <input
                id="department-detail-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
              <label htmlFor="department-detail-description">
                {t.description}
              </label>
              <textarea
                id="department-detail-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
              />
              <fieldset
                className="department-config-section"
                data-default-execution-profile
              >
                <legend>{t.activeProfile}</legend>
                <p className="field-help">{t.activeProfileHint}</p>
                <select
                  aria-label={t.activeProfile}
                  id="department-default-execution-profile"
                  onChange={(event) =>
                    setDefaultExecutionProfileId(event.target.value || null)
                  }
                  value={defaultExecutionProfileId ?? ""}
                >
                  <option value="">{t.none}</option>
                  {department.executionProfiles
                    .filter((profile) => profile.status === "active")
                    .map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                </select>
              </fieldset>
              <ArtifactContractsEditor
                contracts={inputArtifactContracts}
                label={t.inputArtifactContracts}
                hint={t.inputArtifactContractsHint}
                emptyText={t.noInputArtifactContracts}
                owner="input"
                setContracts={setInputArtifactContracts}
                t={t}
              />
              <ArtifactContractsEditor
                contracts={outputArtifactContracts}
                label={t.outputArtifactContracts}
                hint={t.outputArtifactContractsHint}
                emptyText={t.noOutputArtifactContracts}
                owner="output"
                setContracts={setOutputArtifactContracts}
                t={t}
              />
              <button disabled={busy} type="submit">
                {t.saveDepartment}
              </button>
            </form>
          </article>
          <article className="create-panel">
            <h2>{t.departmentConfiguration}</h2>
            <dl className="overview-inventory">
              <div>
                <dt>{t.status}</dt>
                <dd>{statusName(t, department.status)}</dd>
              </div>
              <div>
                <dt>{t.positionsTab}</dt>
                <dd>
                  {department.positions.length} {t.positionsCountSuffix}
                </dd>
              </div>
              <div>
                <dt>{t.pipelineTab}</dt>
                <dd>
                  {department.pipeline
                    ? `${t.publishedPipeline} v${department.pipeline.version}`
                    : t.noPublishedPipelineShort}
                </dd>
              </div>
              <div>
                <dt>{t.metricActiveRuns}</dt>
                <dd>{department.activeRuns}</dd>
              </div>
            </dl>
          </article>
          <ExecutionProfileConfiguration
            busy={busy}
            department={department}
            onArchive={onArchiveExecutionProfile}
            onSave={onSaveExecutionProfile}
            t={t}
          />
          <SecretReferenceConfiguration
            busy={busy}
            department={department}
            onArchive={onArchiveSecretReference}
            onCreate={onCreateSecretReference}
            t={t}
          />
          <article className="create-panel department-actions-panel">
            <h2>{t.departmentActions}</h2>
            <form
              className="form"
              data-department-copy-form
              onSubmit={(event) => {
                event.preventDefault();
                void onCopyDepartment({
                  departmentId: department.id,
                  name: copyName.trim(),
                });
              }}
            >
              <label htmlFor="department-copy-name">{t.copyName}</label>
              <input
                id="department-copy-name"
                value={copyName}
                onChange={(event) => setCopyName(event.target.value)}
                required
              />
              <button disabled={busy} type="submit">
                {t.copyDepartment}
              </button>
            </form>
            <button
              className="danger-button"
              data-department-archive
              disabled={busy}
              onClick={() =>
                void onArchiveDepartment({
                  departmentId: department.id,
                  expectedRevision: department.revision,
                })
              }
              type="button"
            >
              {t.archiveDepartment}
            </button>
          </article>
        </section>
      ) : null}

      {activeTab === "positions" ? (
        <section data-department-panel="positions">
          <div className="position-grid">
            {department.positions.map((position) => (
              <PositionEditor
                busy={busy}
                departmentId={department.id}
                key={position.id}
                onArchive={onArchivePosition}
                onUpdate={onUpdatePosition}
                position={position}
                t={t}
              />
            ))}
            <NewPositionEditor
              busy={busy}
              departmentId={department.id}
              onCreate={onCreatePosition}
              t={t}
            />
          </div>
          <SkillConfigurationPanel
            busy={busy}
            configuration={skillConfiguration}
            onArchiveSkillFlow={onArchiveSkillFlow}
            onArchiveSkill={onArchiveSkill}
            onSaveSkill={onSaveSkill}
            onSaveSkillFlow={onSaveSkillFlow}
            onSetPositionSkills={onSetPositionSkills}
            t={t}
          />
        </section>
      ) : null}

      {activeTab === "pipeline" ? (
        <PipelineEditor
          busy={busy}
          department={department}
          editor={pipelineEditor}
          skillConfiguration={skillConfiguration}
          onPublish={onPublishPipeline}
          onSave={onSavePipelineDraft}
          onValidate={onValidatePipeline}
          t={t}
        />
      ) : null}
    </section>
  );
}

function ArtifactContractsEditor({
  contracts,
  setContracts,
  label,
  hint,
  emptyText,
  owner,
  t,
}: {
  readonly contracts: readonly ArtifactContract[];
  readonly setContracts: React.Dispatch<
    React.SetStateAction<ArtifactContract[]>
  >;
  readonly label: string;
  readonly hint: string;
  readonly emptyText: string;
  readonly owner: string;
  readonly t: Messages;
}) {
  const update = (index: number, next: Partial<ArtifactContract>): void => {
    setContracts((current) =>
      current.map((contract, candidateIndex) =>
        candidateIndex === index ? { ...contract, ...next } : contract,
      ),
    );
  };
  return (
    <fieldset
      className="artifact-contract-editor"
      data-artifact-contracts={owner}
    >
      <legend>{label}</legend>
      <p className="field-help">{hint}</p>
      {contracts.length === 0 ? (
        <div className="configuration-empty-state">{emptyText}</div>
      ) : null}
      {contracts.map((contract, index) => (
        <div className="pipeline-edge-editor" key={`${contract.id}:${index}`}>
          <input
            aria-label={`${label} ID`}
            onChange={(event) => update(index, { id: event.target.value })}
            required
            value={contract.id}
          />
          <input
            aria-label={`${label} name`}
            onChange={(event) => update(index, { name: event.target.value })}
            required
            value={contract.name}
          />
          <input
            aria-label={`${label} type`}
            onChange={(event) =>
              update(index, { artifactType: event.target.value })
            }
            required
            value={contract.artifactType}
          />
          <input
            aria-label={`${label} schema version`}
            onChange={(event) =>
              update(index, { schemaVersion: event.target.value })
            }
            required
            value={contract.schemaVersion}
          />
          <label>
            <input
              checked={contract.required}
              onChange={(event) =>
                update(index, { required: event.target.checked })
              }
              type="checkbox"
            />
            {t.activeStatus}
          </label>
          <button
            className="danger-button"
            onClick={() =>
              setContracts((current) =>
                current.filter(
                  (_candidate, candidateIndex) => candidateIndex !== index,
                ),
              )
            }
            type="button"
          >
            {t.removeArtifactContract}
          </button>
        </div>
      ))}
      <button
        data-add-artifact-contract={owner}
        onClick={() =>
          setContracts((current) => [
            ...current,
            {
              id: `${owner}-${current.length + 1}`,
              name: `${label} ${current.length + 1}`,
              artifactType: "application/json",
              schemaVersion: "1",
              required: true,
            },
          ])
        }
        type="button"
      >
        {t.addArtifactContract}
      </button>
    </fieldset>
  );
}

function ExecutionProfileConfiguration({
  department,
  t,
  busy,
  onSave,
  onArchive,
}: {
  readonly department: DepartmentInspect;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: SandcastleBridgeRuntimeSaveExecutionProfile;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly executionProfileId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
}) {
  return (
    <article className="create-panel" data-execution-profiles>
      <h2>{t.executionProfiles}</h2>
      {department.executionProfiles.map((profile) => (
        <ExecutionProfileEditor
          busy={busy}
          department={department}
          key={profile.id}
          onArchive={onArchive}
          onSave={onSave}
          profile={profile}
          t={t}
        />
      ))}
      <ExecutionProfileEditor
        busy={busy}
        department={department}
        onArchive={onArchive}
        onSave={onSave}
        t={t}
      />
    </article>
  );
}

function ExecutionProfileEditor({
  department,
  profile,
  t,
  busy,
  onSave,
  onArchive,
}: {
  readonly department: DepartmentInspect;
  readonly profile?: DepartmentInspect["executionProfiles"][number];
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: SandcastleBridgeRuntimeSaveExecutionProfile;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly executionProfileId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [providerRef, setProviderRef] = useState(profile?.providerRef ?? "");
  const [model, setModel] = useState(profile?.model ?? "");
  const [sandboxRef, setSandboxRef] = useState(profile?.sandboxRef ?? "");
  const [branchStrategy, setBranchStrategy] = useState<
    "head" | "merge-to-head" | "branch"
  >(profile?.branchStrategy ?? "head");
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    profile?.limits.timeoutSeconds ?? 600,
  );
  const [maxIterations, setMaxIterations] = useState(
    profile?.limits.maxIterations ?? 5,
  );
  const [maxTokens, setMaxTokens] = useState<string>(
    profile?.limits.maxTokens?.toString() ?? "",
  );
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(
    profile?.retryPolicy.maxAttempts ?? 1,
  );
  const [permissionPolicy, setPermissionPolicy] = useState<
    "ask" | "allow-safe" | "deny"
  >(profile?.permissionPolicy ?? "ask");
  const [secretReferenceIds, setSecretReferenceIds] = useState([
    ...(profile?.secretReferenceIds ?? []),
  ]);
  return (
    <form
      className="form skill-flow-card"
      data-execution-profile-editor={profile?.id ?? "new"}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          departmentId: department.id,
          ...(profile ? { executionProfileId: profile.id } : {}),
          expectedRevision: profile?.revision ?? 0,
          name: name.trim(),
          providerRef: providerRef.trim(),
          model: model.trim(),
          sandboxRef: sandboxRef.trim(),
          branchStrategy,
          timeoutSeconds,
          maxIterations,
          maxTokens: maxTokens.trim() === "" ? null : Number(maxTokens),
          retryMaxAttempts,
          permissionPolicy,
          secretReferenceIds,
        }).catch(() => undefined);
      }}
    >
      <h3>{profile ? profile.name : t.createExecutionProfile}</h3>
      <label>{t.executionProfileName}</label>
      <input
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
      />
      <label>{t.providerRef}</label>
      <input
        onChange={(event) => setProviderRef(event.target.value)}
        required
        value={providerRef}
      />
      <label>{t.model}</label>
      <input
        onChange={(event) => setModel(event.target.value)}
        required
        value={model}
      />
      <label>{t.sandboxRef}</label>
      <input
        onChange={(event) => setSandboxRef(event.target.value)}
        required
        value={sandboxRef}
      />
      <label>{t.branchStrategy}</label>
      <select
        onChange={(event) =>
          setBranchStrategy(
            event.target.value as "head" | "merge-to-head" | "branch",
          )
        }
        value={branchStrategy}
      >
        <option value="head">head</option>
        <option value="merge-to-head">merge-to-head</option>
        <option value="branch">branch</option>
      </select>
      <label>{t.timeoutSeconds}</label>
      <input
        min={1}
        onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
        type="number"
        value={timeoutSeconds}
      />
      <label>{t.maxIterations}</label>
      <input
        min={1}
        onChange={(event) => setMaxIterations(Number(event.target.value))}
        type="number"
        value={maxIterations}
      />
      <label>{t.maxTokens}</label>
      <input
        min={1}
        onChange={(event) => setMaxTokens(event.target.value)}
        type="number"
        value={maxTokens}
      />
      <label>{t.retryMaxAttempts}</label>
      <input
        min={0}
        onChange={(event) => setRetryMaxAttempts(Number(event.target.value))}
        type="number"
        value={retryMaxAttempts}
      />
      <label>{t.permissionPolicy}</label>
      <select
        onChange={(event) =>
          setPermissionPolicy(
            event.target.value as "ask" | "allow-safe" | "deny",
          )
        }
        value={permissionPolicy}
      >
        <option value="ask">ask</option>
        <option value="allow-safe">allow-safe</option>
        <option value="deny">deny</option>
      </select>
      <fieldset>
        <legend>{t.secretReferences}</legend>
        {department.secretReferences
          .filter((reference) => reference.status === "active")
          .map((reference) => (
            <label key={reference.id}>
              <input
                checked={secretReferenceIds.includes(reference.id)}
                onChange={(event) =>
                  setSecretReferenceIds((current) =>
                    event.target.checked
                      ? [...current, reference.id]
                      : current.filter((id) => id !== reference.id),
                  )
                }
                type="checkbox"
              />
              {reference.name}
            </label>
          ))}
      </fieldset>
      <div className="action-bar">
        <button disabled={busy || profile?.status === "archived"} type="submit">
          {t.saveExecutionProfile}
        </button>
        {profile ? (
          <button
            className="danger-button"
            data-archive-execution-profile={profile.id}
            disabled={busy || profile.status === "archived"}
            onClick={() =>
              void onArchive({
                departmentId: department.id,
                executionProfileId: profile.id,
                expectedRevision: profile.revision,
              }).catch(() => undefined)
            }
            type="button"
          >
            {t.archiveDepartment}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function SecretReferenceConfiguration({
  department,
  t,
  busy,
  onCreate,
  onArchive,
}: {
  readonly department: DepartmentInspect;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onCreate: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly providerScope: string;
  }) => Promise<void>;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly secretReferenceId: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [providerScope, setProviderScope] = useState("");
  return (
    <article className="create-panel" data-secret-references>
      <h2>{t.secretReferences}</h2>
      <p>{t.noSecretValueStored}</p>
      {department.secretReferences.map((reference) => (
        <div
          className="task-card"
          data-secret-reference={reference.id}
          key={reference.id}
        >
          <strong>{reference.name}</strong>
          <span>{reference.providerScope}</span>
          <button
            className="danger-button"
            disabled={busy || reference.status === "archived"}
            onClick={() =>
              void onArchive({
                departmentId: department.id,
                secretReferenceId: reference.id,
              }).catch(() => undefined)
            }
            type="button"
          >
            {t.archiveDepartment}
          </button>
        </div>
      ))}
      <form
        className="form"
        data-new-secret-reference
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            departmentId: department.id,
            name: name.trim(),
            providerScope: providerScope.trim(),
          })
            .then(() => {
              setName("");
              setProviderScope("");
            })
            .catch(() => undefined);
        }}
      >
        <label>{t.secretReferenceName}</label>
        <input
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <label>{t.providerScope}</label>
        <input
          onChange={(event) => setProviderScope(event.target.value)}
          required
          value={providerScope}
        />
        <button disabled={busy} type="submit">
          {t.createSecretReference}
        </button>
      </form>
    </article>
  );
}

function NewPositionEditor({
  departmentId,
  t,
  busy,
  onCreate,
}: {
  readonly departmentId: string;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onCreate: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [responsibility, setResponsibility] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [profile, setProfile] = useState("");
  return (
    <article className="position-card" data-new-position>
      <h3>{t.createPosition}</h3>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            departmentId,
            name: name.trim(),
            responsibility: responsibility.trim(),
            aiMemberDisplayName: displayName.trim(),
            aiMemberProfile: profile,
            aiMemberResponsibilityMetadata: {},
          }).catch(() => undefined);
        }}
      >
        <label>{t.name}</label>
        <input
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <label>{t.responsibility}</label>
        <textarea
          onChange={(event) => setResponsibility(event.target.value)}
          required
          value={responsibility}
        />
        <label>{t.aiMemberDisplayName}</label>
        <input
          onChange={(event) => setDisplayName(event.target.value)}
          required
          value={displayName}
        />
        <label>{t.aiMemberProfile}</label>
        <textarea
          onChange={(event) => setProfile(event.target.value)}
          value={profile}
        />
        <button disabled={busy} type="submit">
          {t.createPosition}
        </button>
      </form>
    </article>
  );
}

function SkillConfigurationPanel({
  configuration,
  t,
  busy,
  onSetPositionSkills,
  onSaveSkill,
  onArchiveSkill,
  onSaveSkillFlow,
  onArchiveSkillFlow,
}: {
  readonly configuration: SkillConfigurationView;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSetPositionSkills: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
  readonly onSaveSkill: (input: {
    readonly departmentId: string;
    readonly skillId?: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly version: string;
    readonly locationReference: string;
  }) => Promise<SkillConfigurationView>;
  readonly onArchiveSkill: (input: {
    readonly departmentId: string;
    readonly skillId: string;
    readonly expectedRevision: number;
  }) => Promise<SkillConfigurationView>;
  readonly onSaveSkillFlow: (input: {
    readonly departmentId: string;
    readonly skillFlowId?: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
  readonly onArchiveSkillFlow: (input: {
    readonly departmentId: string;
    readonly skillFlowId: string;
    readonly expectedRevision: number;
  }) => Promise<SkillConfigurationView>;
}) {
  return (
    <section
      className="skill-configuration"
      data-skill-configuration
      data-skill-configuration-revision={configuration.revision}
    >
      <article className="create-panel" data-skill-catalog>
        <div className="stage-heading">
          <div>
            <h2>{t.skillCatalog}</h2>
            <p>{t.skillCatalogBody}</p>
          </div>
          <span className="pill">
            {t.skillConfigurationRevision} {configuration.revision}
          </span>
        </div>
        <div className="skill-catalog-grid">
          {configuration.activeSkills.map((skill) => (
            <article
              className="skill-card"
              data-skill-id={skill.id}
              key={skill.id}
            >
              <div className="project-card-top">
                <strong>{skill.name}</strong>
                <span className="pill">{skill.version}</span>
              </div>
              <p>{skill.description}</p>
              <code>{skill.locationReference}</code>
              <button
                className="danger-button"
                data-archive-skill={skill.id}
                disabled={busy}
                onClick={() =>
                  void onArchiveSkill({
                    departmentId: configuration.department.id,
                    skillId: skill.id,
                    expectedRevision: configuration.revision,
                  }).catch(() => undefined)
                }
                type="button"
              >
                {t.archiveSkill}
              </button>
            </article>
          ))}
        </div>
        <NewSkillEditor
          busy={busy}
          configuration={configuration}
          onSave={onSaveSkill}
          t={t}
        />
      </article>
      {configuration.positions.map((position) => {
        const flows = configuration.skillFlows.filter(
          (flow) => flow.positionId === position.id,
        );
        return (
          <article
            className="create-panel position-skill-panel"
            key={position.id}
          >
            <h2>{position.name}</h2>
            <PositionSkillBindingEditor
              busy={busy}
              configuration={configuration}
              onSave={onSetPositionSkills}
              position={position}
              t={t}
            />
            <div className="skill-flow-list">
              <h3>{t.skillFlows}</h3>
              {flows.length === 0 ? (
                <div className="empty-state">{t.noSkillFlows}</div>
              ) : (
                flows.map((flow) =>
                  flow.status === "active" ? (
                    <SkillFlowEditor
                      availableSkillIds={position.skillIds}
                      busy={busy}
                      configuration={configuration}
                      flow={flow}
                      key={flow.id}
                      onArchive={onArchiveSkillFlow}
                      onSave={onSaveSkillFlow}
                      t={t}
                    />
                  ) : (
                    <article
                      className="skill-flow-card archived"
                      data-skill-flow-history={flow.id}
                      key={flow.id}
                    >
                      <strong>{flow.name}</strong>
                      <span className="pill">{t.archivedStatus}</span>
                    </article>
                  ),
                )
              )}
              <NewSkillFlowEditor
                availableSkillIds={position.skillIds}
                busy={busy}
                configuration={configuration}
                onSave={onSaveSkillFlow}
                positionId={position.id}
                t={t}
              />
            </div>
          </article>
        );
      })}
    </section>
  );
}

function NewSkillEditor({
  configuration,
  t,
  busy,
  onSave,
}: {
  readonly configuration: SkillConfigurationView;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly version: string;
    readonly locationReference: string;
  }) => Promise<SkillConfigurationView>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("local");
  const [version, setVersion] = useState("1");
  const [locationReference, setLocationReference] = useState("");
  return (
    <form
      className="form skill-flow-card new"
      data-new-skill
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          departmentId: configuration.department.id,
          expectedRevision: configuration.revision,
          name: name.trim(),
          description,
          source: source.trim(),
          version: version.trim(),
          locationReference: locationReference.trim(),
        })
          .then(() => {
            setName("");
            setDescription("");
            setLocationReference("");
          })
          .catch(() => undefined);
      }}
    >
      <h3>{t.createSkill}</h3>
      <label htmlFor="new-skill-name">{t.name}</label>
      <input
        id="new-skill-name"
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
      />
      <label htmlFor="new-skill-description">{t.description}</label>
      <textarea
        id="new-skill-description"
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        value={description}
      />
      <label htmlFor="new-skill-source">{t.skillSource}</label>
      <input
        id="new-skill-source"
        onChange={(event) => setSource(event.target.value)}
        required
        value={source}
      />
      <label htmlFor="new-skill-version">{t.skillVersion}</label>
      <input
        id="new-skill-version"
        onChange={(event) => setVersion(event.target.value)}
        required
        value={version}
      />
      <label htmlFor="new-skill-location">{t.skillLocationReference}</label>
      <input
        id="new-skill-location"
        onChange={(event) => setLocationReference(event.target.value)}
        required
        value={locationReference}
      />
      <button disabled={busy} type="submit">
        {t.createSkill}
      </button>
    </form>
  );
}

function PositionSkillBindingEditor({
  configuration,
  position,
  t,
  busy,
  onSave,
}: {
  readonly configuration: SkillConfigurationView;
  readonly position: SkillConfigurationView["positions"][number];
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
}) {
  const [skillIds, setSkillIds] = useState([...position.skillIds]);
  useEffect(() => setSkillIds([...position.skillIds]), [position]);
  return (
    <form
      className="form position-skill-binding"
      data-position-skill-binding={position.id}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          departmentId: configuration.department.id,
          positionId: position.id,
          expectedRevision: configuration.revision,
          skillIds,
        }).catch(() => undefined);
      }}
    >
      <fieldset>
        <legend>{t.positionSkills}</legend>
        {configuration.activeSkills.map((skill) => (
          <label key={skill.id}>
            <input
              checked={skillIds.includes(skill.id)}
              data-position-skill={`${position.id}:${skill.id}`}
              onChange={(event) =>
                setSkillIds((current) =>
                  event.target.checked
                    ? [...current, skill.id]
                    : current.filter((skillId) => skillId !== skill.id),
                )
              }
              type="checkbox"
            />
            {skill.name}
          </label>
        ))}
      </fieldset>
      <button
        data-save-position-skills={position.id}
        disabled={busy}
        type="submit"
      >
        {t.savePositionSkills}
      </button>
    </form>
  );
}

function SkillFlowEditor({
  configuration,
  flow,
  availableSkillIds,
  t,
  busy,
  onSave,
  onArchive,
}: {
  readonly configuration: SkillConfigurationView;
  readonly flow: SkillConfigurationView["skillFlows"][number];
  readonly availableSkillIds: readonly string[];
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: (input: {
    readonly departmentId: string;
    readonly skillFlowId?: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly skillFlowId: string;
    readonly expectedRevision: number;
  }) => Promise<SkillConfigurationView>;
}) {
  const [name, setName] = useState(flow.name);
  const [instructions, setInstructions] = useState(flow.instructions);
  const [skillIds, setSkillIds] = useState([...flow.skillIds]);
  useEffect(() => {
    setName(flow.name);
    setInstructions(flow.instructions);
    setSkillIds([...flow.skillIds]);
  }, [flow]);
  const availableSkills = configuration.activeSkills.filter((skill) =>
    availableSkillIds.includes(skill.id),
  );
  return (
    <form
      className="form skill-flow-card"
      data-skill-flow-editor={flow.id}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          departmentId: configuration.department.id,
          skillFlowId: flow.id,
          positionId: flow.positionId,
          expectedRevision: flow.revision,
          name: name.trim(),
          instructions,
          skillIds,
        }).catch(() => undefined);
      }}
    >
      <label htmlFor={`skill-flow-name-${flow.id}`}>{t.skillFlowName}</label>
      <input
        data-skill-flow-name={flow.id}
        id={`skill-flow-name-${flow.id}`}
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
      />
      <label htmlFor={`skill-flow-instructions-${flow.id}`}>
        {t.skillFlowInstructions}
      </label>
      <textarea
        data-skill-flow-instructions={flow.id}
        id={`skill-flow-instructions-${flow.id}`}
        onChange={(event) => setInstructions(event.target.value)}
        rows={4}
        value={instructions}
      />
      <SkillSelection
        availableSkills={availableSkills}
        ownerId={flow.id}
        selectedSkillIds={skillIds}
        setSelectedSkillIds={setSkillIds}
      />
      <div className="action-bar">
        <button data-save-skill-flow={flow.id} disabled={busy} type="submit">
          {t.saveSkillFlow}
        </button>
        <button
          className="danger-button"
          data-archive-skill-flow={flow.id}
          disabled={busy}
          onClick={() =>
            void onArchive({
              departmentId: configuration.department.id,
              skillFlowId: flow.id,
              expectedRevision: flow.revision,
            }).catch(() => undefined)
          }
          type="button"
        >
          {t.archiveSkillFlow}
        </button>
      </div>
    </form>
  );
}

function NewSkillFlowEditor({
  configuration,
  positionId,
  availableSkillIds,
  t,
  busy,
  onSave,
}: {
  readonly configuration: SkillConfigurationView;
  readonly positionId: string;
  readonly availableSkillIds: readonly string[];
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }) => Promise<SkillConfigurationView>;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const availableSkills = configuration.activeSkills.filter((skill) =>
    availableSkillIds.includes(skill.id),
  );
  return (
    <form
      className="form skill-flow-card new"
      data-new-skill-flow={positionId}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          departmentId: configuration.department.id,
          positionId,
          expectedRevision: 0,
          name: name.trim(),
          instructions,
          skillIds,
        })
          .then(() => {
            setName("");
            setInstructions("");
            setSkillIds([]);
          })
          .catch(() => undefined);
      }}
    >
      <h4>{t.createSkillFlow}</h4>
      <label htmlFor={`new-skill-flow-name-${positionId}`}>
        {t.skillFlowName}
      </label>
      <input
        id={`new-skill-flow-name-${positionId}`}
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
      />
      <label htmlFor={`new-skill-flow-instructions-${positionId}`}>
        {t.skillFlowInstructions}
      </label>
      <textarea
        id={`new-skill-flow-instructions-${positionId}`}
        onChange={(event) => setInstructions(event.target.value)}
        rows={3}
        value={instructions}
      />
      <SkillSelection
        availableSkills={availableSkills}
        ownerId={`new:${positionId}`}
        selectedSkillIds={skillIds}
        setSelectedSkillIds={setSkillIds}
      />
      <button data-create-skill-flow={positionId} disabled={busy} type="submit">
        {t.createSkillFlow}
      </button>
    </form>
  );
}

function SkillSelection({
  availableSkills,
  ownerId,
  selectedSkillIds,
  setSelectedSkillIds,
}: {
  readonly availableSkills: SkillConfigurationView["activeSkills"];
  readonly ownerId: string;
  readonly selectedSkillIds: readonly string[];
  readonly setSelectedSkillIds: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  return (
    <fieldset>
      {availableSkills.map((skill) => (
        <label key={skill.id}>
          <input
            checked={selectedSkillIds.includes(skill.id)}
            data-skill-flow-skill={`${ownerId}:${skill.id}`}
            onChange={(event) =>
              setSelectedSkillIds((current) =>
                event.target.checked
                  ? [...current, skill.id]
                  : current.filter((skillId) => skillId !== skill.id),
              )
            }
            type="checkbox"
          />
          {skill.name}
        </label>
      ))}
    </fieldset>
  );
}

const pipelineNodeTypes = [
  "start",
  "ai-task",
  "human-approval",
  "condition",
  "parallel",
  "join",
  "complete",
] as const;

function PipelineEditor({
  editor,
  department,
  t,
  busy,
  onSave,
  onValidate,
  onPublish,
  skillConfiguration,
}: {
  readonly editor: DepartmentPipelineEditorView;
  readonly department: DepartmentInspect;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly graph: DepartmentPipelineDraftGraph;
  }) => Promise<DepartmentPipelineEditorView>;
  readonly onValidate: (input: {
    readonly departmentId: string;
    readonly graph: DepartmentPipelineDraftGraph;
  }) => Promise<PipelineValidationResult>;
  readonly onPublish: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }) => Promise<DepartmentPipelineEditorView>;
  readonly skillConfiguration: SkillConfigurationView;
}) {
  const [graph, setGraph] = useState(editor.draft.graph);
  const [validation, setValidation] = useState(editor.validation);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setGraph(editor.draft.graph);
    setValidation(editor.validation);
    setDirty(false);
  }, [editor.department.id, editor.draft.revision, editor.published?.id]);

  const replaceGraph = (nextGraph: DepartmentPipelineDraftGraph): void => {
    setGraph(nextGraph);
    setDirty(true);
  };
  const updateNode = (
    nodeId: string,
    update: (
      node: DepartmentPipelineDraftGraph["nodes"][number],
    ) => DepartmentPipelineDraftGraph["nodes"][number],
  ): void => {
    replaceGraph({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === nodeId ? update(node) : node,
      ),
    });
  };
  const addNode = (): void => {
    let index = graph.nodes.length + 1;
    while (graph.nodes.some((node) => node.id === `node-${index}`)) index += 1;
    replaceGraph({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: `node-${index}`, type: "ai-task", name: `Node ${index}` },
      ],
    });
  };

  return (
    <section
      className="create-panel pipeline-panel pipeline-editor"
      data-department-panel="pipeline"
      data-pipeline-draft-revision={editor.draft.revision}
      data-pipeline-published-version={editor.published?.version}
      data-pipeline-state={editor.published ? "published" : "draft-only"}
    >
      <div className="stage-heading pipeline-editor-heading">
        <div>
          <h2>{t.pipelineTab}</h2>
          <p>
            {t.draftRevision} {editor.draft.revision}
            {dirty ? ` · ${t.unsavedChanges}` : ""}
          </p>
        </div>
        <div className="action-bar">
          <button
            data-pipeline-validate
            disabled={busy}
            onClick={() =>
              void onValidate({
                departmentId: editor.department.id,
                graph,
              })
                .then(setValidation)
                .catch(() => undefined)
            }
            type="button"
          >
            {t.validatePipeline}
          </button>
          <button
            data-pipeline-save
            disabled={busy}
            onClick={() =>
              void onSave({
                departmentId: editor.department.id,
                expectedRevision: editor.draft.revision,
                graph,
              }).catch(() => undefined)
            }
            type="button"
          >
            {t.saveDraft}
          </button>
          <button
            data-pipeline-publish
            disabled={
              busy || dirty || editor.draft.revision === 0 || !validation.valid
            }
            onClick={() =>
              void onPublish({
                departmentId: editor.department.id,
                expectedRevision: editor.draft.revision,
              }).catch(() => undefined)
            }
            type="button"
          >
            {t.publishPipeline}
          </button>
        </div>
      </div>

      {!editor.published ? (
        <div className="pipeline-unpublished-note">
          <strong>{t.noPublishedPipeline}</strong>
          <span>{t.noPublishedPipelineBody}</span>
        </div>
      ) : null}

      <div className="pipeline-editor-grid">
        <section>
          <div className="section-title-row">
            <h3>{t.pipelineNodes}</h3>
            <button data-pipeline-add-node onClick={addNode} type="button">
              {t.addNode}
            </button>
          </div>
          <div className="pipeline-editor-list">
            {graph.nodes.map((node) => (
              <article
                className="pipeline-node-editor"
                data-pipeline-node-editor={node.id}
                key={node.id}
              >
                <label htmlFor={`pipeline-node-name-${node.id}`}>
                  {t.name}
                </label>
                <input
                  id={`pipeline-node-name-${node.id}`}
                  value={node.name}
                  onChange={(event) =>
                    updateNode(node.id, (current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <label htmlFor={`pipeline-node-type-${node.id}`}>
                  {t.nodeType}
                </label>
                <select
                  id={`pipeline-node-type-${node.id}`}
                  value={node.type}
                  onChange={(event) =>
                    updateNode(node.id, (current) => ({
                      ...current,
                      type: event.target.value,
                      ...(!["ai-task", "human-approval"].includes(
                        event.target.value,
                      )
                        ? {
                            positionId: undefined,
                            skillFlowId: undefined,
                            instructions: undefined,
                            executionProfileId: undefined,
                            inputContractRefs: undefined,
                            outputContractRefs: undefined,
                            timeoutSeconds: undefined,
                            retryMaxAttempts: undefined,
                            maxIterations: undefined,
                            maxTokens: undefined,
                          }
                        : event.target.value === "human-approval"
                          ? { skillFlowId: undefined }
                          : {}),
                      ...(event.target.value === "condition"
                        ? {
                            condition: current.condition ?? {
                              leftReference: "",
                              operator: "exists" as const,
                              branches: [
                                {
                                  id: "match",
                                  label: "Match",
                                  kind: "match" as const,
                                },
                                {
                                  id: "default",
                                  label: "Default",
                                  kind: "default" as const,
                                },
                              ],
                            },
                          }
                        : { condition: undefined }),
                    }))
                  }
                >
                  {pipelineNodeTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                {node.type === "ai-task" || node.type === "human-approval" ? (
                  <>
                    <label htmlFor={`pipeline-node-position-${node.id}`}>
                      {t.position}
                    </label>
                    <select
                      id={`pipeline-node-position-${node.id}`}
                      value={node.positionId ?? ""}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          positionId: event.target.value || undefined,
                          skillFlowId: undefined,
                        }))
                      }
                    >
                      <option value="">{t.none}</option>
                      {editor.positions.map((position) => (
                        <option key={position.id} value={position.id}>
                          {position.name}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                {node.type === "ai-task" ? (
                  <>
                    <label htmlFor={`pipeline-node-skill-flow-${node.id}`}>
                      {t.skillFlow}
                    </label>
                    <select
                      data-pipeline-node-skill-flow={node.id}
                      id={`pipeline-node-skill-flow-${node.id}`}
                      value={node.skillFlowId ?? ""}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          skillFlowId: event.target.value || undefined,
                        }))
                      }
                    >
                      <option value="">{t.none}</option>
                      {skillConfiguration.skillFlows
                        .filter(
                          (flow) =>
                            flow.status === "active" &&
                            flow.positionId === node.positionId,
                        )
                        .map((flow) => (
                          <option key={flow.id} value={flow.id}>
                            {flow.name}
                          </option>
                        ))}
                    </select>
                    <label htmlFor={`pipeline-node-instructions-${node.id}`}>
                      {t.skillFlowInstructions}
                    </label>
                    <textarea
                      id={`pipeline-node-instructions-${node.id}`}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          instructions: event.target.value,
                        }))
                      }
                      rows={3}
                      value={node.instructions ?? ""}
                    />
                    <label htmlFor={`pipeline-node-profile-${node.id}`}>
                      {t.executionProfiles}
                    </label>
                    <select
                      id={`pipeline-node-profile-${node.id}`}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          executionProfileId: event.target.value || undefined,
                        }))
                      }
                      value={node.executionProfileId ?? ""}
                    >
                      <option value="">{t.none}</option>
                      {department.executionProfiles
                        .filter((profile) => profile.status === "active")
                        .map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                    </select>
                    <label htmlFor={`pipeline-node-input-contracts-${node.id}`}>
                      {t.inputArtifactContracts}
                    </label>
                    <input
                      id={`pipeline-node-input-contracts-${node.id}`}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          inputContractRefs: event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        }))
                      }
                      value={(node.inputContractRefs ?? []).join(", ")}
                    />
                    <label
                      htmlFor={`pipeline-node-output-contracts-${node.id}`}
                    >
                      {t.outputArtifactContracts}
                    </label>
                    <input
                      id={`pipeline-node-output-contracts-${node.id}`}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          outputContractRefs: event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        }))
                      }
                      value={(node.outputContractRefs ?? []).join(", ")}
                    />
                    <label>{t.timeoutSeconds}</label>
                    <input
                      id={`pipeline-node-timeout-${node.id}`}
                      min={1}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          timeoutSeconds: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        }))
                      }
                      type="number"
                      value={node.timeoutSeconds ?? ""}
                    />
                    <label>{t.retryMaxAttempts}</label>
                    <input
                      id={`pipeline-node-retry-${node.id}`}
                      min={0}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          retryMaxAttempts: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        }))
                      }
                      type="number"
                      value={node.retryMaxAttempts ?? ""}
                    />
                    <label>{t.maxIterations}</label>
                    <input
                      id={`pipeline-node-max-iterations-${node.id}`}
                      min={1}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          maxIterations: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        }))
                      }
                      type="number"
                      value={node.maxIterations ?? ""}
                    />
                    <label>{t.maxTokens}</label>
                    <input
                      id={`pipeline-node-max-tokens-${node.id}`}
                      min={1}
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          maxTokens: event.target.value
                            ? Number(event.target.value)
                            : null,
                        }))
                      }
                      type="number"
                      value={node.maxTokens ?? ""}
                    />
                  </>
                ) : null}
                {node.type === "human-approval" ? (
                  <>
                    <label>{t.approvalTitle ?? "Approval title"}</label>
                    <input
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          approvalTitle: event.target.value,
                        }))
                      }
                      value={node.approvalTitle ?? ""}
                    />
                    <label>{t.permissionPolicy}</label>
                    <select
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          approvalPolicy: event.target.value as
                            | "any"
                            | "all"
                            | "named",
                        }))
                      }
                      value={node.approvalPolicy ?? ""}
                    >
                      <option value="">{t.none}</option>
                      <option value="any">any</option>
                      <option value="all">all</option>
                      <option value="named">named</option>
                    </select>
                    <label>{t.approverReference ?? "Approver reference"}</label>
                    <input
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          approverReference: event.target.value,
                        }))
                      }
                      value={node.approverReference ?? ""}
                    />
                  </>
                ) : null}
                {node.type === "condition" && node.condition ? (
                  <>
                    <label>Left reference</label>
                    <input
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          condition: current.condition
                            ? {
                                ...current.condition,
                                leftReference: event.target.value,
                              }
                            : undefined,
                        }))
                      }
                      value={node.condition.leftReference}
                    />
                    <label>Operator</label>
                    <select
                      onChange={(event) =>
                        updateNode(node.id, (current) => ({
                          ...current,
                          condition: current.condition
                            ? {
                                ...current.condition,
                                operator: event.target.value as
                                  | "equals"
                                  | "not-equals"
                                  | "exists"
                                  | "not-exists"
                                  | "in",
                              }
                            : undefined,
                        }))
                      }
                      value={node.condition.operator}
                    >
                      <option value="equals">equals</option>
                      <option value="not-equals">not-equals</option>
                      <option value="exists">exists</option>
                      <option value="not-exists">not-exists</option>
                      <option value="in">in</option>
                    </select>
                    {node.condition.branches.map((branch, branchIndex) => (
                      <div className="pipeline-edge-editor" key={branch.id}>
                        <input
                          aria-label="Condition branch ID"
                          onChange={(event) =>
                            updateNode(node.id, (current) => ({
                              ...current,
                              condition: current.condition
                                ? {
                                    ...current.condition,
                                    branches: current.condition.branches.map(
                                      (candidate, candidateIndex) =>
                                        candidateIndex === branchIndex
                                          ? {
                                              ...candidate,
                                              id: event.target.value,
                                            }
                                          : candidate,
                                    ),
                                  }
                                : undefined,
                            }))
                          }
                          value={branch.id}
                        />
                        <input
                          aria-label="Condition branch label"
                          onChange={(event) =>
                            updateNode(node.id, (current) => ({
                              ...current,
                              condition: current.condition
                                ? {
                                    ...current.condition,
                                    branches: current.condition.branches.map(
                                      (candidate, candidateIndex) =>
                                        candidateIndex === branchIndex
                                          ? {
                                              ...candidate,
                                              label: event.target.value,
                                            }
                                          : candidate,
                                    ),
                                  }
                                : undefined,
                            }))
                          }
                          value={branch.label}
                        />
                      </div>
                    ))}
                  </>
                ) : null}
                <button
                  className="danger-button"
                  data-pipeline-remove-node={node.id}
                  onClick={() =>
                    replaceGraph({
                      nodes: graph.nodes.filter(
                        (candidate) => candidate.id !== node.id,
                      ),
                      edges: graph.edges.filter(
                        (edge) => edge.from !== node.id && edge.to !== node.id,
                      ),
                    })
                  }
                  type="button"
                >
                  {t.removeNode}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section>
          <div className="section-title-row">
            <h3>{t.pipelineEdges}</h3>
            <button
              data-pipeline-add-edge
              disabled={graph.nodes.length < 2}
              onClick={() => {
                const from = graph.nodes[0]?.id;
                const to = graph.nodes[1]?.id;
                if (from && to) {
                  replaceGraph({
                    ...graph,
                    edges: [...graph.edges, { from, to }],
                  });
                }
              }}
              type="button"
            >
              {t.addEdge}
            </button>
          </div>
          <div className="pipeline-editor-list">
            {graph.edges.map((edge, index) => (
              <article
                className="pipeline-edge-editor"
                data-pipeline-edge-editor={`${edge.from}:${edge.to}`}
                key={`${edge.from}:${edge.to}:${index}`}
              >
                <label htmlFor={`pipeline-edge-from-${index}`}>
                  {t.fromNode}
                </label>
                <select
                  id={`pipeline-edge-from-${index}`}
                  value={edge.from}
                  onChange={(event) =>
                    replaceGraph({
                      ...graph,
                      edges: graph.edges.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, from: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                >
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
                </select>
                <label htmlFor={`pipeline-edge-to-${index}`}>{t.toNode}</label>
                <select
                  id={`pipeline-edge-to-${index}`}
                  value={edge.to}
                  onChange={(event) =>
                    replaceGraph({
                      ...graph,
                      edges: graph.edges.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, to: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                >
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
                </select>
                {graph.nodes.find((node) => node.id === edge.from)?.type ===
                "condition" ? (
                  <>
                    <label htmlFor={`pipeline-edge-branch-${index}`}>
                      Branch
                    </label>
                    <select
                      id={`pipeline-edge-branch-${index}`}
                      onChange={(event) =>
                        replaceGraph({
                          ...graph,
                          edges: graph.edges.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  branchId: event.target.value || undefined,
                                }
                              : candidate,
                          ),
                        })
                      }
                      value={edge.branchId ?? ""}
                    >
                      <option value="">{t.none}</option>
                      {graph.nodes
                        .find((node) => node.id === edge.from)
                        ?.condition?.branches.map((branch) => (
                          <option key={branch.id} value={branch.id}>
                            {branch.label}
                          </option>
                        ))}
                    </select>
                  </>
                ) : null}
                <button
                  className="danger-button"
                  data-pipeline-remove-edge={index}
                  onClick={() =>
                    replaceGraph({
                      ...graph,
                      edges: graph.edges.filter(
                        (_candidate, candidateIndex) =>
                          candidateIndex !== index,
                      ),
                    })
                  }
                  type="button"
                >
                  {t.removeEdge}
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section
        className={
          validation.valid
            ? "pipeline-validation valid"
            : "pipeline-validation invalid"
        }
        data-pipeline-validation={validation.valid ? "valid" : "invalid"}
      >
        <h3>{validation.valid ? t.pipelineValid : t.pipelineInvalid}</h3>
        {validation.issues.length > 0 ? (
          <ul>
            {validation.issues.map((issue, index) => (
              <li
                data-validation-code={issue.code}
                key={`${issue.code}:${index}`}
              >
                {pipelineValidationMessage(t, issue.code)}
                {issue.nodeId ? ` (${issue.nodeId})` : ""}
                {issue.edge ? ` (${issue.edge.from} → ${issue.edge.to})` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="pipeline-history">
        <h3>{t.versionHistory}</h3>
        {editor.history.length === 0 ? (
          <span>{t.noPublishedPipelineShort}</span>
        ) : (
          <ol>
            {editor.history.map((version) => (
              <li
                data-pipeline-history-version={version.version}
                key={version.id}
              >
                <strong>
                  {t.publishedVersion} v{version.version}
                </strong>
                <span>
                  {version.nodeCount} {t.pipelineNodes.toLowerCase()} ·{" "}
                  {version.edgeCount} {t.pipelineEdges.toLowerCase()} ·{" "}
                  {version.hash.slice(0, 12)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

const pipelineValidationMessage = (t: Messages, code: string): string => {
  const key = `validation${code
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}` as keyof Messages;
  return t[key] ?? code;
};

function PositionEditor({
  departmentId,
  position,
  t,
  busy,
  onArchive,
  onUpdate,
}: {
  readonly departmentId: string;
  readonly position: DepartmentInspect["positions"][number];
  readonly t: Messages;
  readonly busy: boolean;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
  readonly onUpdate: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
    readonly aiMemberStatus: "active" | "inactive";
  }) => Promise<void>;
}) {
  const [responsibility, setResponsibility] = useState(position.responsibility);
  const [displayName, setDisplayName] = useState(position.aiMember.displayName);
  const [profile, setProfile] = useState(position.aiMember.profile);
  const [status, setStatus] = useState(position.aiMember.status);
  useEffect(() => {
    setResponsibility(position.responsibility);
    setDisplayName(position.aiMember.displayName);
    setProfile(position.aiMember.profile);
    setStatus(position.aiMember.status);
  }, [position]);

  return (
    <article
      className="position-card"
      data-position-editor={position.id}
      data-position-id={position.id}
    >
      <div className="project-card-top">
        <strong>{positionName(t, position)}</strong>
        <span className="pill">{statusName(t, status)}</span>
      </div>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void onUpdate({
            departmentId,
            positionId: position.id,
            expectedRevision: position.revision,
            name: position.name,
            responsibility: responsibility.trim(),
            aiMemberDisplayName: displayName.trim(),
            aiMemberProfile: profile,
            aiMemberResponsibilityMetadata:
              position.aiMember.responsibilityMetadata,
            aiMemberStatus: status,
          });
        }}
      >
        <label htmlFor={`position-responsibility-${position.id}`}>
          {t.responsibility}
        </label>
        <textarea
          id={`position-responsibility-${position.id}`}
          value={responsibility}
          onChange={(event) => setResponsibility(event.target.value)}
          rows={4}
          required
        />
        <label htmlFor={`position-member-name-${position.id}`}>
          {t.aiMemberDisplayName}
        </label>
        <input
          id={`position-member-name-${position.id}`}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
        />
        <label htmlFor={`position-member-status-${position.id}`}>
          {t.status}
        </label>
        <label htmlFor={`position-member-profile-${position.id}`}>
          Profile
        </label>
        <textarea
          id={`position-member-profile-${position.id}`}
          value={profile}
          onChange={(event) => setProfile(event.target.value)}
          rows={3}
        />
        <select
          id={`position-member-status-${position.id}`}
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as "active" | "inactive")
          }
        >
          <option value="active">{t.activeStatus}</option>
          <option value="inactive">{t.inactiveStatus}</option>
        </select>
        <button disabled={busy} type="submit">
          {t.savePosition}
        </button>
        <button
          className="danger-button"
          data-archive-position={position.id}
          disabled={busy || position.status === "archived"}
          onClick={() =>
            void onArchive({
              departmentId,
              positionId: position.id,
              expectedRevision: position.revision,
            }).catch(() => undefined)
          }
          type="button"
        >
          {t.archivePosition}
        </button>
      </form>
    </article>
  );
}

export function CompanyArtifactsPage({ t }: { readonly t: Messages }) {
  const [artifacts, setArtifacts] = useState<readonly ArtifactVersionView[]>(
    [],
  );
  const [selectedLineage, setSelectedLineage] =
    useState<ArtifactLineageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setArtifactStatus = (
    artifact: ArtifactVersionView,
    status: "accepted" | "rejected",
  ): void => {
    void window.sandcastle.runtime
      .setArtifactStatus({
        versionId: artifact.id,
        expectedStatus: artifact.status,
        status,
      })
      .then((updated) => {
        setArtifacts((current) =>
          current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
        if (selectedLineage?.version.id === updated.id) {
          return window.sandcastle.runtime
            .inspectArtifact(updated.id)
            .then(setSelectedLineage);
        }
      })
      .catch((nextError: unknown) => setError(errorMessage(nextError)));
  };
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => window.sandcastle.runtime.projects())
      .then((projects) =>
        Promise.all(
          projects.map((project) =>
            window.sandcastle.runtime.artifacts(project.id),
          ),
        ),
      )
      .then((groups) => {
        if (active) setArtifacts(groups.flat());
      })
      .catch((nextError: unknown) => {
        if (active) setError(errorMessage(nextError));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="page" data-page="artifacts">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t.artifacts}</span>
          <h1>{t.deliveryArtifacts}</h1>
          <p>{t.deliveryArtifactsBody}</p>
        </div>
      </div>
      {error ? <div className="warn">{error}</div> : null}
      {artifacts.length === 0 ? (
        <div className="empty-state">
          <strong>{t.noDeliveryArtifacts}</strong>
          <span>{t.noDeliveryArtifactsBody}</span>
        </div>
      ) : (
        <ol className="project-grid" data-artifact-registry>
          {artifacts.map((artifact) => (
            <li
              className="project-card"
              data-artifact-version={artifact.id}
              key={artifact.id}
            >
              <strong>
                {artifact.logicalName} v{artifact.version}
              </strong>
              <span>
                {artifact.type} · {artifact.schemaVersion}
              </span>
              <span>
                {artifact.status} · {artifact.contentHash.slice(0, 12)}
              </span>
              <span>
                {t.runRevision}: {artifact.producer.runId}
              </span>
              <button
                onClick={() =>
                  void window.sandcastle.runtime
                    .inspectArtifact(artifact.id)
                    .then(setSelectedLineage)
                    .catch((nextError: unknown) =>
                      setError(errorMessage(nextError)),
                    )
                }
                type="button"
              >
                {t.inspectArtifactLineage}
              </button>
              {artifact.status === "produced" ? (
                <div className="button-row">
                  <button
                    data-artifact-status="accepted"
                    onClick={() => setArtifactStatus(artifact, "accepted")}
                    type="button"
                  >
                    {t.acceptArtifact}
                  </button>
                  <button
                    className="danger-button"
                    data-artifact-status="rejected"
                    onClick={() => setArtifactStatus(artifact, "rejected")}
                    type="button"
                  >
                    {t.rejectArtifact}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {selectedLineage ? (
        <ArtifactLineagePanel lineage={selectedLineage} t={t} />
      ) : null}
    </section>
  );
}

export function ArtifactLineagePanel({
  lineage,
  t,
}: {
  readonly lineage: ArtifactLineageView;
  readonly t: Messages;
}) {
  const { version } = lineage;
  return (
    <section data-artifact-lineage={version.id} className="create-panel">
      <h2>{t.artifactLineage}</h2>
      <strong>
        {version.logicalName} v{version.version}
      </strong>
      <span>
        {t.artifactProducer}: {version.producer.runId} ·{" "}
        {version.producer.nodeRunId}
      </span>
      <span>
        {version.producer.nodeAttemptId} · {version.producer.snapshotRevisionId}{" "}
        · {version.producer.aiMemberId}
      </span>
      <h3>{t.artifactInputs}</h3>
      {lineage.inputs.length === 0 ? (
        <span>{t.noArtifactInputs}</span>
      ) : (
        <ul>
          {lineage.inputs.map((input) => (
            <li key={`${input.versionId}:${input.relation}`}>
              {input.versionId} · {input.relation}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CompanyInteractionPage({ t }: { readonly t: Messages }) {
  const [projectId, setProjectId] = useState("");
  const [sessions, setSessions] = useState<readonly InteractionView[]>([]);
  const [selected, setSelected] = useState<InteractionView | null>(null);
  const [message, setMessage] = useState("");
  const [permissionScope, setPermissionScope] = useState("");
  const [memorySummary, setMemorySummary] = useState("");
  const [memoryCandidates, setMemoryCandidates] = useState<
    readonly MemoryCandidateView[]
  >([]);
  const [agUi, setAgUi] = useState<AgUiReplayView>({
    events: [],
    nextSequence: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const refresh = async (nextProjectId = projectId) => {
    if (!nextProjectId) return;
    const [next, candidates] = await Promise.all([
      window.sandcastle.runtime.interactions(nextProjectId),
      window.sandcastle.runtime.memoryCandidates(nextProjectId),
    ]);
    setSessions(next);
    setMemoryCandidates(candidates);
    setSelected((current) =>
      current
        ? (next.find((item) => item.session.id === current.session.id) ??
          current)
        : (next[0] ?? null),
    );
  };

  useEffect(() => {
    let active = true;
    window.sandcastle.runtime
      .projects()
      .then(async (projects) => {
        const nextProjectId = projects[0]?.id ?? "";
        if (!active) return;
        setProjectId(nextProjectId);
        if (nextProjectId) await refresh(nextProjectId);
      })
      .catch(
        (nextError: unknown) => active && setError(errorMessage(nextError)),
      );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    window.sandcastle.runtime
      .agUiEvents({ afterSequence: 0, limit: 100 })
      .then(setAgUi)
      .catch((nextError: unknown) => setError(errorMessage(nextError)));
  }, [selected?.messages.length, selected?.permissions.length]);

  const createSession = async () => {
    if (!projectId) return;
    try {
      const session = await window.sandcastle.runtime.createInteractionSession({
        projectId,
        mode: "consultation",
      });
      await window.sandcastle.runtime.addInteractionParticipant({
        sessionId: session.id,
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      });
      setSelected(
        await window.sandcastle.runtime.inspectInteraction(session.id),
      );
      await refresh(projectId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const sendMessage = async () => {
    const participant = selected?.participants.find(
      (candidate) => candidate.participantType === "human",
    );
    if (!selected || !participant || !message.trim()) return;
    await window.sandcastle.runtime.addInteractionMessage({
      sessionId: selected.session.id,
      participantId: participant.id,
      kind: "text",
      content: message.trim(),
    });
    setMessage("");
    setSelected(
      await window.sandcastle.runtime.inspectInteraction(selected.session.id),
    );
  };

  const closeSession = async () => {
    if (!selected || selected.session.status === "closed") return;
    try {
      await window.sandcastle.runtime.closeInteractionSession(
        selected.session.id,
      );
      await refresh(selected.session.projectId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const requestPermission = async () => {
    if (!selected || !permissionScope.trim()) return;
    await window.sandcastle.runtime.requestPermission({
      sessionId: selected.session.id,
      scope: permissionScope.trim(),
    });
    setPermissionScope("");
    setSelected(
      await window.sandcastle.runtime.inspectInteraction(selected.session.id),
    );
  };

  const decidePermission = async (
    permissionId: string,
    decision: "approved" | "denied",
  ) => {
    if (!selected) return;
    await window.sandcastle.runtime.decidePermission({
      permissionId,
      expectedStatus: "pending",
      decision,
    });
    setSelected(
      await window.sandcastle.runtime.inspectInteraction(selected.session.id),
    );
  };

  const createMemoryCandidate = async () => {
    if (!selected || !memorySummary.trim()) return;
    await window.sandcastle.runtime.createMemoryCandidate({
      projectId: selected.session.projectId,
      scope: "project",
      sourceSessionId: selected.session.id,
      summary: memorySummary.trim(),
    });
    setMemorySummary("");
    await refresh(selected.session.projectId);
  };

  const reviewMemoryCandidate = async (
    candidateId: string,
    decision: "approved" | "discarded",
  ) => {
    await window.sandcastle.runtime.reviewMemoryCandidate({
      candidateId,
      expectedStatus: "pending",
      decision,
    });
    if (selected) await refresh(selected.session.projectId);
  };

  return (
    <section className="page" data-page="interaction">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t.agentInteraction}</span>
          <h1>{t.agentInteraction}</h1>
          <p>{t.agentInteractionBody}</p>
        </div>
        <button
          disabled={!projectId}
          onClick={() => void createSession()}
          type="button"
        >
          {t.createConsultation}
        </button>
      </div>
      {error ? <div className="warn">{error}</div> : null}
      <div className="project-dashboard">
        <ol className="project-grid">
          {sessions.map((item) => (
            <li className="project-card" key={item.session.id}>
              <button onClick={() => setSelected(item)} type="button">
                {item.session.mode} · {item.messages.length}
              </button>
            </li>
          ))}
        </ol>
        {selected ? (
          <section
            className="create-panel"
            data-interaction-session={selected.session.id}
          >
            <h2>{t.messages}</h2>
            <button
              disabled={selected.session.status === "closed"}
              onClick={() => void closeSession()}
              type="button"
            >
              {t.closeSession}
            </button>
            <span data-ag-ui-cursor={agUi.nextSequence}>
              AG-UI: {agUi.events.map((event) => event.type).join(", ")}
            </span>
            {selected.messages.map((item) => (
              <p data-session-message={item.id} key={item.id}>
                {item.content}
              </p>
            ))}
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <button onClick={() => void sendMessage()} type="button">
              {t.sendMessage}
            </button>
            <h3>{t.permissions}</h3>
            <input
              value={permissionScope}
              onChange={(event) => setPermissionScope(event.target.value)}
            />
            <button onClick={() => void requestPermission()} type="button">
              {t.requestPermission}
            </button>
            {selected.permissions.map((permission) => (
              <div data-permission-request={permission.id} key={permission.id}>
                <span>
                  {permission.scope} · {permission.status}
                </span>
                {permission.status === "pending" ? (
                  <div className="action-bar">
                    <button
                      onClick={() =>
                        void decidePermission(permission.id, "approved")
                      }
                      type="button"
                    >
                      {t.approve}
                    </button>
                    <button
                      onClick={() =>
                        void decidePermission(permission.id, "denied")
                      }
                      type="button"
                    >
                      {t.reject}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            <h3>{t.memoryCandidates}</h3>
            <textarea
              value={memorySummary}
              onChange={(event) => setMemorySummary(event.target.value)}
            />
            <button onClick={() => void createMemoryCandidate()} type="button">
              {t.createMemoryCandidate}
            </button>
            {memoryCandidates.map((candidate) => (
              <div data-memory-candidate={candidate.id} key={candidate.id}>
                <span>
                  {candidate.summary} · {candidate.status}
                </span>
                {candidate.status === "pending" ? (
                  <div className="action-bar">
                    <button
                      onClick={() =>
                        void reviewMemoryCandidate(candidate.id, "approved")
                      }
                      type="button"
                    >
                      {t.approve}
                    </button>
                    <button
                      onClick={() =>
                        void reviewMemoryCandidate(candidate.id, "discarded")
                      }
                      type="button"
                    >
                      {t.discard}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  );
}

export function SettingsPage({
  t,
  language,
  onLanguageChange,
}: {
  readonly t: Messages;
  readonly language: Language;
  readonly onLanguageChange: (language: Language) => void;
}) {
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnosticsView | null>(
    null,
  );
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState<RuntimeBackupView | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const refreshDiagnostics = async () => {
    setDiagnostics(await window.sandcastle.runtime.runtimeDiagnostics());
  };
  useEffect(() => {
    let active = true;
    window.sandcastle.runtime
      .runtimeDiagnostics()
      .then((next) => {
        if (active) setDiagnostics(next);
      })
      .catch((error: unknown) => {
        if (active) setDiagnosticsError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);
  const compact = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    try {
      await window.sandcastle.runtime.compactRuntimeEvents({
        retainLast: 1_000,
      });
      await refreshDiagnostics();
    } catch (error) {
      setDiagnosticsError(errorMessage(error));
    } finally {
      setDiagnosticsBusy(false);
    }
  };
  const backup = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    try {
      setLastBackup(await window.sandcastle.runtime.backupRuntime());
      await refreshDiagnostics();
    } catch (error) {
      setDiagnosticsError(errorMessage(error));
    } finally {
      setDiagnosticsBusy(false);
    }
  };
  return (
    <section className="page" data-page="settings">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t.settingsEyebrow}</span>
          <h1>{t.localPreferences}</h1>
          <p>{t.settingsBody}</p>
        </div>
      </div>
      <section className="create-panel settings-panel">
        <h2>{t.language}</h2>
        <div className="action-bar">
          <button
            className={language === "en" ? "active" : ""}
            onClick={() => onLanguageChange("en")}
            type="button"
          >
            {t.english}
          </button>
          <button
            className={language === "zh" ? "active" : ""}
            onClick={() => onLanguageChange("zh")}
            type="button"
          >
            {t.chinese}
          </button>
        </div>
      </section>
      {diagnosticsError ? <div className="warn">{diagnosticsError}</div> : null}
      {diagnostics ? (
        <RuntimeDiagnosticsPanel
          busy={diagnosticsBusy}
          diagnostics={diagnostics}
          lastBackup={lastBackup}
          onBackup={backup}
          onCompact={compact}
          t={t}
        />
      ) : null}
    </section>
  );
}

export function RuntimeDiagnosticsPanel({
  busy,
  diagnostics,
  lastBackup,
  onBackup,
  onCompact,
  t,
}: {
  readonly busy: boolean;
  readonly diagnostics: RuntimeDiagnosticsView;
  readonly lastBackup: RuntimeBackupView | null;
  readonly onBackup: () => Promise<void>;
  readonly onCompact: () => Promise<void>;
  readonly t: Messages;
}) {
  return (
    <section className="create-panel settings-panel" data-runtime-diagnostics>
      <h2>{t.runtimeDiagnostics}</h2>
      <div className="project-grid">
        <span>
          {t.runtimeSchema} v{diagnostics.schemaVersion}
        </span>
        <span>
          {t.sqliteIntegrity}: {diagnostics.sqliteIntegrity}
        </span>
        <span>
          {t.databaseBytes}: {diagnostics.databaseBytes}
        </span>
        <span>
          {t.runtimeEvents}: {diagnostics.runtimeEventCount}
        </span>
        <span>
          {t.pendingRuntimeEvents}: {diagnostics.pendingRuntimeEventCount}
        </span>
        <span>
          {t.auditRecords}: {diagnostics.auditRecordCount}
        </span>
        <span>
          {t.activeLeases}: {diagnostics.activeLeaseCount}
        </span>
        <span>
          {t.durableCursors}: {diagnostics.cursorCount}
        </span>
      </div>
      <button disabled={busy} onClick={() => void onCompact()} type="button">
        {t.compactRuntimeEvents}
      </button>
      <button disabled={busy} onClick={() => void onBackup()} type="button">
        {t.createRuntimeBackup}
      </button>
      {lastBackup ? (
        <span data-runtime-backup={lastBackup.path}>
          {t.lastRuntimeBackup}: {lastBackup.createdAt} · v
          {lastBackup.schemaVersion}
        </span>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
