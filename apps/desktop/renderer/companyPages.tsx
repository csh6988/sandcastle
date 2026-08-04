import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ArtifactContract,
  ArtifactVersionView,
  ArtifactLineageView,
  InteractionView,
  MemoryCandidateView,
  MemoryEntryView,
  LegacyMemoryRecordView,
  CompanyDepartment,
  CompanyOverview,
  CompanyProject,
  DepartmentInspect,
  DepartmentRunView,
  DepartmentPipelineDraftGraph,
  DepartmentPipelineEditorView,
  PipelineValidationResult,
  ProductDiscoveryView,
  ProductReviewStateView,
  TechnicalReviewStateView,
  WorkPackageGraphView,
  CodeReviewView,
  IntegrationGenerationView,
  ProductProposalContent,
  ProjectEditorView,
  ReviewTopicView,
  RuntimeDiagnosticsView,
  RuntimeBackupView,
  RunSupervisionView,
  SkillConfigurationView,
  AgentCatalogView,
  SkillCatalogView,
  CandidateQualityGateView,
  DeliveryCandidateView,
  AcceptedDeliveryCandidateAuthorityView,
  ReleaseOperationEnvelopeCommand,
  ReleaseOperationView,
  ImprovementProposalRevisionContent,
  ImprovementProposalView,
  StatisticsEvidenceSnapshotView,
  StatisticsInspectInput,
  StatisticsView,
  StatisticsWindow,
} from "../runtime/interface.js";
import { WorkPackageGraphPanel } from "./workPackageView.js";
import {
  departmentName,
  pipelineNodeName,
  positionName,
  statusName,
  type Language,
  type Messages,
} from "./i18n.js";
import {
  saveDepartmentSettings,
  type DepartmentSettingsSaveOperation,
} from "./departmentSettingsSave.js";
import { Icon, IconButton, type IconName } from "./icons.js";
import {
  applyRunSupervisionFrame,
  connectRunSupervision,
  RunSupervisionPanel,
  type RunSupervisionConnection,
} from "./runSupervision.js";
import {
  connectReviewsEventStream,
  type ReviewsEventConnection,
} from "./reviewsEventConnection.js";
import { createRuntimeViewConnectionCoordinator } from "./runtimeViewConnectionCoordinator.js";
import { ReleaseOperationPanel } from "./releaseOperationPanel.js";
import {
  ProjectImprovementsPanel,
  type ImprovementProposalDraft,
} from "./projectImprovementsPanel.js";
import {
  connectStatisticsEventStream,
  type StatisticsEventConnection,
} from "./statisticsEventConnection.js";

type ProjectRuntimeViewConnection =
  | {
      readonly kind: "runs";
      readonly connection: RunSupervisionConnection;
      readonly close: () => Promise<void>;
    }
  | {
      readonly kind: "reviews";
      readonly connection: ReviewsEventConnection;
      readonly close: () => Promise<void>;
    }
  | {
      readonly kind: "improvements";
      readonly connection: StatisticsEventConnection;
      readonly close: () => Promise<void>;
    };

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ? error.message
      : String(error);

const formatAgentTimestamp = (value: string): string => {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
};

export const isAgentTestDisabled = (
  testingAgentIds: ReadonlySet<string>,
  agentId: string,
  agentStatus: AgentCatalogView["agents"][number]["status"],
): boolean => testingAgentIds.has(agentId) || agentStatus !== "installed";

const fuzzyMatch = (query: string, text: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  let queryIndex = 0;
  for (const character of text.toLowerCase()) {
    if (character === normalizedQuery[queryIndex]) queryIndex += 1;
    if (queryIndex === normalizedQuery.length) return true;
  }
  return false;
};

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
    SKILL_UNAVAILABLE: t.skillErrorSkillUnavailable,
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

export function AgentsPage({
  t,
  initialCatalog,
}: {
  readonly t: Messages;
  readonly initialCatalog?: AgentCatalogView;
}) {
  const [catalog, setCatalog] = useState<AgentCatalogView | null>(
    initialCatalog ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set());
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  useEffect(() => {
    window.sandcastle.runtime
      .discoverAgents()
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        setError(null);
      })
      .catch((nextError: unknown) => setError(errorMessage(nextError)));
  }, []);

  return (
    <section className="page" data-page="agents">
      <header className="page-heading agent-page-heading">
        <div>
          <span className="eyebrow">{t.agentsEyebrow}</span>
          <h1>{t.agentsTitle}</h1>
          <p>{t.agentsBody}</p>
        </div>
        <button
          className="detect-agents-button"
          data-detect-agents
          type="button"
          onClick={() => {
            setError(null);
            void window.sandcastle.runtime
              .discoverAgents()
              .then((nextCatalog) => {
                setCatalog(nextCatalog);
                setError(null);
              })
              .catch((nextError: unknown) => setError(errorMessage(nextError)));
          }}
        >
          {t.detectAgents}
          <Icon name="refresh" size={20} />
        </button>
      </header>
      {error ? <div className="warn">{error}</div> : null}
      <section className="catalog-grid" aria-label={t.agentsTitle}>
        {catalog?.agents.map((agent) => (
          <article
            className={`catalog-card agent-card${testing.has(agent.id) ? " is-testing" : ""}`}
            data-agent-id={agent.id}
            aria-busy={testing.has(agent.id)}
            key={agent.id}
          >
            <div className="project-card-top agent-card-heading">
              <strong>{agent.name}</strong>
              <span className="pill">{agent.status}</span>
            </div>
            <dl className="catalog-meta agent-meta">
              <div>
                <dt>{t.agentVersion}</dt>
                <dd>{agent.version ?? t.notAvailable}</dd>
              </div>
              <div className="catalog-meta-block">
                <dt>{t.agentExecutable}</dt>
                <dd
                  className="catalog-path"
                  title={agent.executablePath ?? undefined}
                >
                  {agent.executablePath ?? t.notAvailable}
                </dd>
              </div>
              <div>
                <dt>{t.agentDetectedAt}</dt>
                <dd>
                  <time
                    dateTime={agent.lastDetectedAt}
                    title={agent.lastDetectedAt}
                  >
                    {formatAgentTimestamp(agent.lastDetectedAt)}
                  </time>
                </dd>
              </div>
            </dl>
            <div className="agent-capabilities" data-agent-capabilities>
              {agent.capabilities.map((capability) => (
                <span className="capability-pill" key={capability}>
                  {capability}
                </span>
              ))}
            </div>
            <div className="agent-card-actions">
              <button
                className="agent-test-button"
                type="button"
                data-test-agent={agent.id}
                disabled={isAgentTestDisabled(testing, agent.id, agent.status)}
                onClick={() => {
                  setTesting((current) => {
                    const next = new Set(current);
                    next.add(agent.id);
                    return next;
                  });
                  void window.sandcastle.runtime
                    .testAgent(agent.id)
                    .then((result) => {
                      setError(null);
                      setTestResult((current) => ({
                        ...current,
                        [agent.id]: result.summary,
                      }));
                    })
                    .catch((nextError: unknown) =>
                      setError(errorMessage(nextError)),
                    )
                    .finally(() => {
                      setTesting((current) => {
                        const next = new Set(current);
                        next.delete(agent.id);
                        return next;
                      });
                    });
                }}
              >
                {t.testAgent}
              </button>
              {testResult[agent.id] ? (
                <span className="agent-test-result success">
                  {testResult[agent.id]}
                </span>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </section>
  );
}

export function SkillsPage({
  t,
  initialCatalog,
}: {
  readonly t: Messages;
  readonly initialCatalog?: SkillCatalogView;
}) {
  const [catalog, setCatalog] = useState<SkillCatalogView | null>(
    initialCatalog ?? null,
  );
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    window.sandcastle.runtime
      .discoverSkills()
      .then(setCatalog)
      .catch((nextError: unknown) => setError(errorMessage(nextError)));
  }, []);
  const mutate = (operation: Promise<SkillCatalogView>) =>
    void operation
      .then(setCatalog)
      .catch((nextError: unknown) => setError(errorMessage(nextError)));
  const addDirectory = () => {
    const nextDirectory = directory.trim();
    if (!nextDirectory) return;
    mutate(window.sandcastle.runtime.discoverSkills([nextDirectory]));
    setDirectory("");
  };
  return (
    <section className="page" data-page="skills">
      <header className="page-heading skills-page-heading">
        <div>
          <span className="eyebrow">{t.skillsEyebrow}</span>
          <h1>{t.skillsTitle}</h1>
          <p>{t.skillsBody}</p>
        </div>
        <button
          className="refresh-skills-button"
          type="button"
          onClick={() => mutate(window.sandcastle.runtime.discoverSkills())}
        >
          {t.refreshSkills}
          <Icon name="refresh" size={20} />
        </button>
      </header>
      {error ? <div className="warn">{error}</div> : null}
      <label className="search-field">
        <span>{t.searchSkills}</span>
        <Icon name="search" size={20} />
        <input
          placeholder={t.searchSkills}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <section
        className="create-panel skill-directory-panel"
        data-skill-directories
      >
        <h2>{t.skillDirectories}</h2>
        <form
          className="form skill-directory-form"
          onSubmit={(event) => {
            event.preventDefault();
            addDirectory();
          }}
        >
          <input
            data-skill-directory
            placeholder={t.skillDirectoryPlaceholder}
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <button disabled={!directory.trim()} type="submit">
            {t.addSkillDirectory}
          </button>
        </form>
        <ul className="skill-directory-list">
          {(catalog?.directories ?? []).map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      </section>
      <SkillCatalogResults
        onArchive={(skillId) =>
          mutate(window.sandcastle.runtime.archiveDiscoveredSkill(skillId))
        }
        onEnable={(skillId) =>
          mutate(window.sandcastle.runtime.enableSkill(skillId))
        }
        search={search}
        skills={catalog?.skills ?? []}
        t={t}
      />
    </section>
  );
}

export function SkillCatalogResults({
  skills,
  search,
  t,
  onEnable,
  onArchive,
}: {
  readonly skills: SkillCatalogView["skills"];
  readonly search: string;
  readonly t: Messages;
  readonly onEnable: (skillId: string) => void;
  readonly onArchive: (skillId: string) => void;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const nameMatches = normalizedSearch
    ? skills.filter((skill) =>
        skill.name.toLowerCase().includes(normalizedSearch),
      )
    : [];
  const visibleSkills = nameMatches.length
    ? nameMatches
    : skills.filter((skill) => {
        if (!normalizedSearch) return true;
        const searchableText =
          `${skill.name} ${skill.description} ${skill.locationReference}`.toLowerCase();
        return (
          searchableText.includes(normalizedSearch) ||
          fuzzyMatch(normalizedSearch, skill.name)
        );
      });
  return (
    <section
      className="skill-catalog-list"
      data-skill-catalog-list
      aria-label={t.skillsTitle}
    >
      {visibleSkills.map((skill) => (
        <article
          className="skill-catalog-item"
          data-skill-catalog-id={skill.id}
          key={skill.id}
        >
          <span className="skill-catalog-icon" aria-hidden="true">
            {skill.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="skill-catalog-content">
            <div className="skill-catalog-heading">
              <strong>{skill.name}</strong>
              <span
                className={`pill skill-status skill-status-${skill.status}`}
              >
                {skill.status}
              </span>
            </div>
            <p className="skill-catalog-description" title={skill.description}>
              {skill.description}
            </p>
            {skill.requiredCapabilities?.length ? (
              <p
                className="skill-capability-warning"
                data-skill-capability-warning
              >
                {t.requiredAgentCapabilities}:{" "}
                {skill.requiredCapabilities.join(", ")}
              </p>
            ) : null}
            <div className="skill-catalog-meta">
              <details data-skill-source={skill.id}>
                <summary data-view-skill-source={skill.id}>
                  {t.viewSkillSource}
                </summary>
                <code title={skill.locationReference}>
                  {skill.locationReference}
                </code>
              </details>
              <code className="skill-version" title={skill.version}>
                {skill.version}
              </code>
            </div>
          </div>
          <div className="skill-catalog-action">
            {skill.status === "discovered" || skill.status === "unavailable" ? (
              <button
                className="skill-enable-button"
                type="button"
                data-enable-skill={skill.id}
                onClick={() => onEnable(skill.id)}
              >
                {t.enableSkill}
              </button>
            ) : skill.status === "enabled" ? (
              <button
                className="skill-archive-button"
                type="button"
                data-archive-discovered-skill={skill.id}
                onClick={() => onArchive(skill.id)}
              >
                {t.archiveSkill}
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}

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
      <header className="page-heading company-overview-hero">
        <div>
          <span className="eyebrow">{t.overviewEyebrow}</span>
          <h1>{overview?.company.name ?? t.overviewTitle}</h1>
          <p>{t.overviewBody}</p>
        </div>
        <div className="factory-illustration" aria-hidden="true">
          <span className="factory-sun" />
          <div className="factory-hall factory-hall-blue">
            <Icon name="project" size={24} />
          </div>
          <div className="factory-hall factory-hall-violet">
            <Icon name="department" size={24} />
          </div>
          <div className="factory-hall factory-hall-teal">
            <Icon name="member" size={24} />
          </div>
          <div className="factory-track" />
        </div>
      </header>
      {error ? <div className="warn">{error}</div> : null}
      <div className="metric-row overview-metrics">
        <Metric
          icon="run"
          label={t.metricActiveRuns}
          value={overview?.metrics.activeRuns ?? 0}
        />
        <Metric
          icon="approval"
          label={t.metricWaitingApproval}
          value={overview?.metrics.waitingApprovalRuns ?? 0}
        />
        <Metric
          icon="cancel"
          label={t.metricBlockedRuns}
          value={overview?.metrics.blockedRuns ?? 0}
        />
        <Metric
          icon="complete"
          label={t.metricCompletedRuns}
          value={overview?.metrics.completedRuns ?? 0}
        />
      </div>
      <div className="project-dashboard">
        <section className="create-panel">
          <div className="panel-heading-with-icon">
            <Icon name="approval" size={24} />
            <div>
              <h2>{t.attentionQueue}</h2>
              <p>
                {t.approvalHistory} · {t.recoveryOverride}
              </p>
            </div>
          </div>
          {overview?.attention.length ? (
            overview.attention.map((item) => (
              <div
                className={`attention-card attention-${item.kind}`}
                key={`${item.kind}:${item.runId}`}
              >
                <Icon
                  name={item.kind === "approval" ? "approval" : "cancel"}
                  size={24}
                />
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.kind === "approval" ? t.approve : t.recoverRun} ·{" "}
                    {item.runId}
                  </span>
                </div>
                <span className="attention-action-label">
                  {item.kind === "approval" ? t.approve : t.recoverRun}
                </span>
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
          <div className="panel-heading-with-icon">
            <Icon name="member" size={24} />
            <div>
              <h2>{t.companyInventory}</h2>
              <p>{t.currentAiMember}</p>
            </div>
          </div>
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

export const projectCreationInputInvalid = (
  name: string,
  goal: string,
): boolean => name.trim() === "" || goal.trim() === "";

type ProjectDepartmentRunRuntime = Pick<
  (typeof window.sandcastle)["runtime"],
  "startRun" | "executeReady"
>;

const pendingProjectDepartmentRuns = new Map<
  string,
  Promise<DepartmentRunView>
>();

export const startProjectDepartmentRun = async (
  runtime: ProjectDepartmentRunRuntime,
  projectId: string,
  departmentId: string,
  agentOverrideId?: string,
): Promise<DepartmentRunView> => {
  const key = `${projectId}:${departmentId}:${agentOverrideId ?? ""}`;
  const pending = pendingProjectDepartmentRuns.get(key);
  if (pending) return pending;
  const start = (async () => {
    const started = await runtime.startRun({
      projectId,
      departmentId,
      ...(agentOverrideId ? { agentOverrideId } : {}),
    });
    return runtime.executeReady({
      runId: started.run.id,
      expectedRevision: started.run.revision,
    });
  })();
  pendingProjectDepartmentRuns.set(key, start);
  try {
    return await start;
  } finally {
    if (pendingProjectDepartmentRuns.get(key) === start) {
      pendingProjectDepartmentRuns.delete(key);
    }
  }
};

type ProductDiscoveryBridge = Pick<
  typeof window.sandcastle,
  "execute" | "query"
>;

const productCommandId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `product-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const productCommandSucceeded = <Value,>(result: {
  readonly status: "succeeded" | "rejected";
  readonly value?: Value;
  readonly error?: { readonly code: string; readonly message: string };
}): Value => {
  if (result.status === "succeeded") return result.value as Value;
  const error = new Error(result.error?.message ?? "Product command failed.");
  Object.assign(error, {
    code: result.error?.code ?? "PRODUCT_COMMAND_FAILED",
  });
  throw error;
};

export const inspectProjectProductDiscovery = async (
  bridge: ProductDiscoveryBridge,
  projectId: string,
): Promise<ProductDiscoveryView> =>
  (
    await bridge.query({
      type: "product.discovery.inspect",
      projectId,
    })
  ).view;

export const reviseProjectProductProposal = async (
  bridge: ProductDiscoveryBridge,
  input: {
    readonly projectId: string;
    readonly producerSessionId: string;
    readonly content: ProductProposalContent;
  },
): Promise<ProductDiscoveryView> => {
  const current = await inspectProjectProductDiscovery(bridge, input.projectId);
  productCommandSucceeded(
    await bridge.execute({
      commandId: productCommandId(),
      expectedRevision: current.proposal?.revision ?? 0,
      command: {
        type: "product.proposal.revise",
        projectId: input.projectId,
        producerSessionId: input.producerSessionId,
        content: input.content,
      },
    }),
  );
  return inspectProjectProductDiscovery(bridge, input.projectId);
};

export const markProjectProductProposalAwaiting = async (
  bridge: ProductDiscoveryBridge,
  projectId: string,
): Promise<ProductDiscoveryView> => {
  const current = await inspectProjectProductDiscovery(bridge, projectId);
  const proposal = current.proposal;
  if (!proposal) throw new Error("Product Proposal has not been revised yet.");
  productCommandSucceeded(
    await bridge.execute({
      commandId: productCommandId(),
      expectedRevision: proposal.revision,
      command: {
        type: "product.proposal.mark-awaiting-confirmation",
        projectId,
        proposalRevisionId: proposal.currentRevision.id,
        proposalHash: proposal.currentRevision.hash,
      },
    }),
  );
  return inspectProjectProductDiscovery(bridge, projectId);
};

export const confirmProjectProductBaseline = async (
  bridge: ProductDiscoveryBridge,
  projectId: string,
  departmentId: string,
  options: {
    readonly agentOverrideId?: string;
    readonly forkSourceRunId?: string;
    readonly forkSourceSnapshotRevisionId?: string;
  } = {},
): Promise<ProductDiscoveryView> => {
  const current = await inspectProjectProductDiscovery(bridge, projectId);
  const proposal = current.proposal;
  if (!proposal || proposal.status !== "awaiting-confirmation") {
    throw new Error("Product Proposal is not awaiting confirmation.");
  }
  productCommandSucceeded(
    await bridge.execute({
      commandId: productCommandId(),
      expectedRevision: proposal.revision,
      command: {
        type: "confirm-product-baseline",
        projectId,
        departmentId,
        ...options,
        proposalRevisionId: proposal.currentRevision.id,
        proposalHash: proposal.currentRevision.hash,
      },
    }),
  );
  return inspectProjectProductDiscovery(bridge, projectId);
};

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
    if (projectCreationInputInvalid(name, goal)) return;
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
                <span className="card-domain-icon">
                  <Icon name="project" size={24} />
                </span>
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
              aria-invalid={name.length > 0 && name.trim() === ""}
              id="company-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            {name.length > 0 && name.trim() === "" ? (
              <span className="field-help invalid" role="alert">
                {t.completeRequiredFields}
              </span>
            ) : null}
            <label htmlFor="company-project-goal">{t.projectSummary}</label>
            <textarea
              aria-invalid={goal.length > 0 && goal.trim() === ""}
              id="company-project-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={5}
              required
            />
            {goal.length > 0 && goal.trim() === "" ? (
              <span className="field-help invalid" role="alert">
                {t.completeRequiredFields}
              </span>
            ) : null}
            <button
              disabled={projectCreationInputInvalid(name, goal)}
              type="submit"
            >
              {t.createProjectButton}
            </button>
          </form>
        </aside>
      </div>
    </section>
  );
}

type DepartmentRunNodeView = DepartmentRunView["nodes"][number];

const completedNodeStatuses = new Set(["succeeded", "skipped", "cancelled"]);

const activeRunStatuses = new Set([
  "ready",
  "running",
  "waiting-approval",
  "blocked",
  "recovering",
  "paused",
]);

const runProgress = (
  run: DepartmentRunView,
): {
  readonly completed: number;
  readonly total: number;
  readonly percentage: number;
} => {
  const total = run.nodes.length;
  const completed = run.nodes.filter((node) =>
    completedNodeStatuses.has(node.status),
  ).length;
  return {
    completed,
    total,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
};

const currentRunNode = (
  run: DepartmentRunView,
): {
  readonly nodeRun: DepartmentRunNodeView | undefined;
  readonly node:
    | DepartmentRunView["snapshot"]["payload"]["pipelineVersion"]["graph"]["nodes"][number]
    | undefined;
  readonly position:
    | DepartmentRunView["snapshot"]["payload"]["positions"][number]
    | undefined;
} => {
  const priority = [
    "running",
    "waiting-permission",
    "waiting-approval",
    "ready",
    "paused",
    "failed",
  ] as const;
  const nodeRun =
    priority.flatMap((status) =>
      run.nodes.filter((candidate) => candidate.status === status),
    )[0] ??
    [...run.nodes]
      .reverse()
      .find((candidate) => completedNodeStatuses.has(candidate.status)) ??
    run.nodes[0];
  const node = run.snapshot.payload.pipelineVersion.graph.nodes.find(
    (candidate) => candidate.id === nodeRun?.pipelineNodeId,
  );
  const position = node?.positionId
    ? run.snapshot.payload.positions.find(
        (candidate) => candidate.id === node.positionId,
      )
    : undefined;
  return { nodeRun, node, position };
};

const pipelineIconForType = (type: string): IconName => {
  if (type === "start") return "start";
  if (type === "ai-task") return "ai-task";
  if (type === "human-approval") return "human-approval";
  if (type === "condition") return "condition";
  if (type === "parallel" || type === "join") return "parallel";
  if (type === "complete") return "complete";
  return "pipeline";
};

const roleIconForPosition = (name: string): IconName => {
  const normalized = name.toLowerCase();
  if (normalized.includes("plan") || normalized.includes("product"))
    return "planner";
  if (normalized.includes("architect") || normalized.includes("design"))
    return "architect";
  if (normalized.includes("test") || normalized.includes("review"))
    return "tester";
  if (normalized.includes("evaluat") || normalized.includes("verif"))
    return "evaluator";
  return "builder";
};

const structuredValueText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

export const interactionSessionCloseLabel = (
  t: Messages,
  status: InteractionView["session"]["status"],
): string => (status === "closed" ? t.sessionClosed : t.closeSession);

export const interactionStatusLabel = (
  t: Messages,
  content: string,
): string => {
  if (content === "Agent is processing this message.")
    return t.interactionAgentWorking;
  if (content === "Agent response completed.")
    return t.interactionAgentCompleted;
  if (content === "Agent execution is unavailable in this Runtime.")
    return t.interactionAgentUnavailable;
  const missingConfiguration =
    "Agent execution failed because the AI Member has no active Position or Execution Profile.";
  if (content === missingConfiguration)
    return t.interactionAgentConfigurationMissing;
  if (content.startsWith("Agent execution failed: ")) {
    const detail = content
      .slice("Agent execution failed: ".length)
      .split("\n")[0]
      ?.trim();
    return detail
      ? `${t.interactionAgentFailed}: ${detail}`
      : t.interactionAgentFailed;
  }
  return content;
};

type DepartmentRunDetailProps = {
  readonly run: DepartmentRunView;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onDecision: (input: {
    readonly nodeRunId: string;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
  }) => void;
  readonly onRetryApproval?: (nodeRunId: string) => void;
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
};

export const recoveryOverrideInputProvided = (
  provider: string,
  model: string,
  sandbox: string,
  timeout: string,
): boolean =>
  [provider, model, sandbox, timeout].some((value) => value.trim() !== "");

export function DepartmentRunDetail({
  run,
  t,
  busy,
  onDecision,
  onRetryApproval,
  onRetry,
  onContinue,
  onControl,
  onRecover,
  onFork,
}: DepartmentRunDetailProps) {
  const [approvalFeedback, setApprovalFeedback] = useState("");
  const [retryFeedback, setRetryFeedback] = useState("");
  const [recoveryProvider, setRecoveryProvider] = useState("");
  const [recoveryModel, setRecoveryModel] = useState("");
  const [recoverySandbox, setRecoverySandbox] = useState("");
  const [recoveryTimeout, setRecoveryTimeout] = useState("");
  const hasRecoveryOverride = recoveryOverrideInputProvided(
    recoveryProvider,
    recoveryModel,
    recoverySandbox,
    recoveryTimeout,
  );
  const waitingApproval = run.nodes.find(
    (node) =>
      node.nodeType === "human-approval" && node.status === "waiting-approval",
  );
  const expiredApproval = run.nodes.find(
    (node) =>
      node.nodeType === "human-approval" &&
      node.status === "failed" &&
      node.failure?.code === "APPROVAL_EXPIRED" &&
      node.approvals.at(-1)?.status === "expired",
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
    run.nodes.some(
      (node) =>
        node.status === "ready" ||
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
  const progress = runProgress(run);
  const current = currentRunNode(run);
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
      <section className="run-progress" data-run-progress>
        <div className="run-progress-heading">
          <div>
            <span>{t.runProgress}</span>
            <strong>
              {progress.completed} / {progress.total}
            </strong>
          </div>
          <span className="pill">{statusName(t, run.run.status)}</span>
        </div>
        <progress
          aria-label={t.runProgress}
          max={Math.max(progress.total, 1)}
          value={progress.completed}
        />
        <dl className="run-current-context" data-current-node>
          <div>
            <dt>{t.currentNode}</dt>
            <dd>
              {current.node
                ? pipelineNodeName(t, current.node)
                : (current.nodeRun?.pipelineNodeId ?? t.none)}
            </dd>
          </div>
          <div>
            <dt>{t.currentAiMember}</dt>
            <dd>{current.position?.aiMember.displayName ?? t.none}</dd>
          </div>
          <div>
            <dt>{t.interactionPosition}</dt>
            <dd>
              {current.position ? positionName(t, current.position) : t.none}
            </dd>
          </div>
          <div>
            <dt>{t.status}</dt>
            <dd>{statusName(t, run.run.status)}</dd>
          </div>
        </dl>
        <div className="run-execution-info" data-run-execution-info>
          <span className="eyebrow">{t.executionInfo}</span>
          <strong>
            {current.node
              ? pipelineNodeName(t, current.node)
              : (current.nodeRun?.pipelineNodeId ?? t.none)}
          </strong>
          <div data-run-current-activity>
            <span>{t.currentActivity}</span>
            <strong>
              {current.nodeRun ? statusName(t, current.nodeRun.status) : t.none}
            </strong>
            <span>
              {current.position?.aiMember.displayName ?? t.none} ·{" "}
              {current.position ? positionName(t, current.position) : t.none}
            </span>
          </div>
        </div>
      </section>
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
      <ol className="run-node-list" data-run-node-timeline>
        {run.nodes.map((nodeRun) => {
          const node = run.snapshot.payload.pipelineVersion.graph.nodes.find(
            (candidate) => candidate.id === nodeRun.pipelineNodeId,
          );
          return (
            <li
              data-node-run-id={nodeRun.id}
              data-node-run-status={nodeRun.status}
              data-node-handler-kind={nodeRun.handler?.handlerKindId}
              key={nodeRun.id}
            >
              <div
                className="run-node-summary"
                data-run-node-summary={nodeRun.id}
              >
                <Icon
                  name={node ? pipelineIconForType(node.type) : "pipeline"}
                  size={24}
                />
                <strong>
                  {node ? pipelineNodeName(t, node) : nodeRun.pipelineNodeId}
                </strong>
                <span>
                  {t.nodeAttempts}: {nodeRun.attemptCount}
                </span>
                {nodeRun.handler ? (
                  <span data-node-handler-kind-label>
                    {nodeRun.handler.handlerKindId}
                  </span>
                ) : null}
                {current.nodeRun?.id === nodeRun.id ? (
                  <span className="run-node-active-indicator">
                    {t.currentActivity}: {statusName(t, nodeRun.status)} ·{" "}
                    {current.position?.aiMember.displayName ?? t.none}
                  </span>
                ) : null}
              </div>
              <div className="run-node-status">
                <span className="eyebrow">{t.status}</span>
                <strong>{statusName(t, nodeRun.status)}</strong>
              </div>
              <div className="run-node-attempts">
                <span className="eyebrow">{t.attemptHistory}</span>
                {nodeRun.attempts.length > 0 ? (
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
                        {attempt.startedAt || attempt.completedAt ? (
                          <small>
                            {attempt.startedAt ?? t.notStarted} →{" "}
                            {attempt.completedAt ?? t.inProgress}
                          </small>
                        ) : null}
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
                ) : !nodeRun.failure && nodeRun.result === null ? (
                  <span>{t.none}</span>
                ) : null}
              </div>
              <div className="run-node-evidence">
                <span className="eyebrow">{t.evidence}</span>
                {nodeRun.failure ? (
                  <span data-node-failure-code={nodeRun.failure.code}>
                    {nodeRun.failure.code}: {nodeRun.failure.message}
                  </span>
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
                ) : (
                  <span>{t.none}</span>
                )}
                {nodeRun.result !== null ? (
                  <pre data-run-node-result>
                    {structuredValueText(nodeRun.result)}
                  </pre>
                ) : null}
              </div>
              {nodeRun.status !== "queued" ? (
                <div className="run-node-actions">
                  <span className="eyebrow">{t.runActions}</span>
                  <button
                    data-run-fork-node={nodeRun.id}
                    disabled={busy}
                    onClick={() => onFork?.(nodeRun.id)}
                    type="button"
                  >
                    {t.forkRun}
                  </button>
                </div>
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
              className="primary-button"
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
              <Icon name="approval" size={20} />
            </button>
            <button
              className="secondary-button"
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
              <Icon name="edit" size={20} />
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
              <Icon name="cancel" size={20} />
            </button>
          </div>
        </div>
      ) : null}
      {expiredApproval ? (
        <div className="run-retry-actions" data-run-approval-expired>
          <span>{expiredApproval.failure?.message}</span>
          <button
            className="primary-button"
            data-run-approval-retry={expiredApproval.id}
            disabled={busy}
            onClick={() => onRetryApproval?.(expiredApproval.id)}
            type="button"
          >
            {t.retryNode}
            <Icon name="refresh" size={20} />
          </button>
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
            className="primary-button"
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
            <Icon name="refresh" size={20} />
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
            className="primary-button"
            data-run-recover
            disabled={busy || !hasRecoveryOverride}
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
            <Icon name="snapshot" size={20} />
          </button>
          {!hasRecoveryOverride ? (
            <span className="field-help" data-run-recovery-guidance>
              {t.completeRequiredFields}
            </span>
          ) : null}
        </div>
      ) : null}
      {canContinue ? (
        <button
          className="primary-button"
          data-run-continue
          disabled={busy}
          onClick={onContinue}
          type="button"
        >
          {t.continueRun}
          <Icon name="resume" size={20} />
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
              <Icon name="pause" size={20} />
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
              <Icon name="resume" size={20} />
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
              <Icon name="cancel" size={20} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function RunCollaborationWorkspace({
  artifacts = [],
  collaboration,
  consultation,
  busy,
  onDecision,
  onRetryApproval,
  onRetry,
  onContinue,
  onControl,
  onRecover,
  onFork,
  onSend,
  onPermissionDecision,
  onPermissionRequest,
  run,
  t,
}: {
  readonly artifacts?: readonly ArtifactVersionView[];
  readonly collaboration: InteractionView;
  readonly consultation: InteractionView | null;
  readonly busy: boolean;
  readonly onDecision: DepartmentRunDetailProps["onDecision"];
  readonly onRetryApproval?: DepartmentRunDetailProps["onRetryApproval"];
  readonly onRetry: DepartmentRunDetailProps["onRetry"];
  readonly onContinue: DepartmentRunDetailProps["onContinue"];
  readonly onControl: DepartmentRunDetailProps["onControl"];
  readonly onRecover: DepartmentRunDetailProps["onRecover"];
  readonly onFork?: DepartmentRunDetailProps["onFork"];
  readonly onSend: (content: string) => void;
  readonly onPermissionDecision?: (
    permissionId: string,
    decision: "approved" | "denied",
  ) => void;
  readonly onPermissionRequest?: (scope: string) => void;
  readonly run: DepartmentRunView;
  readonly t: Messages;
}) {
  const current = currentRunNode(run);
  const progress = runProgress(run);
  const aiMember = current.position?.aiMember;
  const [message, setMessage] = useState("");
  const [permissionScope, setPermissionScope] = useState("");
  const send = () => {
    if (!message.trim()) return;
    onSend(message.trim());
    setMessage("");
  };
  const statusIcon: IconName =
    run.run.status === "failed"
      ? "cancel"
      : run.run.status === "completed"
        ? "complete"
        : "run";
  return (
    <section
      className="run-collaboration-workspace"
      data-run-collaboration-workspace
      data-run-context-run={run.run.id}
      data-run-context-snapshot={run.snapshot.id}
      data-run-context-node={current.nodeRun?.id ?? "none"}
    >
      <aside
        className="run-collaboration-sessions"
        data-run-collaboration-sessions
      >
        <div className="run-collaboration-heading">
          <div>
            <span className="eyebrow">{t.interactionSessions}</span>
            <h2>{t.interactionRunCollaboration}</h2>
          </div>
          <Icon name="run" size={24} />
        </div>
        <div className="run-collaboration-session-card selected">
          <Icon name="run" size={24} />
          <div>
            <strong>{t.interactionRunCollaboration}</strong>
            <span>{run.snapshot.payload.department.name}</span>
            <small>
              Run {run.run.id.slice(0, 8)} · {statusName(t, run.run.status)}
            </small>
          </div>
        </div>
        {consultation ? (
          <div
            className="run-collaboration-session-card is-history"
            data-consultation-history
          >
            <Icon name="member" size={24} />
            <div>
              <strong>{t.interactionConsultation}</strong>
              <span>
                {consultation.messages.length} {t.messages.toLowerCase()}
              </span>
              <small>{t.sessionClosed}</small>
            </div>
          </div>
        ) : null}
        <div className="run-collaboration-member-card">
          <Icon
            name={
              current.position
                ? roleIconForPosition(current.position.name)
                : "member"
            }
            size={24}
          />
          <div>
            <span className="eyebrow">{t.currentAiMember}</span>
            <strong>{aiMember?.displayName ?? t.none}</strong>
            <small>
              {current.position ? positionName(t, current.position) : t.none}
            </small>
          </div>
        </div>
        <div className="run-collaboration-connection">
          <span className="status-dot status-dot-success" aria-hidden="true" />
          <div>
            <strong>{t.runtimeConnected}</strong>
            <small>
              {t.runSnapshot} · r{run.snapshot.revision}
            </small>
          </div>
        </div>
      </aside>
      <main
        className="run-collaboration-conversation"
        data-run-collaboration-conversation
      >
        <header className="run-collaboration-conversation-header">
          <div>
            <span className="eyebrow">{t.interactionRunCollaboration}</span>
            <h2>{current.node ? pipelineNodeName(t, current.node) : t.none}</h2>
            <p>
              {aiMember?.displayName ?? t.none} ·{" "}
              {current.position ? positionName(t, current.position) : t.none}
            </p>
          </div>
          <span className={`status-badge status-${run.run.status}`}>
            <Icon name={statusIcon} size={16} />
            {statusName(t, run.run.status)}
          </span>
        </header>
        <div className="consultation-boundary" data-consultation-readonly>
          <div className="consultation-boundary-label">
            <Icon name="member" size={20} />
            <strong>{t.interactionConsultation}</strong>
            <span>{t.sessionClosed}</span>
          </div>
          <p>
            {consultation?.messages.at(-1)?.content ??
              t.interactionMessagePlaceholder}
          </p>
        </div>
        <div className="run-event-stream" aria-label={t.interactionContext}>
          {collaboration.messages.map((item) => (
            <article
              className={`run-event-card run-event-${item.kind}`}
              data-session-message={item.id}
              key={item.id}
            >
              <Icon
                name={
                  item.kind === "status"
                    ? "run"
                    : item.kind === "tool"
                      ? "artifact"
                      : "member"
                }
                size={20}
              />
              <div>
                <strong>
                  {item.kind === "status"
                    ? interactionStatusLabel(t, item.content)
                    : item.kind === "tool"
                      ? `Tool Call · ${item.content}`
                      : item.content}
                </strong>
                <span>{formatAgentTimestamp(item.createdAt)}</span>
              </div>
            </article>
          ))}
          {run.nodes
            .filter((node) => node.status !== "queued")
            .slice(-5)
            .map((node) => {
              const nodeDefinition =
                run.snapshot.payload.pipelineVersion.graph.nodes.find(
                  (candidate) => candidate.id === node.pipelineNodeId,
                );
              return (
                <article
                  className={`run-event-card run-event-${node.status}`}
                  data-run-node-event={node.id}
                  key={`node-${node.id}`}
                >
                  <Icon
                    name={
                      nodeDefinition
                        ? pipelineIconForType(nodeDefinition.type)
                        : "run"
                    }
                    size={20}
                  />
                  <div>
                    <strong>
                      {nodeDefinition
                        ? pipelineNodeName(t, nodeDefinition)
                        : node.pipelineNodeId}
                    </strong>
                    <span>
                      {statusName(t, node.status)} · {t.nodeAttempts}:{" "}
                      {node.attemptCount}
                    </span>
                  </div>
                </article>
              );
            })}
          {collaboration.messages.length === 0 &&
          run.nodes.every((node) => node.status === "queued") ? (
            <div className="empty-state">{t.interactionNoMessages}</div>
          ) : null}
          {collaboration.permissions.length > 0 ? (
            <section
              className="run-permission-queue"
              aria-label={t.permissions}
            >
              <div className="run-permission-heading">
                <Icon name="approval" size={20} />
                <strong>{t.permissions}</strong>
              </div>
              {collaboration.permissions.map((permission) => (
                <article
                  className="run-permission-card"
                  data-permission-request={permission.id}
                  key={permission.id}
                >
                  <div className="run-permission-status">
                    <span
                      className={`run-permission-status-icon status-${permission.status}`}
                      data-permission-status-icon={permission.status}
                    >
                      <Icon
                        name={
                          permission.status === "approved"
                            ? "approval"
                            : permission.status === "denied"
                              ? "cancel"
                              : "run"
                        }
                        size={20}
                      />
                    </span>
                    <div>
                      <strong>{permission.scope}</strong>
                      <span>{permission.status}</span>
                    </div>
                  </div>
                  {permission.status === "pending" && onPermissionDecision ? (
                    <div className="action-bar">
                      <button
                        onClick={() =>
                          onPermissionDecision(permission.id, "approved")
                        }
                        type="button"
                      >
                        {t.approve}
                      </button>
                      <button
                        onClick={() =>
                          onPermissionDecision(permission.id, "denied")
                        }
                        type="button"
                      >
                        {t.reject}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>
          ) : null}
        </div>
        <div className="run-collaboration-composer">
          <textarea
            aria-label={t.nodeFeedback}
            placeholder={t.interactionMessagePlaceholder}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button
            className="primary-button"
            disabled={!message.trim() || busy}
            onClick={send}
            type="button"
          >
            <Icon name="send" size={20} />
            {t.sendMessage}
          </button>
        </div>
      </main>
      <aside
        className="run-collaboration-evidence"
        data-run-collaboration-evidence
      >
        <div className="run-evidence-heading">
          <div>
            <span className="eyebrow">{t.runSnapshot}</span>
            <h2>{t.interactionContext}</h2>
          </div>
          <Icon name="snapshot" size={24} />
        </div>
        <section className="run-evidence-card run-evidence-progress">
          <span className="eyebrow">{t.runProgress}</span>
          <strong>
            {current.node ? pipelineNodeName(t, current.node) : t.none}
          </strong>
          <span>
            {progress.completed} / {progress.total} · {progress.percentage}%
          </span>
          <progress
            aria-label={t.runProgress}
            max={Math.max(progress.total, 1)}
            value={progress.completed}
          />
        </section>
        <section className="run-evidence-card run-evidence-context">
          <span className="eyebrow">{t.currentNode}</span>
          <strong>
            {current.node ? pipelineNodeName(t, current.node) : t.none}
          </strong>
          <small className="run-context-identity" title={current.nodeRun?.id}>
            {current.nodeRun?.id.slice(0, 12) ?? t.none}
          </small>
          <dl>
            <div>
              <dt>{t.departmentRuns}</dt>
              <dd title={run.run.id}>{run.run.id.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>{t.runSnapshot}</dt>
              <dd>
                r{run.snapshot.revision} · {run.snapshot.hash.slice(0, 12)}
              </dd>
            </div>
            <div>
              <dt>{t.status}</dt>
              <dd>{statusName(t, run.run.status)}</dd>
            </div>
          </dl>
        </section>
        <section className="run-evidence-card run-evidence-artifacts">
          <span className="eyebrow">{t.artifacts}</span>
          {artifacts
            .filter((artifact) => artifact.producer.runId === run.run.id)
            .map((artifact) => (
              <div
                className="run-artifact-row"
                data-run-artifact={artifact.id}
                key={artifact.id}
              >
                <Icon name="artifact" size={20} />
                <span>
                  <strong>{artifact.logicalName}</strong>
                  <small>
                    v{artifact.version} · {artifact.status}
                  </small>
                </span>
              </div>
            ))}
          {artifacts.every(
            (artifact) => artifact.producer.runId !== run.run.id,
          ) ? (
            <span>{t.none}</span>
          ) : null}
        </section>
        {onPermissionRequest ? (
          <section className="run-evidence-card run-evidence-permissions">
            <span className="eyebrow">{t.permissions}</span>
            <input
              aria-label={t.requestPermission}
              placeholder={t.requestPermission}
              value={permissionScope}
              onChange={(event) => setPermissionScope(event.target.value)}
            />
            <button
              disabled={!permissionScope.trim()}
              onClick={() => {
                onPermissionRequest(permissionScope.trim());
                setPermissionScope("");
              }}
              type="button"
            >
              {t.requestPermission}
            </button>
          </section>
        ) : null}
        <DepartmentRunDetail
          busy={busy}
          onDecision={onDecision}
          onRetryApproval={onRetryApproval}
          onRetry={onRetry}
          onContinue={onContinue}
          onControl={onControl}
          onRecover={onRecover}
          onFork={onFork}
          run={run}
          t={t}
        />
      </aside>
    </section>
  );
}

export function ReviewTopicsPanel({
  topics,
}: {
  readonly topics: readonly ReviewTopicView[];
}) {
  return (
    <section className="review-topics" data-review-topics>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Quality governance</span>
          <h2>Review Topics</h2>
          <p>
            Independent findings, bounded discussion, exact revision evidence,
            and fresh quorum votes are recorded by the Company Runtime.
          </p>
        </div>
      </header>
      {topics.length === 0 ? (
        <div className="empty-state" data-review-topics-empty>
          No Review Topics have been scheduled for this Project.
        </div>
      ) : (
        <div className="catalog-grid">
          {topics.map((view) => (
            <article
              className="catalog-card review-topic-card"
              data-review-topic={view.topic.id}
              key={view.topic.id}
            >
              <div className="project-card-top">
                <div>
                  <span className="eyebrow">{view.topic.kind}</span>
                  <strong>{view.topic.title}</strong>
                </div>
                <span className="pill" data-review-status>
                  {view.topic.status}
                </span>
              </div>
              <dl className="catalog-meta">
                <div>
                  <dt>Exact manifest</dt>
                  <dd>
                    <code>{view.topic.manifestHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Reviewer quorum</dt>
                  <dd data-review-quorum>
                    {view.rechecks.length}/{view.topic.quorum}
                  </dd>
                </div>
                <div>
                  <dt>Discussion budget</dt>
                  <dd>
                    {view.topic.budgetUsed.rounds}/{view.topic.budget.maxRounds}{" "}
                    rounds · {view.topic.budgetUsed.tokens}/
                    {view.topic.budget.maxTokens} tokens
                  </dd>
                </div>
              </dl>
              <div className="review-participant-list">
                {view.participants.map((participant) => (
                  <span
                    className={`capability-pill${participant.eligibility.eligible ? "" : " is-muted"}`}
                    data-review-participant={participant.id}
                    key={participant.id}
                    title={participant.eligibility.reasons.join(", ")}
                  >
                    {participant.role}: {participant.aiMemberId}
                  </span>
                ))}
              </div>
              <section data-review-findings>
                <h3>Independent findings</h3>
                {view.findings.length === 0 ? (
                  <p>No findings submitted.</p>
                ) : (
                  <ul>
                    {view.findings.map((finding) => (
                      <li data-review-finding={finding.id} key={finding.id}>
                        <strong>
                          {finding.severity.toUpperCase()}: {finding.summary}
                        </strong>
                        <span>
                          {finding.reviewerParticipantId} ·{" "}
                          {finding.blocking ? "blocking" : "non-blocking"}
                          {finding.scopeImpact
                            ? ` · ${finding.scopeImpact}`
                            : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {view.gateResult ? (
                <section
                  className="review-gate-result"
                  data-quality-gate-result={view.gateResult.id}
                >
                  <h3>{view.gateResult.result}</h3>
                  <p>
                    {view.gateResult.satisfiesProductionContract
                      ? "Satisfies downstream production contracts."
                      : "Does not satisfy downstream production contracts."}
                  </p>
                  {view.gateResult.conditions.length > 0 ? (
                    <ul>
                      {view.gateResult.conditions.map((condition) => (
                        <li key={condition}>{condition}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function CodeReviewAuthorityPanel({
  reviews,
}: {
  readonly reviews: readonly CodeReviewView[];
}) {
  return (
    <section className="review-topics" data-code-review-authority>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Integration authority</span>
          <h2>Independent Code Review</h2>
          <p>
            Runtime-owned manifests bind each review to one exact Work Package
            Version, imported source commit, canonical diff, and self-check.
          </p>
        </div>
      </header>
      {reviews.length === 0 ? (
        <div className="empty-state" data-code-review-empty>
          No independent Code Review has been scheduled for this Run.
        </div>
      ) : (
        <div className="catalog-grid">
          {reviews.map((review) => (
            <article className="catalog-card" key={review.id}>
              <div className="project-card-top">
                <div>
                  <span className="eyebrow">
                    {review.manifest.workPackageVersionId}
                  </span>
                  <strong>{review.manifest.sourceCommit}</strong>
                </div>
                <span className="pill" data-code-review-status>
                  {review.integrationEligible
                    ? "Integration eligible"
                    : review.gateResult
                      ? review.gateResult.result
                      : review.workspace.state === "blocked"
                        ? "Review blocked"
                        : "Awaiting independent PASS"}
                </span>
              </div>
              <dl className="catalog-meta">
                <div>
                  <dt>Canonical diff</dt>
                  <dd>
                    <code>{review.manifest.diffHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Reviewer Session</dt>
                  <dd>{review.workspace.reviewerSessionId}</dd>
                </div>
                <div>
                  <dt>Reviewer Workspace</dt>
                  <dd>{review.workspace.state}</dd>
                </div>
              </dl>
              {review.authority ? (
                <p data-code-review-pass-authority>
                  Immutable PASS authority {review.authority.id} · Gate{" "}
                  {review.authority.qualityGateResultId}
                </p>
              ) : null}
              {review.defects.length > 0 ? (
                <p data-code-review-defects>
                  {review.defects.filter((defect) => defect.status !== "closed")
                    .length || "No"}{" "}
                  open defect(s)
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function ProductReviewStatePanel({
  state,
}: {
  readonly state: ProductReviewStateView;
}) {
  return (
    <section data-product-review-state>
      <h4>Product Review &amp; readiness</h4>
      <p data-project-spec-lineage>
        {state.specRevisions.length
          ? `${state.specRevisions.length} immutable Project Spec revision(s) · current ${state.specRevisions.at(-1)!.hash}`
          : "No Project Spec revision yet"}
      </p>
      <p data-product-review-manifest>
        {state.reviewTopics.length
          ? state.reviewTopics
              .map(
                (topic) =>
                  `${topic.topic.id}: ${topic.topic.status} · ${topic.topic.manifestHash}`,
              )
              .join(" | ")
          : "Product Review has not started"}
      </p>
      <p data-readiness-blockers>
        {state.readinessBlockers.length
          ? `Blocked by ${state.readinessBlockers.join(", ")}`
          : `${state.readinessEvidence.length} readiness evidence record(s), no blocker`}
      </p>
      <p data-product-gate-promotion>
        {state.promotion
          ? `PASS promoted Snapshot ${state.promotion.snapshotRevisionId} from ${state.promotion.sourceSnapshotRevisionId}`
          : "No PASS Product Gate promotion"}
      </p>
    </section>
  );
}

export function TechnicalReviewStatePanel({
  state,
}: {
  readonly state: TechnicalReviewStateView;
}) {
  const currentProposal = state.technicalBaselineProposals.at(-1);
  const incompatibleContracts = state.applicationContracts.filter(
    (contract) => contract.compatibility === "incompatible",
  );
  return (
    <section data-technical-review-state>
      <h4>Technical Design &amp; Specs</h4>
      <p data-application-spec-lineage>
        {state.applicationSpecRevisions.length
          ? `${state.applicationSpecRevisions.length} immutable Application Spec revision(s) across ${state.applications.length} Application(s)`
          : "No Application Spec revision yet"}
      </p>
      <p data-technical-proposal-manifest>
        {currentProposal
          ? `Proposal r${currentProposal.revision} · ${currentProposal.hash} · ${currentProposal.applicationSpecRevisions.length} exact Application Spec ref(s)`
          : "No Technical Baseline Proposal revision yet"}
      </p>
      <p data-technical-contracts>
        {incompatibleContracts.length
          ? `Blocked by incompatible contract evidence: ${incompatibleContracts
              .flatMap((contract) => contract.evidenceRefs)
              .join(", ")}`
          : `${state.applicationContracts.length} compatible Cross-Application Contract revision(s)`}
      </p>
      <p data-technical-gate-promotion>
        {state.promotion && state.acceptedBaseline
          ? `PASS accepted Technical Baseline ${state.acceptedBaseline.id} · ${state.acceptedBaseline.hash} · Snapshot ${state.promotion.snapshotRevisionId}`
          : "No PASS Technical Gate promotion"}
      </p>
    </section>
  );
}

type ProjectDetailTab =
  | "overview"
  | "consultation"
  | "runs"
  | "artifacts"
  | "reviews"
  | "improvements"
  | "memory"
  | "settings";

const projectStatisticsQuery = (
  project: Pick<ProjectEditorView, "id" | "createdAt">,
): StatisticsInspectInput => {
  const start = Date.parse(project.createdAt);
  const now = Date.now();
  const end = Number.isFinite(start)
    ? Math.max(now, start + 24 * 60 * 60 * 1_000)
    : now;
  return {
    projectId: project.id,
    window: {
      kind: "explicit-utc-half-open",
      startInclusive: project.createdAt,
      endExclusive: new Date(end).toISOString(),
    },
    cohort: { id: "cohort:baseline-quality" },
    comparisonSet: {
      id: "comparison:baseline-quality",
      metricIds: [
        "code-review-defect-incidence",
        "complete-model-attribution",
        "delivery-candidate-acceptance-rate",
        "product-baseline-confirmation-count",
        "product-baseline-confirmation-latency",
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
};

export const inspectProjectRunWorkPackages = async (
  runtime: {
    readonly query: (query: {
      readonly type: "work-packages.inspect";
      readonly runId: string;
    }) => Promise<{ readonly view: WorkPackageGraphView }>;
  },
  runId: string,
): Promise<WorkPackageGraphView | null> => {
  try {
    return (await runtime.query({ type: "work-packages.inspect", runId })).view;
  } catch {
    return null;
  }
};

export const inspectProjectRunCodeReviews = async (
  runtime: {
    readonly query: (query: {
      readonly type: "code-reviews.inspect";
      readonly runId: string;
    }) => Promise<{ readonly view: readonly CodeReviewView[] }>;
  },
  runId: string,
): Promise<readonly CodeReviewView[]> => {
  try {
    return (await runtime.query({ type: "code-reviews.inspect", runId })).view;
  } catch {
    return [];
  }
};

export function ProjectDetailWorkPackages({
  active,
  graph,
}: {
  readonly active: boolean;
  readonly graph: WorkPackageGraphView | null;
}) {
  return active && graph ? <WorkPackageGraphPanel graph={graph} /> : null;
}

export function IntegrationGenerationPanel({
  generations,
  diagnostic = null,
  onResync,
}: {
  readonly generations: readonly IntegrationGenerationView[];
  readonly diagnostic?: string | null;
  readonly onResync?: () => void;
}) {
  return (
    <section className="create-panel" data-integration-generations>
      <h2>Integration Generations</h2>
      {diagnostic ? (
        <div className="warn" data-integration-diagnostic>
          {diagnostic}
          {onResync ? (
            <button onClick={onResync} type="button">
              Resync
            </button>
          ) : null}
        </div>
      ) : null}
      {generations.length === 0 ? (
        <div className="empty-state">No Integration Generation yet.</div>
      ) : (
        generations.map((generation) => (
          <article
            data-integration-generation={generation.id}
            key={generation.id}
          >
            <header>
              <strong>
                Generation {generation.manifest.generation} · {generation.state}
              </strong>
              <small>{generation.manifestHash}</small>
            </header>
            <p>
              Coverage {generation.manifest.coverageId} · Snapshot{" "}
              {generation.manifest.snapshotRevisionId}
            </p>
            <ul>
              {generation.repositoryResults.map((repository) => (
                <li
                  data-integration-repository={repository.repositoryReference}
                  key={repository.id}
                >
                  {repository.repositoryReference} · {repository.state} ·{" "}
                  {repository.integratedCommit ?? repository.expectedTip}
                  <ul>
                    {repository.validationRecords.map((validation) => (
                      <li key={validation.validationId}>
                        {validation.kind} · {validation.status}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p data-integration-operations>
              Operations:{" "}
              {generation.operations.map((entry) => entry.state).join(", ") ||
                "none"}
            </p>
            <p data-integration-defects>
              Open defects:{" "}
              {
                generation.defects.filter((entry) => entry.status === "open")
                  .length
              }
            </p>
            <p data-integration-aggregate-review>
              Aggregate review:{" "}
              {generation.aggregateReview?.result ?? "pending"}
            </p>
          </article>
        ))
      )}
    </section>
  );
}

const candidateRiskTier = (view: CandidateQualityGateView): string => {
  const manifest = view.candidateInput.manifest;
  if (typeof manifest !== "object" || manifest === null) return "unknown";
  const risk = (manifest as { readonly risk?: unknown }).risk;
  return typeof risk === "object" &&
    risk !== null &&
    typeof (risk as { readonly tier?: unknown }).tier === "string"
    ? String((risk as { readonly tier: string }).tier)
    : "unknown";
};

const criticalRiskEvidenceRefs = (
  view: CandidateQualityGateView,
): readonly string[] => {
  const manifest = view.candidateInput.manifest;
  if (typeof manifest !== "object" || manifest === null) {
    return [`delivery-candidate-input:${view.candidateInput.id}`];
  }
  const risk = (manifest as { readonly risk?: unknown }).risk;
  if (typeof risk !== "object" || risk === null) {
    return [`delivery-candidate-input:${view.candidateInput.id}`];
  }
  const factors = (risk as { readonly factors?: unknown }).factors;
  const refs = Array.isArray(factors)
    ? factors.flatMap((factor) => {
        if (typeof factor !== "object" || factor === null) return [];
        const evidenceRefs = (factor as { readonly evidenceRefs?: unknown })
          .evidenceRefs;
        return Array.isArray(evidenceRefs)
          ? evidenceRefs.filter(
              (ref): ref is string =>
                typeof ref === "string" && ref.trim().length > 0,
            )
          : [];
      })
    : [];
  return refs.length > 0
    ? [...new Set(refs)].sort()
    : [`delivery-candidate-input:${view.candidateInput.id}`];
};

export function CandidateQualityGatePanel({
  busy,
  diagnostic,
  onCriticalEscalation,
  view,
}: {
  readonly busy: boolean;
  readonly diagnostic: string | null;
  readonly onCriticalEscalation: (input: {
    readonly decision: "authorize-gate-continuation" | "reject";
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
  }) => void;
  readonly view: CandidateQualityGateView | null;
}) {
  const [escalationReason, setEscalationReason] = useState(
    "Reviewed the immutable critical-risk evidence in this local session.",
  );
  if (!view) {
    return diagnostic ? (
      <section className="create-panel" data-candidate-quality-gates>
        <h2>Delivery Candidate Input and Quality Gates</h2>
        <p>{diagnostic}</p>
      </section>
    ) : null;
  }
  const riskTier = candidateRiskTier(view);
  const escalationEvidenceRefs = criticalRiskEvidenceRefs(view);
  return (
    <section
      className="create-panel"
      data-candidate-quality-gates
      data-candidate-input={view.candidateInput.id}
      data-candidate-authority={view.authority?.id ?? "blocked"}
      data-candidate-sync={diagnostic ?? "ready"}
    >
      <span className="eyebrow">Frozen delivery authority</span>
      <h2>Delivery Candidate Input and Quality Gates</h2>
      <dl>
        <div>
          <dt>Candidate Input</dt>
          <dd>{view.candidateInput.id}</dd>
        </div>
        <div>
          <dt>Manifest hash</dt>
          <dd>{view.candidateInput.manifestHash}</dd>
        </div>
        <div>
          <dt>Risk tier</dt>
          <dd>{riskTier}</dd>
        </div>
        <div>
          <dt>Critical-risk escalation</dt>
          <dd>
            {view.criticalEscalation
              ? `${view.criticalEscalation.id} · ${view.criticalEscalation.decision}`
              : riskTier === "critical"
                ? "awaiting verified human"
                : "not required"}
          </dd>
        </div>
        <div>
          <dt>Downstream authority</dt>
          <dd>{view.authority?.authorityHash ?? "blocked"}</dd>
        </div>
      </dl>
      {view.criticalEscalation ? (
        <p data-critical-risk-escalation={view.criticalEscalation.id}>
          {view.criticalEscalation.reason}
        </p>
      ) : riskTier === "critical" ? (
        <div className="form" data-critical-risk-escalation-controls>
          <label htmlFor={`critical-risk-reason-${view.candidateInput.id}`}>
            Escalation reason
          </label>
          <textarea
            id={`critical-risk-reason-${view.candidateInput.id}`}
            onChange={(event) => setEscalationReason(event.target.value)}
            value={escalationReason}
          />
          <small>
            {escalationEvidenceRefs.length} immutable risk evidence reference(s)
          </small>
          <div className="button-row">
            <button
              disabled={busy || escalationReason.trim().length === 0}
              id="authorize-critical-risk-continuation"
              onClick={() =>
                onCriticalEscalation({
                  decision: "authorize-gate-continuation",
                  reason: escalationReason,
                  evidenceRefs: escalationEvidenceRefs,
                })
              }
              type="button"
            >
              Authorize Gate continuation
            </button>
            <button
              disabled={busy || escalationReason.trim().length === 0}
              id="reject-critical-risk-continuation"
              onClick={() =>
                onCriticalEscalation({
                  decision: "reject",
                  reason: escalationReason,
                  evidenceRefs: escalationEvidenceRefs,
                })
              }
              type="button"
            >
              Reject continuation
            </button>
          </div>
        </div>
      ) : null}
      {diagnostic ? <p>{diagnostic}</p> : null}
      <div className="review-list">
        {view.gateResults.map((result) => (
          <article key={result.id} data-quality-gate-result={result.result}>
            <strong>{result.result}</strong>
            <span>{result.id}</span>
            <small>{result.resultHash}</small>
            <small>
              {result.defects.length} Defects · {result.obligations.length}{" "}
              obligations
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

const deliveryCandidateEvidenceRefs = (
  view: DeliveryCandidateView,
): readonly string[] => {
  if (typeof view.manifest !== "object" || view.manifest === null) {
    return [`delivery-candidate:${view.id}`];
  }
  const artifacts = (view.manifest as { readonly artifacts?: unknown })
    .artifacts;
  if (!Array.isArray(artifacts)) return [`delivery-candidate:${view.id}`];
  const refs = artifacts.flatMap((artifact) =>
    typeof artifact === "object" &&
    artifact !== null &&
    typeof (artifact as { readonly id?: unknown }).id === "string"
      ? [`artifact-version:${String((artifact as { readonly id: string }).id)}`]
      : [],
  );
  return refs.length > 0
    ? [...new Set(refs)].sort()
    : [`delivery-candidate:${view.id}`];
};

export function DeliveryCandidatePanel({
  busy,
  diagnostic,
  view,
  onDecision,
  onRecovery,
}: {
  readonly busy: boolean;
  readonly diagnostic: string | null;
  readonly view: DeliveryCandidateView | null;
  readonly onDecision: (input: {
    readonly decision: "accepted" | "rejected" | "changes-requested";
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
    readonly reworkScope?: "same-boundary" | "boundary-changing";
    readonly childRunId?: string;
    readonly responsibilityKind?:
      | "defect"
      | "work-package"
      | "contract"
      | "test"
      | "gate";
    readonly responsibilityId?: string;
  }) => void;
  readonly onRecovery?: (input: {
    readonly decisionId: string;
    readonly authorityKind:
      | "work-package-version"
      | "test-rework-run"
      | "candidate-input-recheck";
    readonly authorityId: string;
  }) => void;
}) {
  const [reason, setReason] = useState(
    "Reviewed the immutable Delivery Candidate evidence in this local session.",
  );
  const [reworkScope, setReworkScope] = useState<
    "same-boundary" | "boundary-changing"
  >("same-boundary");
  const [childRunId, setChildRunId] = useState("");
  const [responsibilityKind, setResponsibilityKind] = useState<
    "defect" | "work-package" | "contract" | "test" | "gate"
  >("work-package");
  const [responsibilityId, setResponsibilityId] = useState("");
  const [authorityKind, setAuthorityKind] = useState<
    "work-package-version" | "test-rework-run" | "candidate-input-recheck"
  >("work-package-version");
  const [authorityId, setAuthorityId] = useState("");
  if (!view) {
    return diagnostic ? (
      <section className="create-panel" data-delivery-candidate>
        <h2>Delivery Candidate and Human release</h2>
        <p>{diagnostic}</p>
      </section>
    ) : null;
  }
  const evidenceRefs = deliveryCandidateEvidenceRefs(view);
  const awaiting = view.projection === "awaiting-decision";
  const decide = (decision: "accepted" | "rejected" | "changes-requested") =>
    onDecision({
      decision,
      reason,
      evidenceRefs,
      ...(decision === "changes-requested" ? { reworkScope } : {}),
      ...(decision === "changes-requested"
        ? {
            responsibilityKind,
            responsibilityId: responsibilityId.trim(),
          }
        : {}),
      ...(decision === "changes-requested" &&
      reworkScope === "boundary-changing"
        ? { childRunId: childRunId.trim() }
        : {}),
    });
  return (
    <section
      className="create-panel"
      data-delivery-candidate
      data-delivery-candidate-id={view.id}
      data-delivery-candidate-manifest-hash={view.manifestHash}
      data-delivery-candidate-projection={view.projection}
      data-delivery-candidate-sync={diagnostic ?? "ready"}
    >
      <span className="eyebrow">Immutable delivery review</span>
      <h2>Delivery Candidate and Human release</h2>
      <dl>
        <div>
          <dt>Candidate</dt>
          <dd>{view.id}</dd>
        </div>
        <div>
          <dt>Manifest hash</dt>
          <dd>{view.manifestHash}</dd>
        </div>
        <div>
          <dt>Decision</dt>
          <dd>{view.projection}</dd>
        </div>
      </dl>
      {view.decision ? (
        <p data-human-release-decision={view.decision.id}>
          {view.decision.reason}
        </p>
      ) : null}
      {view.recoveryActivation ? (
        <dl data-human-release-recovery-activation={view.recoveryActivation.id}>
          <div>
            <dt>Recovery authority</dt>
            <dd>
              {view.recoveryActivation.authority.kind}:{" "}
              {view.recoveryActivation.authority.id}
            </dd>
          </div>
          <div>
            <dt>Activation hash</dt>
            <dd>{view.recoveryActivation.activationHash}</dd>
          </div>
        </dl>
      ) : null}
      {diagnostic ? <p>{diagnostic}</p> : null}
      {awaiting ? (
        <div className="form" data-human-release-controls>
          <label htmlFor={`delivery-release-reason-${view.id}`}>
            Decision reason
          </label>
          <textarea
            id={`delivery-release-reason-${view.id}`}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
          <label htmlFor={`delivery-release-scope-${view.id}`}>
            Changes-requested scope
          </label>
          <select
            id={`delivery-release-scope-${view.id}`}
            onChange={(event) =>
              setReworkScope(
                event.target.value as "same-boundary" | "boundary-changing",
              )
            }
            value={reworkScope}
          >
            <option value="same-boundary">Same boundary</option>
            <option value="boundary-changing">Boundary changing</option>
          </select>
          <label htmlFor={`delivery-release-responsibility-kind-${view.id}`}>
            Exact responsibility kind
          </label>
          <select
            id={`delivery-release-responsibility-kind-${view.id}`}
            onChange={(event) =>
              setResponsibilityKind(
                event.target.value as typeof responsibilityKind,
              )
            }
            value={responsibilityKind}
          >
            <option value="work-package">Work Package</option>
            <option value="test">Test Run</option>
            <option value="defect">Defect</option>
            <option value="contract">Contract</option>
            <option value="gate">Quality Gate</option>
          </select>
          <label htmlFor={`delivery-release-responsibility-id-${view.id}`}>
            Exact responsibility ID
          </label>
          <input
            id={`delivery-release-responsibility-id-${view.id}`}
            onInput={(event) => setResponsibilityId(event.currentTarget.value)}
            value={responsibilityId}
          />
          {reworkScope === "boundary-changing" ? (
            <>
              <label htmlFor={`delivery-release-child-run-${view.id}`}>
                Confirmed child Run ID
              </label>
              <input
                id={`delivery-release-child-run-${view.id}`}
                onInput={(event) => setChildRunId(event.currentTarget.value)}
                value={childRunId}
              />
            </>
          ) : null}
          <small>{evidenceRefs.length} immutable evidence reference(s)</small>
          <div className="button-row">
            <button
              disabled={busy || reason.trim().length === 0}
              id="accept-delivery-candidate"
              onClick={() => decide("accepted")}
              type="button"
            >
              Accept Candidate
            </button>
            <button
              disabled={busy || reason.trim().length === 0}
              id="reject-delivery-candidate"
              onClick={() => decide("rejected")}
              type="button"
            >
              Reject Candidate
            </button>
            <button
              disabled={
                busy ||
                reason.trim().length === 0 ||
                responsibilityId.trim().length === 0 ||
                (reworkScope === "boundary-changing" &&
                  childRunId.trim().length === 0)
              }
              id="request-delivery-changes"
              onClick={() => decide("changes-requested")}
              type="button"
            >
              Request changes
            </button>
          </div>
        </div>
      ) : null}
      {view.projection === "changes-requested" &&
      view.decision?.rework?.scope === "same-boundary" &&
      !view.recoveryActivation &&
      onRecovery ? (
        <div className="form" data-human-release-recovery-controls>
          <label htmlFor={`delivery-release-authority-kind-${view.id}`}>
            Formal rework authority kind
          </label>
          <select
            id={`delivery-release-authority-kind-${view.id}`}
            onChange={(event) =>
              setAuthorityKind(event.target.value as typeof authorityKind)
            }
            value={authorityKind}
          >
            <option value="work-package-version">Work Package Version</option>
            <option value="test-rework-run">Test rework Run</option>
            <option value="candidate-input-recheck">
              Candidate Input full recheck
            </option>
          </select>
          <label htmlFor={`delivery-release-authority-id-${view.id}`}>
            Fresh authority ID
          </label>
          <input
            id={`delivery-release-authority-id-${view.id}`}
            onInput={(event) => setAuthorityId(event.currentTarget.value)}
            value={authorityId}
          />
          <button
            disabled={busy || authorityId.trim().length === 0}
            id="activate-delivery-rework"
            onClick={() =>
              onRecovery({
                decisionId: view.decision!.id,
                authorityKind,
                authorityId: authorityId.trim(),
              })
            }
            type="button"
          >
            Validate authority and recover
          </button>
        </div>
      ) : null}
    </section>
  );
}

export const deliveryCandidateInputIdFromRun = (
  run: DepartmentRunView | null,
): string | null => {
  const result = run?.nodes.find(
    (node) =>
      node.handler?.handlerKindId === "delivery-candidate-input@1" &&
      node.status === "succeeded",
  )?.result;
  if (typeof result !== "object" || result === null) return null;
  const id = (result as { readonly deliveryCandidateInputId?: unknown })
    .deliveryCandidateInputId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
};

export const deliveryCandidateIdFromRun = (
  run: DepartmentRunView | null,
): string | null => {
  const result = run?.nodes.find(
    (node) =>
      node.handler?.handlerKindId === "delivery-candidate@1" &&
      node.status === "succeeded",
  )?.result;
  if (typeof result !== "object" || result === null) return null;
  const id = (result as { readonly deliveryCandidateId?: unknown })
    .deliveryCandidateId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
};

export function ProjectDetailView({
  project,
  t,
  onBack,
  onSave,
  onArchive,
  initialTab = "overview",
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
  readonly initialTab?: ProjectDetailTab;
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
  const [runArtifacts, setRunArtifacts] = useState<
    readonly ArtifactVersionView[]
  >([]);
  const [reviewTopics, setReviewTopics] = useState<readonly ReviewTopicView[]>(
    [],
  );
  const [selectedRun, setSelectedRun] = useState<DepartmentRunView | null>(
    null,
  );
  const [runSupervisionState, setRunSupervisionState] = useState<{
    readonly generation: number;
    readonly view: RunSupervisionView | null;
  }>({ generation: 0, view: null });
  const runSupervision = runSupervisionState.view;
  const [runSupervisionDiagnostic, setRunSupervisionDiagnostic] = useState<
    string | null
  >(null);
  const [integrationGenerationState, setIntegrationGenerationState] = useState<{
    readonly generation: number;
    readonly view: readonly IntegrationGenerationView[];
  }>({ generation: 0, view: [] });
  const [integrationDiagnostic, setIntegrationDiagnostic] = useState<
    string | null
  >(null);
  const [candidateQualityGateView, setCandidateQualityGateView] =
    useState<CandidateQualityGateView | null>(null);
  const [candidateQualityDiagnostic, setCandidateQualityDiagnostic] = useState<
    string | null
  >(null);
  const [deliveryCandidateView, setDeliveryCandidateView] =
    useState<DeliveryCandidateView | null>(null);
  const [deliveryCandidateDiagnostic, setDeliveryCandidateDiagnostic] =
    useState<string | null>(null);
  const [acceptedDeliveryAuthority, setAcceptedDeliveryAuthority] =
    useState<AcceptedDeliveryCandidateAuthorityView | null>(null);
  const [releaseOperations, setReleaseOperations] = useState<
    readonly ReleaseOperationView[]
  >([]);
  const runtimeViewConnectionCoordinator = useRef(
    createRuntimeViewConnectionCoordinator<ProjectRuntimeViewConnection>(),
  ).current;
  const [runDepartmentId, setRunDepartmentId] = useState("");
  const [runAgents, setRunAgents] = useState<AgentCatalogView["agents"]>([]);
  const [agentOverrideId, setAgentOverrideId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runErrorCode, setRunErrorCode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectDetailTab>(initialTab);
  const [statisticsQueryDraft, setStatisticsQueryDraft] =
    useState<StatisticsInspectInput>(() => projectStatisticsQuery(project));
  const [statisticsQuery, setStatisticsQuery] =
    useState<StatisticsInspectInput>(() => projectStatisticsQuery(project));
  const [statisticsView, setStatisticsView] = useState<StatisticsView | null>(
    null,
  );
  const [statisticsEvidence, setStatisticsEvidence] =
    useState<StatisticsEvidenceSnapshotView | null>(null);
  const [improvementProposals, setImprovementProposals] = useState<
    readonly ImprovementProposalView[]
  >([]);
  const [statisticsEvidenceIdInput, setStatisticsEvidenceIdInput] =
    useState("");
  const [statisticsEvidenceSnapshotId, setStatisticsEvidenceSnapshotId] =
    useState<string | null>(null);
  const [statisticsBusy, setStatisticsBusy] = useState(false);
  const [statisticsDiagnostic, setStatisticsDiagnostic] = useState<
    string | null
  >(null);
  const statisticsFreezeGesture = useRef<{
    readonly queryKey: string;
    readonly commandId: string;
    readonly evidenceSnapshotId: string;
  } | null>(null);
  const improvementProposalGestures = useRef(
    new Map<
      string,
      {
        readonly commandId: string;
        readonly proposalId?: string;
        readonly revisionId?: string;
      }
    >(),
  );
  const [consultation, setConsultation] = useState<InteractionView | null>(
    null,
  );
  const [collaboration, setCollaboration] = useState<InteractionView | null>(
    null,
  );
  const candidateInputId = deliveryCandidateInputIdFromRun(selectedRun);
  const deliveryCandidateId = deliveryCandidateIdFromRun(selectedRun);
  const [consultationMessage, setConsultationMessage] = useState("");
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [productDiscovery, setProductDiscovery] =
    useState<ProductDiscoveryView | null>(null);
  const [productReview, setProductReview] =
    useState<ProductReviewStateView | null>(null);
  const [technicalReview, setTechnicalReview] =
    useState<TechnicalReviewStateView | null>(null);
  const [workPackageGraph, setWorkPackageGraph] =
    useState<WorkPackageGraphView | null>(null);
  const [codeReviews, setCodeReviews] = useState<readonly CodeReviewView[]>([]);
  const [proposalDraft, setProposalDraft] = useState<ProductProposalContent>({
    goal: project.goal,
    users: [],
    scope: [],
    nonGoals: [],
    acceptanceCriteria: [],
    constraints: project.sharedContext ? [project.sharedContext] : [],
    risks: [],
    openQuestions: [],
  });

  useEffect(() => {
    setName(project.name);
    setGoal(project.goal);
    setSharedContext(project.sharedContext);
    setRepositoryReferences([...project.repositoryReferences]);
    setRepositoryReference("");
    const nextStatisticsQuery = projectStatisticsQuery(project);
    setStatisticsQueryDraft(nextStatisticsQuery);
    setStatisticsQuery(nextStatisticsQuery);
    setStatisticsView(null);
    setStatisticsEvidence(null);
    setStatisticsEvidenceIdInput("");
    setStatisticsEvidenceSnapshotId(null);
    setStatisticsDiagnostic(null);
    statisticsFreezeGesture.current = null;
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

  const refreshProductDiscovery = async (): Promise<ProductDiscoveryView> => {
    const next = await inspectProjectProductDiscovery(
      window.sandcastle,
      project.id,
    );
    setProductDiscovery(next);
    if (next.proposal) setProposalDraft(next.proposal.currentRevision.content);
    const latestRun = next.formalRuns.at(-1);
    setProductReview(
      latestRun
        ? await window.sandcastle.runtime.inspectProductReview(latestRun.runId)
        : null,
    );
    setTechnicalReview(
      latestRun
        ? await window.sandcastle.runtime.inspectTechnicalReview(
            latestRun.runId,
          )
        : null,
    );
    return next;
  };

  useEffect(() => {
    if (!selectedRun) {
      setWorkPackageGraph(null);
      return;
    }
    let active = true;
    inspectProjectRunWorkPackages(window.sandcastle, selectedRun.run.id).then(
      (graph) => {
        if (active) setWorkPackageGraph(graph);
      },
    );
    return () => {
      active = false;
    };
  }, [selectedRun?.run.id]);

  useEffect(() => {
    if (!selectedRun) {
      setCodeReviews([]);
      return;
    }
    let active = true;
    inspectProjectRunCodeReviews(window.sandcastle, selectedRun.run.id).then(
      (reviews) => {
        if (active) setCodeReviews(reviews);
      },
    );
    return () => {
      active = false;
    };
  }, [selectedRun?.run.id]);

  useEffect(() => {
    let active = true;
    if (activeTab === "improvements") {
      const request = runtimeViewConnectionCoordinator.replace(
        async (isCurrent) => {
          const canApply = (): boolean => active && isCurrent();
          if (canApply()) {
            setStatisticsDiagnostic("Synchronizing Statistics…");
          }
          const connection = await connectStatisticsEventStream({
            bridge: window.sandcastle,
            projectId: project.id,
            query: statisticsQuery,
            evidenceSnapshotId: statisticsEvidenceSnapshotId,
            onViews: (views) => {
              if (!canApply()) return;
              setStatisticsView(views.statistics);
              setStatisticsEvidence(views.evidence);
              setImprovementProposals(views.proposals);
              setStatisticsDiagnostic(null);
            },
            onDiagnostic: (diagnostic) => {
              if (canApply()) setStatisticsDiagnostic(diagnostic);
            },
          });
          return {
            kind: "improvements" as const,
            connection,
            close: connection.close,
          };
        },
      );
      void request.done.catch((nextError: unknown) => {
        if (active) {
          setStatisticsDiagnostic(
            `Runtime unavailable; Statistics resync required: ${errorMessage(nextError)}`,
          );
        }
      });
      return () => {
        active = false;
        request.cancel();
      };
    }
    if (!selectedRun || (activeTab !== "runs" && activeTab !== "reviews")) {
      void runtimeViewConnectionCoordinator.clear();
      return () => {
        active = false;
      };
    }
    const request = runtimeViewConnectionCoordinator.replace(
      async (isCurrent) => {
        const canApply = (): boolean => active && isCurrent();
        if (activeTab === "runs") {
          setRunSupervisionState({ generation: 0, view: null });
          setRunSupervisionDiagnostic("Synchronizing Runtime supervision…");
          const connection = await connectRunSupervision({
            bridge: window.sandcastle,
            runId: selectedRun.run.id,
            onFrame: (frame) => {
              if (canApply()) {
                setRunSupervisionState((current) =>
                  applyRunSupervisionFrame(current, frame),
                );
              }
            },
            onDiagnostic: (diagnostic) => {
              if (canApply()) setRunSupervisionDiagnostic(diagnostic);
            },
          });
          return { kind: "runs", connection, close: connection.close };
        }
        setIntegrationGenerationState({ generation: 0, view: [] });
        setCandidateQualityGateView(null);
        setDeliveryCandidateView(null);
        setAcceptedDeliveryAuthority(null);
        setReleaseOperations([]);
        setIntegrationDiagnostic("Synchronizing Reviews…");
        setCandidateQualityDiagnostic(
          candidateInputId ? "Synchronizing Reviews…" : null,
        );
        setDeliveryCandidateDiagnostic(
          deliveryCandidateId ? "Synchronizing Reviews…" : null,
        );
        const applyReviewsViews = (views: {
          readonly integrationGenerations: readonly IntegrationGenerationView[];
          readonly candidateQuality: CandidateQualityGateView | null;
          readonly deliveryCandidate: DeliveryCandidateView | null;
          readonly acceptedDeliveryAuthority: AcceptedDeliveryCandidateAuthorityView | null;
          readonly releaseOperations: readonly ReleaseOperationView[];
          readonly generation?: number;
        }): void => {
          if (!canApply()) return;
          setIntegrationGenerationState({
            generation: views.generation ?? 0,
            view: views.integrationGenerations,
          });
          setCandidateQualityGateView(views.candidateQuality);
          setDeliveryCandidateView(views.deliveryCandidate);
          setAcceptedDeliveryAuthority(views.acceptedDeliveryAuthority);
          setReleaseOperations(views.releaseOperations);
          setIntegrationDiagnostic(null);
          setCandidateQualityDiagnostic(null);
          setDeliveryCandidateDiagnostic(null);
        };
        const connection = await connectReviewsEventStream({
          bridge: window.sandcastle,
          runId: selectedRun.run.id,
          candidateInputId,
          candidateId: deliveryCandidateId,
          onInitialViews: applyReviewsViews,
          onViews: applyReviewsViews,
          onDiagnostic: (diagnostic) => {
            if (canApply()) {
              setIntegrationDiagnostic(diagnostic);
              if (candidateInputId) setCandidateQualityDiagnostic(diagnostic);
              if (deliveryCandidateId)
                setDeliveryCandidateDiagnostic(diagnostic);
            }
          },
        });
        return { kind: "reviews", connection, close: connection.close };
      },
    );
    void request.done.catch((nextError: unknown) => {
      if (!active) return;
      const message = `Runtime unavailable; resync required: ${errorMessage(nextError)}`;
      if (activeTab === "reviews") {
        setIntegrationDiagnostic(message);
        if (candidateInputId) setCandidateQualityDiagnostic(message);
        if (deliveryCandidateId) setDeliveryCandidateDiagnostic(message);
      }
      if (activeTab === "runs") setRunSupervisionDiagnostic(message);
    });
    return () => {
      active = false;
      request.cancel();
    };
  }, [
    activeTab,
    selectedRun?.run.id,
    candidateInputId,
    deliveryCandidateId,
    project.id,
    statisticsQuery,
    statisticsEvidenceSnapshotId,
  ]);

  useEffect(() => {
    let active = true;
    inspectProjectProductDiscovery(window.sandcastle, project.id)
      .then((next) => {
        if (!active) return;
        setProductDiscovery(next);
        if (next.proposal)
          setProposalDraft(next.proposal.currentRevision.content);
        const latestRun = next.formalRuns.at(-1);
        if (latestRun) {
          void Promise.all([
            window.sandcastle.runtime.inspectProductReview(latestRun.runId),
            window.sandcastle.runtime.inspectTechnicalReview(latestRun.runId),
          ])
            .then(([productState, technicalState]) => {
              if (active) {
                setProductReview(productState);
                setTechnicalReview(technicalState);
              }
            })
            .catch((nextError: unknown) => {
              if (active) setRunError(errorMessage(nextError));
            });
        } else {
          setProductReview(null);
          setTechnicalReview(null);
        }
      })
      .catch((nextError: unknown) => {
        if (active) setRunError(errorMessage(nextError));
      });
    return () => {
      active = false;
    };
  }, [project.id]);

  useEffect(() => {
    let active = true;
    setRunError(null);
    Promise.all([
      window.sandcastle.runtime.departments(),
      window.sandcastle.runtime.runs(project.id),
      window.sandcastle.runtime.inspectAgentCatalog(),
      window.sandcastle.runtime.artifacts(project.id),
      window.sandcastle.runtime.reviewTopics({ projectId: project.id }),
    ])
      .then(([departments, nextRuns, agents, artifacts, topics]) => {
        if (!active) return;
        const runnable = departments.filter(
          (department) => department.publishedPipelineVersion !== null,
        );
        setRunDepartments(runnable);
        setRunDepartmentId((current) => current || runnable[0]?.id || "");
        setRuns(nextRuns);
        setSelectedRun(nextRuns[0] ?? null);
        setRunAgents(agents.agents);
        setRunArtifacts(artifacts);
        setReviewTopics(topics);
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

  useEffect(() => {
    let active = true;
    window.sandcastle.runtime
      .interactions(project.id)
      .then((items) => {
        if (!active) return;
        setConsultation(
          items.find((item) => item.session.mode === "consultation") ?? null,
        );
        const nextRunId = selectedRun?.run.id;
        setCollaboration(
          items.find(
            (item) =>
              item.session.mode === "run-collaboration" &&
              item.session.runId === nextRunId,
          ) ?? null,
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [project.id, selectedRun?.run.id]);

  useEffect(() => {
    if (!selectedRun || !activeRunStatuses.has(selectedRun.run.status)) {
      return;
    }
    let active = true;
    const poll = (): void => {
      void Promise.all([
        window.sandcastle.runtime.inspectRun(selectedRun.run.id),
        window.sandcastle.runtime.artifacts(project.id),
        window.sandcastle
          .query({
            type: "work-packages.inspect",
            runId: selectedRun.run.id,
          })
          .then((result) => result.view)
          .catch(() => null),
        inspectProjectRunCodeReviews(window.sandcastle, selectedRun.run.id),
      ])
        .then(([nextRun, artifacts, graph, reviews]) => {
          if (!active) return;
          setSelectedRun(nextRun);
          setRunArtifacts(artifacts);
          setWorkPackageGraph(graph);
          setCodeReviews(reviews);
          setRuns((current) =>
            current.map((run) =>
              run.run.id === nextRun.run.id ? nextRun : run,
            ),
          );
        })
        .catch((nextError: unknown) => {
          if (active) setRunError(errorMessage(nextError));
        });
    };
    const stopPolling = startRunProgressPolling(poll);
    return () => {
      active = false;
      stopPolling();
    };
  }, [project.id, selectedRun?.run.id, selectedRun?.run.status]);

  const currentRunNodeId = selectedRun
    ? (currentRunNode(selectedRun).nodeRun?.id ?? null)
    : null;
  useEffect(() => {
    if (
      !selectedRun ||
      !collaboration ||
      collaboration.session.runId !== selectedRun.run.id ||
      !currentRunNodeId ||
      collaboration.session.nodeRunId === currentRunNodeId
    ) {
      return;
    }
    let active = true;
    createRunCollaborationSession(
      window.sandcastle.runtime,
      project.id,
      selectedRun,
    )
      .then((nextCollaboration) => {
        if (active && nextCollaboration) setCollaboration(nextCollaboration);
      })
      .catch((nextError: unknown) => {
        if (active) setRunError(errorMessage(nextError));
      });
    return () => {
      active = false;
    };
  }, [
    collaboration?.session.nodeRunId,
    currentRunNodeId,
    project.id,
    selectedRun,
  ]);

  const startRun = async (): Promise<DepartmentRunView | null> => {
    if (!runDepartmentId) return null;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const advanced = await startProjectDepartmentRun(
        window.sandcastle.runtime,
        project.id,
        runDepartmentId,
        agentOverrideId || undefined,
      );
      setSelectedRun(advanced);
      await refreshRuns();
      return advanced;
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      void refreshRuns().catch(() => undefined);
    } finally {
      setRunBusy(false);
    }
    return null;
  };

  const startConsultation = async (): Promise<void> => {
    setInteractionBusy(true);
    setRunError(null);
    try {
      const existing = (
        await window.sandcastle.runtime.interactions(project.id)
      ).find((item) => item.session.mode === "consultation");
      if (existing) {
        setConsultation(existing);
        return;
      }
      const departmentId = runDepartmentId || runDepartments[0]?.id;
      if (!departmentId) throw new Error(t.interactionNoMembers);
      const department =
        await window.sandcastle.runtime.inspectDepartment(departmentId);
      const member = department.positions.find(
        (position) =>
          position.status === "active" && position.aiMember.status === "active",
      )?.aiMember;
      if (!member) throw new Error(t.interactionNoMembers);
      setConsultation(
        await createProjectConsultationSession(
          window.sandcastle.runtime,
          project.id,
          member.id,
        ),
      );
    } catch (nextError) {
      setRunError(errorMessage(nextError));
    } finally {
      setInteractionBusy(false);
    }
  };

  const sendConsultationMessage = async (): Promise<void> => {
    if (!consultation || !consultationMessage.trim()) return;
    setInteractionBusy(true);
    try {
      setConsultation(
        await promptInteractionSession(
          window.sandcastle.runtime,
          consultation,
          consultationMessage,
        ),
      );
      setConsultationMessage("");
    } catch (nextError) {
      setRunError(errorMessage(nextError));
    } finally {
      setInteractionBusy(false);
    }
  };

  const reviseProposal = async (): Promise<void> => {
    if (!consultation) return;
    setRunBusy(true);
    setRunError(null);
    try {
      setProductDiscovery(
        await reviseProjectProductProposal(window.sandcastle, {
          projectId: project.id,
          producerSessionId: consultation.session.id,
          content: proposalDraft,
        }),
      );
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const markProposalAwaiting = async (): Promise<void> => {
    setRunBusy(true);
    setRunError(null);
    try {
      setProductDiscovery(
        await markProjectProductProposalAwaiting(window.sandcastle, project.id),
      );
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const confirmConsultation = async (): Promise<void> => {
    if (!runDepartmentId) return;
    setRunBusy(true);
    setRunError(null);
    try {
      const confirmed = await confirmProjectProductBaseline(
        window.sandcastle,
        project.id,
        runDepartmentId,
        {
          ...(agentOverrideId ? { agentOverrideId } : {}),
          ...(productDiscovery?.formalRuns.at(-1)
            ? {
                forkSourceRunId: productDiscovery.formalRuns.at(-1)!.runId,
                forkSourceSnapshotRevisionId:
                  productDiscovery.formalRuns.at(-1)!.snapshotRevisionId,
              }
            : {}),
        },
      );
      setProductDiscovery(confirmed);
      const nextRuns = await refreshRuns();
      const formalRunId = confirmed.formalRuns.at(-1)?.runId;
      setSelectedRun(
        nextRuns.find((run) => run.run.id === formalRunId) ??
          nextRuns[0] ??
          null,
      );
      setActiveTab("runs");
      if (consultation?.session.status === "active") {
        await window.sandcastle.runtime.closeInteractionSession(
          consultation.session.id,
        );
        setConsultation(
          await window.sandcastle.runtime.inspectInteraction(
            consultation.session.id,
          ),
        );
      }
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const sendCollaborationMessage = async (content: string): Promise<void> => {
    if (!collaboration) return;
    setInteractionBusy(true);
    try {
      setCollaboration(
        await promptInteractionSession(
          window.sandcastle.runtime,
          collaboration,
          content,
        ),
      );
    } catch (nextError) {
      setRunError(errorMessage(nextError));
    } finally {
      setInteractionBusy(false);
    }
  };

  const requestCollaborationPermission = async (
    scope: string,
  ): Promise<void> => {
    if (!collaboration || !scope) return;
    try {
      await window.sandcastle.runtime.requestPermission({
        sessionId: collaboration.session.id,
        scope,
      });
      setCollaboration(
        await window.sandcastle.runtime.inspectInteraction(
          collaboration.session.id,
        ),
      );
    } catch (nextError) {
      setRunError(errorMessage(nextError));
    }
  };

  const decideCollaborationPermission = async (
    permissionId: string,
    decision: "approved" | "denied",
  ): Promise<void> => {
    if (!collaboration) return;
    try {
      await window.sandcastle.runtime.decidePermission({
        permissionId,
        expectedStatus: "pending",
        decision,
      });
      setCollaboration(
        await window.sandcastle.runtime.inspectInteraction(
          collaboration.session.id,
        ),
      );
    } catch (nextError) {
      setRunError(errorMessage(nextError));
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

  const retryApproval = async (nodeRunId: string): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const waiting = await window.sandcastle.runtime.retryApproval({
        runId: selectedRun.run.id,
        nodeRunId,
        expectedRevision: selectedRun.run.revision,
      });
      setSelectedRun(waiting);
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

  const decideHumanRelease = async (input: {
    readonly decision: "accepted" | "rejected" | "changes-requested";
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
    readonly reworkScope?: "same-boundary" | "boundary-changing";
    readonly childRunId?: string;
    readonly responsibilityKind?:
      | "defect"
      | "work-package"
      | "contract"
      | "test"
      | "gate";
    readonly responsibilityId?: string;
  }): Promise<void> => {
    if (!selectedRun || !deliveryCandidateView) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const decided = await window.sandcastle.runtime.executeDeliveryCommand({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "delivery.release.decide",
          decisionId: globalThis.crypto.randomUUID(),
          candidateId: deliveryCandidateView.id,
          expectedCandidateHash: deliveryCandidateView.manifestHash,
          decision: input.decision,
          reason: input.reason,
          evidenceRefs: [...input.evidenceRefs],
          ...(input.decision === "changes-requested"
            ? {
                rework: {
                  scope: input.reworkScope ?? "same-boundary",
                  ...(input.reworkScope === "boundary-changing" &&
                  input.childRunId
                    ? { childRunId: input.childRunId }
                    : {}),
                  responsibility: {
                    kind: input.responsibilityKind ?? "unknown",
                    ...(input.responsibilityId
                      ? { id: input.responsibilityId }
                      : {}),
                    summary:
                      input.reworkScope === "boundary-changing"
                        ? "The Product Baseline, Repository, or Pipeline boundary must change."
                        : "The frozen Candidate requires same-boundary rework.",
                  },
                },
              }
            : {}),
        },
      });
      setDeliveryCandidateView(decided);
      const refreshed = await window.sandcastle.runtime.inspectRun(
        selectedRun.run.id,
      );
      setSelectedRun(refreshed);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const recoverHumanRelease = async (input: {
    readonly decisionId: string;
    readonly authorityKind:
      | "work-package-version"
      | "test-rework-run"
      | "candidate-input-recheck";
    readonly authorityId: string;
  }): Promise<void> => {
    if (!selectedRun || !deliveryCandidateView) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const recovered = await window.sandcastle.runtime.executeDeliveryCommand({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "delivery.release.recover",
          decisionId: input.decisionId,
          candidateId: deliveryCandidateView.id,
          expectedCandidateHash: deliveryCandidateView.manifestHash,
          authority: {
            kind: input.authorityKind,
            id: input.authorityId,
          },
        },
      });
      setDeliveryCandidateView(recovered);
      const refreshed = await window.sandcastle.runtime.inspectRun(
        selectedRun.run.id,
      );
      setSelectedRun(refreshed);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
    } finally {
      setRunBusy(false);
    }
  };

  const executeReleaseOperation = async (
    command: ReleaseOperationEnvelopeCommand,
  ): Promise<void> => {
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      const result = await window.sandcastle.execute({
        commandId: globalThis.crypto.randomUUID(),
        command,
      });
      if (result.status === "rejected") {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
        });
      }
      setReleaseOperations((current) => [
        ...current.filter((operation) => operation.id !== result.value.id),
        result.value,
      ]);
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      throw nextError;
    } finally {
      setRunBusy(false);
    }
  };

  const decideCriticalRiskEscalation = async (input: {
    readonly decision: "authorize-gate-continuation" | "reject";
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
  }): Promise<void> => {
    if (!selectedRun || !candidateQualityGateView) return;
    setRunBusy(true);
    setRunError(null);
    setRunErrorCode(null);
    try {
      await window.sandcastle.runtime.executeCriticalRiskEscalationCommand({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "quality-gate.critical-escalation.decide",
          escalationId: globalThis.crypto.randomUUID(),
          candidateInputId: candidateQualityGateView.candidateInput.id,
          expectedCandidateInputHash:
            candidateQualityGateView.candidateInput.manifestHash,
          decision: input.decision,
          reason: input.reason,
          evidenceRefs: [...input.evidenceRefs],
        },
      });
      const connection = runtimeViewConnectionCoordinator.current();
      if (connection?.kind === "reviews") {
        await connection.connection.resync();
      }
      const refreshed = await window.sandcastle.runtime.inspectRun(
        selectedRun.run.id,
      );
      setSelectedRun(refreshed);
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
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

  const applySupervisionCommand = async (
    command:
      | {
          readonly type: "node-attempt.cancel";
          readonly runId: string;
          readonly attemptId: string;
        }
      | {
          readonly type: "interaction-turn.cancel";
          readonly runId: string;
          readonly turnId: string;
        }
      | {
          readonly type: "run.governed-intervention";
          readonly runId: string;
          readonly nodeRunId: string;
          readonly reason: string;
          readonly feedback: string;
          readonly outcome: "feedback" | "new-attempt";
        },
  ): Promise<void> => {
    if (!selectedRun) return;
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await window.sandcastle.execute({
        commandId: globalThis.crypto.randomUUID(),
        expectedRevision: selectedRun.run.revision,
        command,
      });
      if (result.status === "rejected") {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
        });
      }
      setRunSupervisionState((current) =>
        applyRunSupervisionFrame(current, {
          generation: current.generation,
          view: result.value,
        }),
      );
      await refreshRuns();
    } catch (nextError) {
      setRunError(errorMessage(nextError));
      setRunErrorCode(runtimeErrorCode(nextError));
      window.sandcastle
        .query({
          type: "run.supervision.inspect",
          runId: selectedRun.run.id,
        })
        .then((result) =>
          setRunSupervisionState((current) =>
            applyRunSupervisionFrame(current, {
              generation: current.generation,
              view: result.view,
            }),
          ),
        )
        .catch(() => undefined);
    } finally {
      setRunBusy(false);
    }
  };

  const saveProject = async (): Promise<void> => {
    await onSave({
      projectId: project.id,
      expectedRevision: project.revision,
      name: name.trim(),
      goal: goal.trim(),
      sharedContext,
      repositoryReferences,
    });
    setActiveTab("overview");
  };

  const inspectStatistics = (): void => {
    const nextQuery = {
      ...statisticsQueryDraft,
      window: { ...statisticsQueryDraft.window },
    };
    if (JSON.stringify(nextQuery) === JSON.stringify(statisticsQuery)) {
      const connection = runtimeViewConnectionCoordinator.current();
      if (connection?.kind === "improvements") {
        setStatisticsDiagnostic("Synchronizing Statistics…");
        void connection.connection
          .resync()
          .catch((nextError: unknown) =>
            setStatisticsDiagnostic(errorMessage(nextError)),
          );
      }
      return;
    }
    setStatisticsView(null);
    setStatisticsDiagnostic("Synchronizing Statistics…");
    setStatisticsQuery(nextQuery);
    statisticsFreezeGesture.current = null;
  };

  const inspectStatisticsEvidence = (): void => {
    const evidenceSnapshotId = statisticsEvidenceIdInput.trim();
    if (!evidenceSnapshotId) return;
    setStatisticsEvidence(null);
    setStatisticsDiagnostic("Synchronizing Statistics evidence…");
    setStatisticsEvidenceSnapshotId(evidenceSnapshotId);
  };

  const freezeStatisticsEvidence = async (): Promise<void> => {
    if (!statisticsView) return;
    setStatisticsBusy(true);
    setStatisticsDiagnostic(null);
    try {
      const queryKey = JSON.stringify(statisticsView.query);
      const gesture =
        statisticsFreezeGesture.current?.queryKey === queryKey
          ? statisticsFreezeGesture.current
          : {
              queryKey,
              commandId: `statistics-freeze:${globalThis.crypto.randomUUID()}`,
              evidenceSnapshotId: `statistics-evidence:${globalThis.crypto.randomUUID()}`,
            };
      statisticsFreezeGesture.current = gesture;
      const result = await window.sandcastle.execute({
        commandId: gesture.commandId,
        command: {
          type: "statistics.evidence.freeze",
          evidenceSnapshotId: gesture.evidenceSnapshotId,
          query: statisticsView.query,
        },
      });
      if (result.status === "rejected") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      setStatisticsEvidence(result.value);
      setStatisticsEvidenceIdInput(result.value.id);
      setStatisticsEvidenceSnapshotId(result.value.id);
    } catch (nextError) {
      setStatisticsDiagnostic(errorMessage(nextError));
    } finally {
      setStatisticsBusy(false);
    }
  };

  const improvementProposalContent = (
    draft: ImprovementProposalDraft,
  ): ImprovementProposalRevisionContent | null => {
    const evidence = statisticsEvidence;
    const metricId = draft.metricId;
    if (!evidence || !metricId) return null;
    const governedHeadRevisionId = draft.governedHeadRevisionId.trim();
    const governedHeadRevisionHash = draft.governedHeadRevisionHash.trim();
    return {
      evidence,
      target: {
        targetKind: "harness",
        ownerId: draft.targetOwnerId.trim(),
        governedHead:
          governedHeadRevisionId && governedHeadRevisionHash
            ? {
                revisionId: governedHeadRevisionId,
                revisionHash: governedHeadRevisionHash,
              }
            : { revisionId: null, revisionHash: null },
        content: {
          principles: [draft.principle.trim()],
          constitution: draft.constitution.trim(),
          rules: [draft.rule.trim()],
          examples: { positive: [], negative: [] },
          impactScope: [project.id],
        },
      },
      rootCauseHypothesis: draft.rootCauseHypothesis.trim(),
      impactScope: {
        projectIds: [project.id],
        departmentIds: [],
        positionIds: [],
      },
      expectedMetrics: [{ metricId, direction: "decrease" }],
      validationPolicy: {
        metricIds: [metricId],
        minimumComparableObservations: 1,
      },
      rolloutNotes: draft.rolloutNotes.trim(),
      rollbackSource: {
        revisionId: draft.rollbackRevisionId.trim(),
        revisionHash: draft.rollbackRevisionHash.trim(),
      },
    };
  };

  const resyncImprovements = async (): Promise<void> => {
    const connection = runtimeViewConnectionCoordinator.current();
    if (connection?.kind === "improvements") {
      await connection.connection.resync();
    }
  };

  const createImprovementProposal = async (
    draft: ImprovementProposalDraft,
  ): Promise<void> => {
    const content = improvementProposalContent(draft);
    if (!content) return;
    setStatisticsBusy(true);
    setStatisticsDiagnostic(null);
    try {
      const key = `create:${JSON.stringify(content)}`;
      const gesture = improvementProposalGestures.current.get(key) ?? {
        commandId: `improvement-proposal-create:${globalThis.crypto.randomUUID()}`,
        proposalId: `improvement-proposal:${globalThis.crypto.randomUUID()}`,
        revisionId: `improvement-proposal-revision:${globalThis.crypto.randomUUID()}`,
      };
      improvementProposalGestures.current.set(key, gesture);
      const result = await window.sandcastle.execute({
        commandId: gesture.commandId,
        command: {
          type: "improvement.proposal.create",
          proposal: {
            proposalId: gesture.proposalId!,
            revisionId: gesture.revisionId!,
            projectId: project.id,
            departmentId: null,
            content,
          },
        },
      });
      if (result.status === "rejected") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      await resyncImprovements();
    } catch (nextError) {
      setStatisticsDiagnostic(errorMessage(nextError));
    } finally {
      setStatisticsBusy(false);
    }
  };

  const reviseImprovementProposal = async (
    proposal: ImprovementProposalView,
    draft: ImprovementProposalDraft,
  ): Promise<void> => {
    const content = improvementProposalContent(draft);
    const currentRevision = proposal.revisions.find(
      (revision) => revision.id === proposal.currentRevisionId,
    );
    if (!content || !currentRevision) return;
    setStatisticsBusy(true);
    setStatisticsDiagnostic(null);
    try {
      const key = `revise:${proposal.id}:${currentRevision.hash}:${JSON.stringify(content)}`;
      const gesture = improvementProposalGestures.current.get(key) ?? {
        commandId: `improvement-proposal-revise:${globalThis.crypto.randomUUID()}`,
        revisionId: `improvement-proposal-revision:${globalThis.crypto.randomUUID()}`,
      };
      improvementProposalGestures.current.set(key, gesture);
      const result = await window.sandcastle.execute({
        commandId: gesture.commandId,
        command: {
          type: "improvement.proposal.revise",
          proposal: {
            proposalId: proposal.id,
            revisionId: gesture.revisionId!,
            supersedesRevisionId: currentRevision.id,
            expectedSupersededRevisionHash: currentRevision.hash,
            content,
          },
        },
      });
      if (result.status === "rejected") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      await resyncImprovements();
    } catch (nextError) {
      setStatisticsDiagnostic(errorMessage(nextError));
    } finally {
      setStatisticsBusy(false);
    }
  };

  const proposeImprovementProposal = async (
    proposal: ImprovementProposalView,
  ): Promise<void> => {
    const currentRevision = proposal.revisions.find(
      (revision) => revision.id === proposal.currentRevisionId,
    );
    if (!currentRevision) return;
    setStatisticsBusy(true);
    setStatisticsDiagnostic(null);
    try {
      const key = `propose:${proposal.id}:${currentRevision.id}:${currentRevision.hash}`;
      const gesture = improvementProposalGestures.current.get(key) ?? {
        commandId: `improvement-proposal-propose:${globalThis.crypto.randomUUID()}`,
      };
      improvementProposalGestures.current.set(key, gesture);
      const result = await window.sandcastle.execute({
        commandId: gesture.commandId,
        command: {
          type: "improvement.proposal.propose",
          proposalId: proposal.id,
          proposalRevisionId: currentRevision.id,
          expectedProposalRevisionHash: currentRevision.hash,
        },
      });
      if (result.status === "rejected") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      await resyncImprovements();
    } catch (nextError) {
      setStatisticsDiagnostic(errorMessage(nextError));
    } finally {
      setStatisticsBusy(false);
    }
  };

  const requestImprovementProposalDecision = async (
    proposal: ImprovementProposalView,
    confirmation: string,
  ): Promise<void> => {
    const currentRevision = proposal.revisions.find(
      (revision) => revision.id === proposal.currentRevisionId,
    );
    if (!currentRevision) return;
    setStatisticsBusy(true);
    setStatisticsDiagnostic(null);
    try {
      const key = `request-decision:${proposal.id}:${currentRevision.id}:${currentRevision.hash}:${confirmation}`;
      const gesture = improvementProposalGestures.current.get(key) ?? {
        commandId: `improvement-proposal-request-decision:${globalThis.crypto.randomUUID()}`,
      };
      improvementProposalGestures.current.set(key, gesture);
      const result = await window.sandcastle.execute({
        commandId: gesture.commandId,
        command: {
          type: "improvement.proposal.request-decision",
          proposalId: proposal.id,
          proposalRevisionId: currentRevision.id,
          expectedProposalRevisionHash: currentRevision.hash,
          confirmation,
        },
      });
      if (result.status === "rejected") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      await resyncImprovements();
    } catch (nextError) {
      setStatisticsDiagnostic(errorMessage(nextError));
    } finally {
      setStatisticsBusy(false);
    }
  };

  const decideImprovementProposal = async (
    proposal: ImprovementProposalView,
    decision: "approved" | "rejected",
    confirmation: string,
    reason: string,
  ): Promise<void> => {
    const currentRevision = proposal.revisions.find(
      (revision) => revision.id === proposal.currentRevisionId,
    );
    if (!currentRevision) return;
    setStatisticsBusy(true);
    setStatisticsDiagnostic(null);
    try {
      const key = `decide:${proposal.id}:${currentRevision.id}:${currentRevision.hash}:${decision}:${confirmation}:${reason}`;
      const gesture = improvementProposalGestures.current.get(key) ?? {
        commandId: `improvement-proposal-decide:${globalThis.crypto.randomUUID()}`,
      };
      improvementProposalGestures.current.set(key, gesture);
      const result = await window.sandcastle.execute({
        commandId: gesture.commandId,
        command: {
          type: "improvement.proposal.decide",
          proposalId: proposal.id,
          proposalRevisionId: currentRevision.id,
          expectedProposalRevisionHash: currentRevision.hash,
          decision,
          confirmation,
          reason,
          evidenceRefs: [currentRevision.content.evidence.id],
        },
      });
      if (result.status === "rejected") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      await resyncImprovements();
    } catch (nextError) {
      setStatisticsDiagnostic(errorMessage(nextError));
    } finally {
      setStatisticsBusy(false);
    }
  };

  return (
    <section
      className="page"
      data-page="project-detail"
      data-runtime-project-id={project.id}
      data-project-revision={project.revision}
      data-project-collaboration={collaboration ? "active" : undefined}
    >
      <header className="page-heading department-detail-heading">
        <div>
          <button className="text-button" onClick={onBack} type="button">
            <Icon name="back" size={20} />
            {t.backToProjects}
          </button>
          <span className="eyebrow">{t.projectWorkbench}</span>
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
      <div className="project-tabs" role="tablist">
        {(
          [
            ["overview", t.projectOverviewTab],
            ["consultation", t.interactionConsultation],
            ["runs", t.projectRunsTab],
            ["artifacts", t.projectArtifactsTab],
            ["reviews", "Reviews"],
            ["improvements", t.projectImprovementsTab],
            ["memory", t.projectMemoryTab],
            ["settings", t.projectSettingsTab],
          ] as const
        ).map(([tab, label]) => (
          <button
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "on" : ""}
            data-project-tab={tab}
            key={tab}
            onClick={() => setActiveTab(tab)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab === "overview" ? (
        <section className="project-overview-grid" data-project-overview>
          <article className="create-panel">
            <h2>{t.projectGoal}</h2>
            <p>{project.goal}</p>
            <dl className="overview-inventory">
              <div>
                <dt>{t.status}</dt>
                <dd>{statusName(t, project.status)}</dd>
              </div>
              <div>
                <dt>{t.departmentRuns}</dt>
                <dd>{project.departmentRuns.length}</dd>
              </div>
              <div>
                <dt>{t.repositoryReferences}</dt>
                <dd>{project.repositoryReferences.length}</dd>
              </div>
            </dl>
          </article>
          <article className="create-panel">
            <h2>{t.sharedContext}</h2>
            <p>{project.sharedContext || t.noSharedContext}</p>
            <button
              className="primary-button"
              onClick={() => setActiveTab("settings")}
              type="button"
            >
              {t.editProjectSettings}
              <Icon name="edit" size={20} />
            </button>
          </article>
        </section>
      ) : null}
      {activeTab === "consultation" ? (
        <section
          className="project-consultation"
          data-consultation-mode="informal"
          data-project-consultation
        >
          <header className="project-consultation-header">
            <div className="factory-object-icon is-member">
              <Icon name="member" size={24} />
            </div>
            <div>
              <span className="eyebrow">{t.agentInteraction}</span>
              <h2>{t.interactionConsultation}</h2>
              <p>{project.goal}</p>
            </div>
            <span className="mode-badge mode-consultation">
              {t.interactionConsultation}
            </span>
          </header>
          <div className="consultation-mode-boundary">
            <Icon name="approval" size={24} />
            <div>
              <strong>{t.interactionConsultation}</strong>
              <p>{t.agentInteractionBody}</p>
            </div>
          </div>
          <section className="create-panel" data-product-proposal>
            <div className="panel-heading-with-icon">
              <Icon name="artifact" size={24} />
              <div>
                <h3>Product Proposal</h3>
                <p data-product-proposal-identity>
                  {productDiscovery?.proposal
                    ? `revision ${productDiscovery.proposal.revision} · ${productDiscovery.proposal.currentRevision.hash}`
                    : "No authoritative revision yet"}
                </p>
              </div>
            </div>
            <label>
              <span>Goal</span>
              <textarea
                data-product-proposal-field="goal"
                value={proposalDraft.goal}
                onChange={(event) =>
                  setProposalDraft((current) => ({
                    ...current,
                    goal: event.target.value,
                  }))
                }
              />
            </label>
            {(
              [
                "users",
                "scope",
                "nonGoals",
                "acceptanceCriteria",
                "constraints",
                "risks",
                "openQuestions",
              ] as const
            ).map((field) => (
              <label key={field}>
                <span>{field}</span>
                <textarea
                  data-product-proposal-field={field}
                  value={proposalDraft[field].join("\n")}
                  onChange={(event) =>
                    setProposalDraft((current) => ({
                      ...current,
                      [field]: event.target.value
                        .split("\n")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    }))
                  }
                />
              </label>
            ))}
            <div className="action-bar">
              <button
                data-product-proposal-revise
                disabled={runBusy || !consultation}
                onClick={() => void reviseProposal()}
                type="button"
              >
                Save Product Proposal
              </button>
              <button
                data-product-proposal-awaiting
                disabled={
                  runBusy ||
                  !productDiscovery?.proposal ||
                  productDiscovery.proposal.status === "awaiting-confirmation"
                }
                onClick={() => void markProposalAwaiting()}
                type="button"
              >
                Mark awaiting confirmation
              </button>
            </div>
            {productDiscovery?.baselines.map((baseline) => (
              <div data-product-baseline={baseline.id} key={baseline.id}>
                Product Baseline {baseline.hash} · Run {baseline.runId} · r1{" "}
                {baseline.snapshotRevisionId}
              </div>
            ))}
            {productReview ? (
              <ProductReviewStatePanel state={productReview} />
            ) : null}
            {technicalReview ? (
              <TechnicalReviewStatePanel state={technicalReview} />
            ) : null}
          </section>
          {consultation ? (
            <>
              <div
                className="project-consultation-history"
                data-consultation-history
              >
                {consultation.messages.length ? (
                  consultation.messages.map((item) => (
                    <article
                      className="consultation-message"
                      data-session-message={item.id}
                      key={item.id}
                    >
                      <Icon
                        name={item.kind === "status" ? "run" : "member"}
                        size={20}
                      />
                      <div>
                        <strong>
                          {item.kind === "status"
                            ? interactionStatusLabel(t, item.content)
                            : item.content}
                        </strong>
                        <small>{formatAgentTimestamp(item.createdAt)}</small>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="empty-state">{t.interactionNoMessages}</div>
                )}
              </div>
              <div className="project-consultation-composer">
                <textarea
                  aria-label={t.interactionMessagePlaceholder}
                  disabled={
                    interactionBusy || consultation.session.status === "closed"
                  }
                  placeholder={t.interactionMessagePlaceholder}
                  value={consultationMessage}
                  onChange={(event) =>
                    setConsultationMessage(event.target.value)
                  }
                />
                <button
                  className="secondary-button"
                  disabled={interactionBusy || !consultationMessage.trim()}
                  onClick={() => void sendConsultationMessage()}
                  type="button"
                >
                  <Icon name="send" size={20} />
                  {t.sendMessage}
                </button>
              </div>
            </>
          ) : (
            <div className="project-consultation-empty">
              <Icon name="architect" size={24} />
              <strong>{t.createConsultation}</strong>
              <span>{t.interactionMessagePlaceholder}</span>
              <button
                className="secondary-button"
                data-consultation-start
                disabled={interactionBusy}
                onClick={() => void startConsultation()}
                type="button"
              >
                <Icon name="member" size={20} />
                {t.createConsultation}
              </button>
            </div>
          )}
          <div className="consultation-confirm-bar">
            <div>
              <span className="eyebrow">{t.departmentRuns}</span>
              <strong>{t.startDepartmentRun}</strong>
              <small>
                {productDiscovery?.proposal?.status ?? "draft"} · Runtime Query
              </small>
            </div>
            <button
              className="primary-button"
              data-consultation-confirm
              disabled={
                runBusy ||
                runDepartmentId === "" ||
                !consultation ||
                productDiscovery?.proposal?.status !== "awaiting-confirmation"
              }
              onClick={() => void confirmConsultation()}
              type="button"
            >
              <Icon name="run" size={20} />
              Confirm Product Baseline
            </button>
          </div>
        </section>
      ) : null}
      {collaboration && selectedRun && activeTab === "runs" ? (
        <RunCollaborationWorkspace
          artifacts={runArtifacts}
          collaboration={collaboration}
          consultation={consultation}
          busy={runBusy || interactionBusy}
          onDecision={(input) => void decideApproval(input)}
          onRetryApproval={(nodeRunId) => void retryApproval(nodeRunId)}
          onRetry={(input) => void retryNode(input)}
          onContinue={() => void continueRun()}
          onControl={(action) => void controlRun(action)}
          onRecover={(input) => void recoverRun(input)}
          onFork={(nodeRunId) => void forkRun(nodeRunId)}
          onPermissionDecision={(permissionId, decision) =>
            void decideCollaborationPermission(permissionId, decision)
          }
          onPermissionRequest={(scope) =>
            void requestCollaborationPermission(scope)
          }
          onSend={(content) => void sendCollaborationMessage(content)}
          run={selectedRun}
          t={t}
        />
      ) : null}
      <ProjectDetailWorkPackages
        active={Boolean(selectedRun) && activeTab === "runs"}
        graph={workPackageGraph}
      />
      {activeTab === "artifacts" ? (
        <section className="create-panel" data-project-artifacts>
          <h2>{t.projectArtifactsTab}</h2>
          <div className="empty-state">
            <strong>{t.noProjectArtifacts}</strong>
            <span>{t.noProjectArtifactsBody}</span>
          </div>
        </section>
      ) : null}
      {activeTab === "reviews" ? (
        <>
          <CodeReviewAuthorityPanel reviews={codeReviews} />
          <IntegrationGenerationPanel
            diagnostic={integrationDiagnostic}
            generations={integrationGenerationState.view}
            onResync={() =>
              void (runtimeViewConnectionCoordinator.current()?.kind ===
              "reviews"
                ? runtimeViewConnectionCoordinator
                    .current()
                    ?.connection.resync()
                : undefined)
            }
          />
          <CandidateQualityGatePanel
            busy={runBusy}
            diagnostic={candidateQualityDiagnostic}
            onCriticalEscalation={(input) =>
              void decideCriticalRiskEscalation(input)
            }
            view={candidateQualityGateView}
          />
          <DeliveryCandidatePanel
            busy={runBusy}
            diagnostic={deliveryCandidateDiagnostic}
            onDecision={(input) => void decideHumanRelease(input)}
            onRecovery={(input) => void recoverHumanRelease(input)}
            view={deliveryCandidateView}
          />
          <ReleaseOperationPanel
            candidate={deliveryCandidateView}
            authority={acceptedDeliveryAuthority}
            operations={releaseOperations}
            onCommand={executeReleaseOperation}
          />
          <ReviewTopicsPanel topics={reviewTopics} />
        </>
      ) : null}
      {activeTab === "improvements" ? (
        <ProjectImprovementsPanel
          busy={statisticsBusy}
          diagnostic={statisticsDiagnostic}
          evidence={statisticsEvidence}
          evidenceSnapshotId={statisticsEvidenceIdInput}
          onEvidenceSnapshotIdChange={setStatisticsEvidenceIdInput}
          onFreeze={() => void freezeStatisticsEvidence()}
          onCreateProposal={(draft) => void createImprovementProposal(draft)}
          onReviseProposal={(proposal, draft) =>
            void reviseImprovementProposal(proposal, draft)
          }
          onProposeProposal={(proposal) =>
            void proposeImprovementProposal(proposal)
          }
          onRequestDecision={(proposal, confirmation) =>
            void requestImprovementProposalDecision(proposal, confirmation)
          }
          onDecideProposal={(proposal, decision, confirmation, reason) =>
            void decideImprovementProposal(
              proposal,
              decision,
              confirmation,
              reason,
            )
          }
          onInspect={inspectStatistics}
          onInspectEvidence={inspectStatisticsEvidence}
          onWindowChange={(window: StatisticsWindow) =>
            setStatisticsQueryDraft((current) => ({ ...current, window }))
          }
          query={statisticsQueryDraft}
          proposals={improvementProposals}
          t={t}
          view={statisticsView}
        />
      ) : null}
      {activeTab === "memory" ? (
        <section className="create-panel" data-project-memory>
          <h2>{t.projectMemoryTab}</h2>
          <p>{project.sharedContext || t.noSharedContext}</p>
        </section>
      ) : null}
      <div
        className="project-configuration-grid"
        data-active-project-tab={activeTab}
        data-project-tab-content
      >
        <section className="create-panel">
          <h2>{t.projectDetailEyebrow}</h2>
          <form
            className="form"
            data-project-settings
            onSubmit={(event) => {
              event.preventDefault();
              void saveProject().catch(() => undefined);
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
          <div className="form run-start-form project-run-start-panel">
            <div className="run-start-field">
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
            </div>
            <div className="run-start-field">
              <label htmlFor="project-run-agent-override">
                {t.temporaryAgentOverride}
              </label>
              <select
                id="project-run-agent-override"
                value={agentOverrideId}
                onChange={(event) => setAgentOverrideId(event.target.value)}
              >
                <option value="">{t.usePositionDefaults}</option>
                {runAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="run-start-submit" data-run-start-submit>
              <button
                className="primary-button"
                data-start-department-run
                data-open-consultation
                disabled={runBusy || runDepartmentId === ""}
                onClick={() => setActiveTab("consultation")}
                type="button"
              >
                {t.startDepartmentRun}
              </button>
            </div>
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
          <div className="project-runs-workspace">
            <div className="project-run-list" data-project-run-list>
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
            </div>
            <div className="project-run-detail-pane" data-project-run-detail>
              {selectedRun ? (
                <>
                  {runSupervision ? (
                    <RunSupervisionPanel
                      busy={runBusy || interactionBusy}
                      diagnostic={runSupervisionDiagnostic}
                      onCancelAttempt={(attemptId) =>
                        void applySupervisionCommand({
                          type: "node-attempt.cancel",
                          runId: selectedRun.run.id,
                          attemptId,
                        })
                      }
                      onCancelTurn={(turnId) =>
                        void applySupervisionCommand({
                          type: "interaction-turn.cancel",
                          runId: selectedRun.run.id,
                          turnId,
                        })
                      }
                      onDecidePermission={(permissionId, decision) =>
                        void decideCollaborationPermission(
                          permissionId,
                          decision,
                        )
                      }
                      onIntervene={(input) =>
                        void applySupervisionCommand({
                          type: "run.governed-intervention",
                          runId: selectedRun.run.id,
                          ...input,
                        })
                      }
                      onPause={() => void controlRun("pause")}
                      onResync={() =>
                        void (runtimeViewConnectionCoordinator.current()
                          ?.kind === "runs"
                          ? runtimeViewConnectionCoordinator
                              .current()
                              ?.connection.resync()
                          : undefined)
                      }
                      onResume={() => void controlRun("resume")}
                      view={runSupervision}
                    />
                  ) : null}
                  <DepartmentRunDetail
                    busy={runBusy}
                    onDecision={(input) => void decideApproval(input)}
                    onRetryApproval={(nodeRunId) =>
                      void retryApproval(nodeRunId)
                    }
                    onRetry={(input) => void retryNode(input)}
                    onContinue={() => void continueRun()}
                    onControl={(action) => void controlRun(action)}
                    onRecover={(input) => void recoverRun(input)}
                    onFork={(nodeRunId) => void forkRun(nodeRunId)}
                    run={selectedRun}
                    t={t}
                  />
                </>
              ) : (
                <div className="empty-state">{t.selectRunToInspect}</div>
              )}
            </div>
          </div>
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
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalogView | null>(
    null,
  );
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
      const [department, pipeline, skills, agents] = await Promise.all([
        window.sandcastle.runtime.inspectDepartment(departmentId),
        window.sandcastle.runtime.inspectPipeline(departmentId),
        window.sandcastle.runtime.inspectSkillConfiguration(departmentId),
        window.sandcastle.runtime.inspectAgentCatalog(),
      ]);
      setSelectedDepartment(department);
      setPipelineEditor(pipeline);
      setSkillConfiguration(skills);
      setAgentCatalog(agents);
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

  const configurePosition = async (
    input: Parameters<typeof window.sandcastle.runtime.configurePosition>[0],
  ) => {
    setError(null);
    setSkillErrorCode(null);
    setDetailLoading(true);
    try {
      const configured =
        await window.sandcastle.runtime.configurePosition(input);
      setSelectedDepartment(configured.department);
      setSkillConfiguration(configured.skills);
    } catch (nextError) {
      setError(errorMessage(nextError));
      setSkillErrorCode(runtimeErrorCode(nextError));
      throw nextError;
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
          setAgentCatalog(null);
        }}
        onTabChange={setActiveTab}
        onUpdateDepartment={updateDepartment}
        onArchiveDepartment={archiveDepartment}
        onCopyDepartment={copyDepartment}
        onUpdatePosition={updatePosition}
        onConfigurePosition={configurePosition}
        agentCatalog={agentCatalog ?? undefined}
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
                <span className="card-domain-icon is-department">
                  <Icon name="department" size={24} />
                </span>
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

export type DepartmentTab = "overview" | "positions" | "settings" | "pipeline";

type RegisterDepartmentSettingsSave = (
  operation: DepartmentSettingsSaveOperation,
) => () => void;

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
  onConfigurePosition,
  agentCatalog,
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
  readonly agentCatalog?: AgentCatalogView;
  readonly onConfigurePosition?: (
    input: Parameters<typeof window.sandcastle.runtime.configurePosition>[0],
  ) => Promise<void>;
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
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(
    null,
  );
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(
    null,
  );
  const settingsSaveOperations = useRef(
    new Map<string, DepartmentSettingsSaveOperation>(),
  );
  useEffect(() => {
    setName(department.name);
    setDescription(department.description);
    setInputArtifactContracts([...department.inputArtifactContracts]);
    setOutputArtifactContracts([...department.outputArtifactContracts]);
    setDefaultExecutionProfileId(department.defaultExecutionProfileId);
    setCopyName(`${department.name} Copy`);
  }, [department]);
  const modernConfiguration = Boolean(agentCatalog && onConfigurePosition);
  const registerSettingsSave: RegisterDepartmentSettingsSave = (operation) => {
    settingsSaveOperations.current.set(operation.id, operation);
    return () => {
      if (settingsSaveOperations.current.get(operation.id) === operation) {
        settingsSaveOperations.current.delete(operation.id);
      }
    };
  };
  const saveAllSettings = async () => {
    setSettingsSaveError(null);
    try {
      await saveDepartmentSettings([
        {
          id: "department",
          label: t.departmentSettings,
          save: async () => {
            await onUpdateDepartment({
              departmentId: department.id,
              expectedRevision: department.revision,
              name: name.trim(),
              description: description.trim(),
              inputArtifactContracts,
              outputArtifactContracts,
              defaultExecutionProfileId,
            });
          },
        },
        ...settingsSaveOperations.current.values(),
      ]);
    } catch (nextError) {
      setSettingsSaveError(errorMessage(nextError));
    }
  };
  return (
    <section
      aria-busy={busy}
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
      {settingsSaveError ? (
        <div className="warn" data-department-settings-error>
          {settingsSaveError}
        </div>
      ) : null}
      <div className="department-tabs" role="tablist">
        {(modernConfiguration
          ? ([
              ["overview", t.overviewTab],
              ["positions", t.positionsTab],
              ["settings", t.departmentSettings],
              ["pipeline", t.pipelineTab],
            ] as const)
          : ([
              ["overview", t.overviewTab],
              ["positions", t.positionsTab],
              ["pipeline", t.pipelineTab],
            ] as const)
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

      {activeTab === "overview" && modernConfiguration ? (
        <section
          className="department-overview-grid"
          data-department-panel="overview"
        >
          <article className="create-panel">
            <h2>{t.departmentSummary}</h2>
            <p>{department.description}</p>
            <dl className="overview-inventory">
              <div>
                <dt>{t.publishedPipeline}</dt>
                <dd>
                  {department.pipeline
                    ? `v${department.pipeline.version}`
                    : t.none}
                </dd>
              </div>
              <div>
                <dt>{t.positionsTab}</dt>
                <dd>{department.positions.length}</dd>
              </div>
              <div>
                <dt>{t.defaultRunStatus}</dt>
                <dd>
                  {department.activeRuns > 0 ? t.runningStatus : t.readyStatus}
                </dd>
              </div>
              <div>
                <dt>{t.recentRun}</dt>
                <dd>
                  {department.activeRuns > 0
                    ? `${department.activeRuns} ${t.metricActiveRuns}`
                    : t.noRecentRun}
                </dd>
              </div>
            </dl>
          </article>
          <article className="create-panel">
            <h2>{t.runtimeInheritance}</h2>
            {department.positions.map((position) => (
              <div className="task-card" key={position.id}>
                <strong>{positionName(t, position)}</strong>
                <span>
                  {t.inheritedAgent}:{" "}
                  {agentCatalog?.agents.find(
                    (agent) => agent.id === position.defaultAgentId,
                  )?.name ?? position.defaultAgentId}
                </span>
              </div>
            ))}
          </article>
        </section>
      ) : null}

      {activeTab === (modernConfiguration ? "settings" : "overview") ? (
        <section
          className="department-overview-grid"
          data-department-panel={modernConfiguration ? "settings" : "overview"}
        >
          <div className="department-settings-column">
            <article className="create-panel">
              <h2>{t.departmentSettings}</h2>
              <form
                className="form department-settings-form"
                data-department-settings
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAllSettings();
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
                <details data-artifact-contract-settings>
                  <summary>
                    {t.artifactContractsSettings} ·{" "}
                    {inputArtifactContracts.length +
                      outputArtifactContracts.length}
                  </summary>
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
                </details>
              </form>
            </article>
            <details className="create-panel" data-department-advanced-settings>
              <summary>{t.advancedSettings}</summary>
              <ExecutionProfileConfiguration
                busy={busy}
                department={department}
                onArchive={onArchiveExecutionProfile}
                registerSave={registerSettingsSave}
                onSave={onSaveExecutionProfile}
                t={t}
              />
              <SecretReferenceConfiguration
                busy={busy}
                department={department}
                onArchive={onArchiveSecretReference}
                onCreate={onCreateSecretReference}
                registerSave={registerSettingsSave}
                t={t}
              />
            </details>
          </div>
          <div className="department-settings-column">
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
            <article className="create-panel department-actions-panel">
              <h2>{t.departmentActions}</h2>
              <button
                data-save-department-settings
                disabled={busy}
                onClick={() => void saveAllSettings()}
                type="button"
              >
                {t.saveDepartment}
              </button>
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
          </div>
        </section>
      ) : null}

      {activeTab === "positions" ? (
        <section data-department-panel="positions">
          <div className="position-grid compact">
            {department.positions.map((position) => {
              const binding = skillConfiguration.positions.find(
                (candidate) => candidate.id === position.id,
              );
              const flowCount = skillConfiguration.skillFlows.filter(
                (flow) =>
                  flow.positionId === position.id && flow.status === "active",
              ).length;
              return agentCatalog && onConfigurePosition ? (
                <article
                  className="position-card compact"
                  data-position-summary={position.id}
                  key={position.id}
                >
                  <div className="project-card-top">
                    <strong>{positionName(t, position)}</strong>
                    <span className="pill">
                      {statusName(t, position.status)}
                    </span>
                  </div>
                  <dl className="catalog-meta">
                    <div>
                      <dt>{t.aiMemberDisplayName}</dt>
                      <dd>{position.aiMember.displayName}</dd>
                    </div>
                    <div>
                      <dt>{t.defaultAgent}</dt>
                      <dd>
                        {agentCatalog.agents.find(
                          (agent) => agent.id === position.defaultAgentId,
                        )?.name ?? position.defaultAgentId}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.positionSkills}</dt>
                      <dd>{binding?.skillIds.length ?? 0}</dd>
                    </div>
                    <div>
                      <dt>{t.skillFlows}</dt>
                      <dd>{flowCount}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    data-edit-position={position.id}
                    onClick={() => setSelectedPositionId(position.id)}
                  >
                    {t.editPosition}
                  </button>
                </article>
              ) : (
                <PositionEditor
                  busy={busy}
                  departmentId={department.id}
                  key={position.id}
                  onArchive={onArchivePosition}
                  onUpdate={onUpdatePosition}
                  position={position}
                  t={t}
                />
              );
            })}
            <NewPositionEditor
              busy={busy}
              departmentId={department.id}
              onCreate={onCreatePosition}
              t={t}
            />
          </div>
          {agentCatalog && onConfigurePosition ? (
            <>
              <PositionSkillFlowPanel
                busy={busy}
                configuration={skillConfiguration}
                onArchiveSkillFlow={onArchiveSkillFlow}
                onSaveSkillFlow={onSaveSkillFlow}
                t={t}
              />
              <div aria-hidden="true" hidden>
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
              </div>
            </>
          ) : (
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
          )}
          {agentCatalog && onConfigurePosition && selectedPositionId ? (
            <PositionDrawerEditor
              agentCatalog={agentCatalog}
              busy={busy}
              configuration={skillConfiguration}
              departmentId={department.id}
              onArchive={onArchivePosition}
              onClose={() => setSelectedPositionId(null)}
              onSave={onConfigurePosition}
              position={
                department.positions.find(
                  (position) => position.id === selectedPositionId,
                )!
              }
              t={t}
            />
          ) : null}
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
  registerSave,
}: {
  readonly department: DepartmentInspect;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: SandcastleBridgeRuntimeSaveExecutionProfile;
  readonly registerSave: RegisterDepartmentSettingsSave;
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
          registerSave={registerSave}
          onSave={onSave}
          profile={profile}
          t={t}
        />
      ))}
      <ExecutionProfileEditor
        busy={busy}
        department={department}
        onArchive={onArchive}
        registerSave={registerSave}
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
  registerSave,
}: {
  readonly department: DepartmentInspect;
  readonly profile?: DepartmentInspect["executionProfiles"][number];
  readonly t: Messages;
  readonly busy: boolean;
  readonly onSave: SandcastleBridgeRuntimeSaveExecutionProfile;
  readonly registerSave: RegisterDepartmentSettingsSave;
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    const fields = {
      name: name.trim(),
      providerRef: providerRef.trim(),
      model: model.trim(),
      sandboxRef: sandboxRef.trim(),
    };
    const blankNewProfile =
      !profile && Object.values(fields).every((value) => value === "");
    const dirty = profile
      ? fields.name !== profile.name ||
        fields.providerRef !== profile.providerRef ||
        fields.model !== profile.model ||
        fields.sandboxRef !== profile.sandboxRef ||
        branchStrategy !== profile.branchStrategy ||
        timeoutSeconds !== profile.limits.timeoutSeconds ||
        maxIterations !== profile.limits.maxIterations ||
        maxTokens !== (profile.limits.maxTokens?.toString() ?? "") ||
        retryMaxAttempts !== profile.retryPolicy.maxAttempts ||
        permissionPolicy !== profile.permissionPolicy ||
        secretReferenceIds.join("\0") !== profile.secretReferenceIds.join("\0")
      : !blankNewProfile;
    return registerSave({
      id: `run-environment:${profile?.id ?? "new"}`,
      label: profile?.name ?? t.createExecutionProfile,
      save: async () => {
        if (!dirty) return;
        if (Object.values(fields).some((value) => value === "")) {
          throw new Error(t.completeRequiredFields);
        }
        await onSave({
          departmentId: department.id,
          ...(profile ? { executionProfileId: profile.id } : {}),
          expectedRevision: profile?.revision ?? 0,
          ...fields,
          branchStrategy,
          timeoutSeconds,
          maxIterations,
          maxTokens: maxTokens.trim() === "" ? null : Number(maxTokens),
          retryMaxAttempts,
          permissionPolicy,
          secretReferenceIds,
        });
      },
    });
  }, [
    branchStrategy,
    department.id,
    maxIterations,
    maxTokens,
    model,
    name,
    onSave,
    permissionPolicy,
    profile,
    providerRef,
    registerSave,
    retryMaxAttempts,
    sandboxRef,
    secretReferenceIds,
    t.completeRequiredFields,
    t.createExecutionProfile,
    timeoutSeconds,
  ]);
  return (
    <form
      className={`form skill-flow-card${advancedOpen ? " run-environment-open" : ""}`}
      data-execution-profile-editor={profile?.id ?? "new"}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <h3>{profile ? profile.name : t.createExecutionProfile}</h3>
      <button
        aria-expanded={advancedOpen}
        data-run-environment-toggle={profile?.id ?? "new"}
        onClick={() => setAdvancedOpen((current) => !current)}
        type="button"
      >
        {t.editAdvancedRunEnvironment}
      </button>
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
  registerSave,
}: {
  readonly department: DepartmentInspect;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onCreate: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly providerScope: string;
  }) => Promise<void>;
  readonly registerSave: RegisterDepartmentSettingsSave;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly secretReferenceId: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [providerScope, setProviderScope] = useState("");
  useEffect(
    () =>
      registerSave({
        id: "secret-reference:new",
        label: t.secretReferences,
        save: async () => {
          const nextName = name.trim();
          const nextProviderScope = providerScope.trim();
          if (!nextName && !nextProviderScope) return;
          if (!nextName || !nextProviderScope) {
            throw new Error(t.completeRequiredFields);
          }
          await onCreate({
            departmentId: department.id,
            name: nextName,
            providerScope: nextProviderScope,
          });
          setName("");
          setProviderScope("");
        },
      }),
    [
      department.id,
      name,
      onCreate,
      providerScope,
      registerSave,
      t.completeRequiredFields,
      t.secretReferences,
    ],
  );
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

function PositionSkillFlowPanel({
  configuration,
  t,
  busy,
  onSaveSkillFlow,
  onArchiveSkillFlow,
}: {
  readonly configuration: SkillConfigurationView;
  readonly t: Messages;
  readonly busy: boolean;
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
    <section className="skill-configuration" data-position-skill-flows>
      <div className="stage-heading">
        <div>
          <h2>{t.skillFlows}</h2>
          <p>{t.skillFlowIndependentBody}</p>
        </div>
      </div>
      {configuration.positions.map((position) => {
        const flows = configuration.skillFlows.filter(
          (flow) => flow.positionId === position.id,
        );
        const availableSkillIds = position.skillIds;
        return (
          <details className="create-panel" key={position.id}>
            <summary>
              {position.name} ·{" "}
              {flows.filter((flow) => flow.status === "active").length}
            </summary>
            <div className="skill-flow-list">
              {flows.map((flow) =>
                flow.status === "active" ? (
                  <SkillFlowEditor
                    availableSkillIds={availableSkillIds}
                    busy={busy}
                    configuration={configuration}
                    flow={flow}
                    key={flow.id}
                    onArchive={onArchiveSkillFlow}
                    onSave={onSaveSkillFlow}
                    t={t}
                  />
                ) : null,
              )}
              <NewSkillFlowEditor
                availableSkillIds={availableSkillIds}
                busy={busy}
                configuration={configuration}
                onSave={onSaveSkillFlow}
                positionId={position.id}
                t={t}
              />
            </div>
          </details>
        );
      })}
    </section>
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
        label={t.skillFlowSkills}
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
        label={t.skillFlowSkills}
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
  label,
  ownerId,
  selectedSkillIds,
  setSelectedSkillIds,
}: {
  readonly availableSkills: SkillConfigurationView["activeSkills"];
  readonly label: string;
  readonly ownerId: string;
  readonly selectedSkillIds: readonly string[];
  readonly setSelectedSkillIds: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  return (
    <fieldset
      className="skill-flow-skill-list"
      data-skill-flow-skill-list={ownerId}
    >
      <legend>{label}</legend>
      {availableSkills.map((skill) => (
        <label
          className={
            selectedSkillIds.includes(skill.id)
              ? "skill-flow-skill-option selected"
              : "skill-flow-skill-option"
          }
          data-skill-flow-skill-option={`${ownerId}:${skill.id}`}
          key={skill.id}
        >
          <input
            checked={selectedSkillIds.includes(skill.id)}
            className="skill-flow-skill-checkbox"
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
          <span className="skill-flow-skill-copy">
            <strong>{skill.name}</strong>
            <small>{skill.description}</small>
          </span>
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

type PipelineDraftNode = DepartmentPipelineDraftGraph["nodes"][number];
type PipelineDraftEdge = DepartmentPipelineDraftGraph["edges"][number];
type PipelineNodePoint = { readonly x: number; readonly y: number };
type PipelineNodePositions = Readonly<Record<string, PipelineNodePoint>>;

const pipelineNodeWidth = 186;
const pipelineNodeHeight = 112;

const pipelineNodeTypeLabel = (t: Messages, type: string): string => {
  if (type === "start") return t.startNode;
  if (type === "ai-task") return t.aiTaskNode;
  if (type === "human-approval") return t.approvalNode;
  if (type === "condition") return t.conditionNode;
  if (type === "parallel") return t.parallelNode;
  if (type === "join") return t.joinNode;
  if (type === "complete") return t.completeNode;
  return type;
};

const pipelineNodeClass = (type: string): string =>
  `pipeline-canvas-node pipeline-canvas-node-${type}`;

const createPipelineAutoLayout = (
  graph: DepartmentPipelineDraftGraph,
): PipelineNodePositions => {
  const levels = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const node of graph.nodes) incoming.set(node.id, 0);
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const queue = graph.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  for (const nodeId of queue) levels.set(nodeId, 0);
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const current = queue[index];
    if (!current) break;
    const currentLevel = levels.get(current) ?? 0;
    for (const edge of graph.edges.filter(
      (candidate) => candidate.from === current,
    )) {
      const nextLevel = Math.max(levels.get(edge.to) ?? 0, currentLevel + 1);
      levels.set(edge.to, nextLevel);
      if (!queue.includes(edge.to)) queue.push(edge.to);
    }
  }
  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const level = levels.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node.id]);
  }
  const positions: Record<string, PipelineNodePoint> = {};
  for (const [level, nodeIds] of columns) {
    nodeIds.forEach((nodeId, row) => {
      positions[nodeId] = {
        x: 48 + level * 218,
        y: 72 + row * 146,
      };
    });
  }
  return positions;
};

const pipelineLayoutStorageKey = (departmentId: string): string =>
  `sandcastle:pipeline-layout:v2:${departmentId}`;

const loadPipelinePositions = (
  departmentId: string,
  graph: DepartmentPipelineDraftGraph,
): PipelineNodePositions => {
  const fallback = createPipelineAutoLayout(graph);
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(pipelineLayoutStorageKey(departmentId)) ??
        "null",
    ) as Record<string, PipelineNodePoint> | null;
    if (!stored) return fallback;
    return Object.fromEntries(
      graph.nodes.map((node) => [
        node.id,
        stored[node.id] ?? fallback[node.id] ?? { x: 72, y: 72 },
      ]),
    );
  } catch {
    return fallback;
  }
};

function PipelineVisualEditor({
  department,
  editor,
  graph,
  nodePositions,
  onAddNode,
  onConnectNodes,
  onRemoveEdge,
  onRemoveNode,
  onSelectEdge,
  onSelectNode,
  onUpdateEdge,
  onUpdateNode,
  selectedEdgeIndex,
  selectedNodeId,
  setNodePositions,
  skillConfiguration,
  t,
}: {
  readonly department: DepartmentInspect;
  readonly editor: DepartmentPipelineEditorView;
  readonly graph: DepartmentPipelineDraftGraph;
  readonly nodePositions: PipelineNodePositions;
  readonly onAddNode: (
    type?: (typeof pipelineNodeTypes)[number],
    point?: PipelineNodePoint,
  ) => void;
  readonly onConnectNodes: (from: string, to: string) => void;
  readonly onRemoveEdge: (edgeIndex: number) => void;
  readonly onRemoveNode: (nodeId: string) => void;
  readonly onSelectEdge: (edgeIndex: number | null) => void;
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly onUpdateEdge: (
    edgeIndex: number,
    update: (edge: PipelineDraftEdge) => PipelineDraftEdge,
  ) => void;
  readonly onUpdateNode: (
    nodeId: string,
    update: (node: PipelineDraftNode) => PipelineDraftNode,
  ) => void;
  readonly selectedEdgeIndex: number | null;
  readonly selectedNodeId: string | null;
  readonly setNodePositions: React.Dispatch<
    React.SetStateAction<PipelineNodePositions>
  >;
  readonly skillConfiguration: SkillConfigurationView;
  readonly t: Messages;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const interaction = useRef<
    | {
        kind: "node";
        nodeId: string;
        startX: number;
        startY: number;
        origin: PipelineNodePoint;
      }
    | {
        kind: "pan";
        startX: number;
        startY: number;
        origin: { x: number; y: number };
      }
    | null
  >(null);

  const nodePosition = (node: PipelineDraftNode): PipelineNodePoint =>
    nodePositions[node.id] ?? { x: 72, y: 72 };
  const contentSize = {
    width: Math.max(
      920,
      ...graph.nodes.map(
        (node) => nodePosition(node).x + pipelineNodeWidth + 120,
      ),
    ),
    height: Math.max(
      620,
      ...graph.nodes.map(
        (node) => nodePosition(node).y + pipelineNodeHeight + 120,
      ),
    ),
  };
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge =
    selectedEdgeIndex === null ? undefined : graph.edges[selectedEdgeIndex];
  const visibleSkillFlows = selectedNode
    ? skillConfiguration.skillFlows.filter(
        (flow) =>
          flow.status === "active" &&
          flow.positionId === selectedNode.positionId,
      )
    : [];

  const updateSelectedNodeType = (type: string): void => {
    if (!selectedNode) return;
    onUpdateNode(selectedNode.id, (current) => ({
      ...current,
      type: type as (typeof pipelineNodeTypes)[number],
      ...(type === "condition"
        ? {
            condition: current.condition ?? {
              leftReference: "",
              operator: "exists" as const,
              branches: [
                { id: "match", label: "Match", kind: "match" as const },
                {
                  id: "default",
                  label: "Default",
                  kind: "default" as const,
                },
              ],
            },
          }
        : { condition: undefined }),
      ...(["ai-task", "human-approval"].includes(type)
        ? {}
        : {
            positionId: undefined,
            skillFlowId: undefined,
            instructions: undefined,
            executionProfileId: undefined,
          }),
    }));
  };
  const handleCanvasPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const target = event.target as HTMLElement;
    if (
      target.closest("[data-pipeline-canvas-node]") ||
      target.closest("[data-pipeline-edge]")
    ) {
      return;
    }
    interaction.current = {
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      origin: pan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleCanvasPointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const current = interaction.current;
    if (!current) return;
    if (current.kind === "node") {
      const dx = (event.clientX - current.startX) / zoom;
      const dy = (event.clientY - current.startY) / zoom;
      setNodePositions((positions) => ({
        ...positions,
        [current.nodeId]: {
          x: Math.max(24, current.origin.x + dx),
          y: Math.max(24, current.origin.y + dy),
        },
      }));
      return;
    }
    setPan({
      x: current.origin.x + event.clientX - current.startX,
      y: current.origin.y + event.clientY - current.startY,
    });
  };
  const handleCanvasPointerUp = (): void => {
    interaction.current = null;
  };
  const handleNodePointerDown = (
    event: React.PointerEvent<HTMLElement>,
    node: PipelineDraftNode,
  ): void => {
    if (tool !== "select") return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-pipeline-port]")) return;
    onSelectNode(node.id);
    interaction.current = {
      kind: "node",
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: nodePosition(node),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/x-sandcastle-node");
    if (
      !pipelineNodeTypes.includes(type as (typeof pipelineNodeTypes)[number])
    ) {
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    onAddNode(type as (typeof pipelineNodeTypes)[number], {
      x: Math.max(
        24,
        (event.clientX - rect.left - pan.x) / zoom - pipelineNodeWidth / 2,
      ),
      y: Math.max(
        24,
        (event.clientY - rect.top - pan.y) / zoom - pipelineNodeHeight / 2,
      ),
    });
  };
  const autoLayout = (): void => {
    setNodePositions(createPipelineAutoLayout(graph));
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };

  return (
    <section className="pipeline-visual-editor" data-pipeline-canvas>
      <aside className="pipeline-node-library" data-pipeline-node-library>
        <div className="pipeline-panel-title">{t.nodeLibrary}</div>
        {pipelineNodeTypes.map((type) => (
          <button
            className={`pipeline-library-item pipeline-library-item-${type}`}
            draggable
            key={type}
            onClick={() => onAddNode(type)}
            onDragStart={(event) =>
              event.dataTransfer.setData("application/x-sandcastle-node", type)
            }
            type="button"
          >
            <Icon name={pipelineIconForType(type)} size={24} />
            {pipelineNodeTypeLabel(t, type)}
          </button>
        ))}
        <p className="pipeline-canvas-hint">{t.connectNodesHint}</p>
      </aside>

      <div
        className={`pipeline-canvas pipeline-canvas-tool-${tool}`}
        data-pipeline-canvas-surface
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        ref={canvasRef}
      >
        <div className="pipeline-canvas-toolbar">
          <div className="pipeline-toolbar-group">
            <button
              className={tool === "select" ? "active" : ""}
              onClick={() => setTool("select")}
              type="button"
            >
              {t.selectTool}
            </button>
            <button
              className={tool === "pan" ? "active" : ""}
              onClick={() => setTool("pan")}
              type="button"
            >
              {t.panTool}
            </button>
            <IconButton
              icon="zoom-out"
              label={t.zoomOut}
              onClick={() =>
                setZoom((current) => Math.max(0.55, current - 0.1))
              }
            />
            <IconButton
              icon="zoom-in"
              label={t.zoomIn}
              onClick={() => setZoom((current) => Math.min(1.5, current + 0.1))}
            />
          </div>
          <div className="pipeline-toolbar-group">
            <button onClick={autoLayout} type="button">
              {t.autoLayout}
            </button>
            <span>{Math.round(zoom * 100)}%</span>
          </div>
        </div>
        <div
          className="pipeline-canvas-content"
          style={{
            height: contentSize.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            width: contentSize.width,
          }}
        >
          <svg
            aria-hidden="true"
            className="pipeline-canvas-edges"
            height={contentSize.height}
            width={contentSize.width}
          >
            <defs>
              <marker
                id="pipeline-arrow"
                markerHeight="8"
                markerWidth="8"
                orient="auto"
                refX="7"
                refY="4"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            {graph.edges.map((edge, index) => {
              const from = nodePositions[edge.from] ?? { x: 72, y: 72 };
              const to = nodePositions[edge.to] ?? { x: 72, y: 72 };
              const startX = from.x + pipelineNodeWidth;
              const startY = from.y + pipelineNodeHeight / 2;
              const endX = to.x;
              const endY = to.y + pipelineNodeHeight / 2;
              const curve = Math.max(60, Math.abs(endX - startX) / 2);
              const path = `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
              return (
                <g key={`${edge.from}:${edge.to}:${index}`}>
                  <path
                    className={`pipeline-canvas-edge${selectedEdgeIndex === index ? " selected" : ""}`}
                    d={path}
                    data-pipeline-edge={index}
                    markerEnd="url(#pipeline-arrow)"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectEdge(index);
                    }}
                  />
                </g>
              );
            })}
          </svg>
          {graph.nodes.map((node) => {
            const point = nodePosition(node);
            const position = editor.positions.find(
              (candidate) => candidate.id === node.positionId,
            );
            const flow = skillConfiguration.skillFlows.find(
              (candidate) => candidate.id === node.skillFlowId,
            );
            return (
              <article
                className={`${pipelineNodeClass(node.type)}${selectedNodeId === node.id ? " selected" : ""}`}
                data-pipeline-canvas-node={node.id}
                key={node.id}
                onClick={() => onSelectNode(node.id)}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
                style={{ left: point.x, top: point.y }}
              >
                <button
                  aria-label={`${t.toNode}: ${node.name}`}
                  className={`pipeline-port pipeline-port-input${connectFrom ? " connectable" : ""}`}
                  data-pipeline-port="input"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (connectFrom) {
                      onConnectNodes(connectFrom, node.id);
                      setConnectFrom(null);
                    }
                  }}
                  type="button"
                />
                <div className="pipeline-node-type-label">
                  <Icon name={pipelineIconForType(node.type)} size={20} />
                  {pipelineNodeTypeLabel(t, node.type)}
                </div>
                <strong>{node.name}</strong>
                {position ? (
                  <span className="pipeline-node-person">{position.name}</span>
                ) : null}
                {flow ? (
                  <span className="pipeline-node-chip">{flow.name}</span>
                ) : null}
                {node.inputContractRefs?.length ||
                node.outputContractRefs?.length ? (
                  <span className="pipeline-node-contracts">
                    ↓ {node.inputContractRefs?.length ?? 0} · ↑{" "}
                    {node.outputContractRefs?.length ?? 0}
                  </span>
                ) : null}
                <button
                  aria-label={`${t.fromNode}: ${node.name}`}
                  className={`pipeline-port pipeline-port-output${connectFrom === node.id ? " active" : ""}`}
                  data-pipeline-port="output"
                  onClick={(event) => {
                    event.stopPropagation();
                    setConnectFrom(node.id);
                    onSelectNode(node.id);
                  }}
                  type="button"
                />
              </article>
            );
          })}
        </div>
      </div>

      <aside className="pipeline-inspector" data-pipeline-inspector>
        <div className="pipeline-panel-title">{t.nodeInspector}</div>
        {selectedNode ? (
          <div className="pipeline-inspector-body">
            <h3>{selectedNode.name}</h3>
            <label>
              {t.name}
              <input
                onChange={(event) =>
                  onUpdateNode(selectedNode.id, (node) => ({
                    ...node,
                    name: event.target.value,
                  }))
                }
                value={selectedNode.name}
              />
            </label>
            <label>
              {t.nodeType}
              <select
                onChange={(event) => updateSelectedNodeType(event.target.value)}
                value={selectedNode.type}
              >
                {pipelineNodeTypes.map((type) => (
                  <option key={type} value={type}>
                    {pipelineNodeTypeLabel(t, type)}
                  </option>
                ))}
              </select>
            </label>
            {selectedNode.type === "ai-task" ||
            selectedNode.type === "human-approval" ? (
              <label>
                {t.position}
                <select
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, (node) => ({
                      ...node,
                      positionId: event.target.value || undefined,
                      skillFlowId: undefined,
                    }))
                  }
                  value={selectedNode.positionId ?? ""}
                >
                  <option value="">{t.none}</option>
                  {editor.positions.map((position) => (
                    <option key={position.id} value={position.id}>
                      {position.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedNode.type === "ai-task" ? (
              <>
                <label>
                  {t.skillFlow}
                  <select
                    data-pipeline-inspector-field="skill-flow"
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        skillFlowId: event.target.value || undefined,
                      }))
                    }
                    value={selectedNode.skillFlowId ?? ""}
                  >
                    <option value="">{t.none}</option>
                    {visibleSkillFlows.map((flow) => (
                      <option key={flow.id} value={flow.id}>
                        {flow.name}
                      </option>
                    ))}
                  </select>
                </label>
                <details className="pipeline-inspector-section" open>
                  <summary>{t.advancedSettings}</summary>
                  <label>
                    {t.skillFlowInstructions}
                    <textarea
                      data-pipeline-inspector-field="instructions"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          instructions: event.target.value,
                        }))
                      }
                      rows={4}
                      value={selectedNode.instructions ?? ""}
                    />
                  </label>
                  <label>
                    {t.executionProfiles}
                    <select
                      data-pipeline-inspector-field="execution-profile"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          executionProfileId: event.target.value || undefined,
                        }))
                      }
                      value={selectedNode.executionProfileId ?? ""}
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
                  </label>
                  <label>
                    {t.inputArtifactContracts}
                    <input
                      data-pipeline-inspector-field="input-contracts"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          inputContractRefs: event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        }))
                      }
                      value={(selectedNode.inputContractRefs ?? []).join(", ")}
                    />
                  </label>
                  <label>
                    {t.outputArtifactContracts}
                    <input
                      data-pipeline-inspector-field="output-contracts"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          outputContractRefs: event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        }))
                      }
                      value={(selectedNode.outputContractRefs ?? []).join(", ")}
                    />
                  </label>
                  <div className="pipeline-inspector-pair">
                    <label>
                      {t.timeoutSeconds}
                      <input
                        data-pipeline-inspector-field="timeout"
                        min={1}
                        onChange={(event) =>
                          onUpdateNode(selectedNode.id, (node) => ({
                            ...node,
                            timeoutSeconds: event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          }))
                        }
                        type="number"
                        value={selectedNode.timeoutSeconds ?? ""}
                      />
                    </label>
                    <label>
                      {t.retryMaxAttempts}
                      <input
                        data-pipeline-inspector-field="retry"
                        min={0}
                        onChange={(event) =>
                          onUpdateNode(selectedNode.id, (node) => ({
                            ...node,
                            retryMaxAttempts: event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          }))
                        }
                        type="number"
                        value={selectedNode.retryMaxAttempts ?? ""}
                      />
                    </label>
                  </div>
                  <div className="pipeline-inspector-pair">
                    <label>
                      {t.maxIterations}
                      <input
                        data-pipeline-inspector-field="max-iterations"
                        min={1}
                        onChange={(event) =>
                          onUpdateNode(selectedNode.id, (node) => ({
                            ...node,
                            maxIterations: event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          }))
                        }
                        type="number"
                        value={selectedNode.maxIterations ?? ""}
                      />
                    </label>
                    <label>
                      {t.maxTokens}
                      <input
                        data-pipeline-inspector-field="max-tokens"
                        min={1}
                        onChange={(event) =>
                          onUpdateNode(selectedNode.id, (node) => ({
                            ...node,
                            maxTokens: event.target.value
                              ? Number(event.target.value)
                              : null,
                          }))
                        }
                        type="number"
                        value={selectedNode.maxTokens ?? ""}
                      />
                    </label>
                  </div>
                </details>
              </>
            ) : null}
            {selectedNode.type === "human-approval" ? (
              <details className="pipeline-inspector-section" open>
                <summary>{t.advancedSettings}</summary>
                <label>
                  {t.approvalTitle}
                  <input
                    data-pipeline-inspector-field="approval-title"
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        approvalTitle: event.target.value,
                      }))
                    }
                    value={selectedNode.approvalTitle ?? ""}
                  />
                </label>
                <label>
                  {t.inputArtifactContracts}
                  <input
                    data-pipeline-inspector-field="approval-evidence"
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        inputContractRefs: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      }))
                    }
                    value={(selectedNode.inputContractRefs ?? []).join(", ")}
                  />
                </label>
                <label>
                  {t.permissionPolicy}
                  <select
                    data-pipeline-inspector-field="approval-policy"
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        approvalPolicy: event.target.value
                          ? (event.target.value as "any" | "all" | "named")
                          : undefined,
                      }))
                    }
                    value={selectedNode.approvalPolicy ?? ""}
                  >
                    <option value="">{t.none}</option>
                    <option value="any">any</option>
                    <option value="all">all</option>
                    <option value="named">named</option>
                  </select>
                </label>
                <label>
                  {t.approverReference}
                  <input
                    data-pipeline-inspector-field="approver"
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        approverReference: event.target.value,
                      }))
                    }
                    value={selectedNode.approverReference ?? ""}
                  />
                </label>
              </details>
            ) : null}
            {selectedNode.type === "condition" && selectedNode.condition ? (
              <>
                <label>
                  Left reference
                  <input
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        condition: node.condition
                          ? {
                              ...node.condition,
                              leftReference: event.target.value,
                            }
                          : undefined,
                      }))
                    }
                    value={selectedNode.condition.leftReference}
                  />
                </label>
                <label>
                  Operator
                  <select
                    onChange={(event) =>
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        condition: node.condition
                          ? {
                              ...node.condition,
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
                    value={selectedNode.condition.operator}
                  >
                    <option value="equals">equals</option>
                    <option value="not-equals">not-equals</option>
                    <option value="exists">exists</option>
                    <option value="not-exists">not-exists</option>
                    <option value="in">in</option>
                  </select>
                </label>
                {selectedNode.condition.branches.map((branch, branchIndex) => (
                  <div
                    className="pipeline-inspector-branch"
                    key={`${branch.id}:${branchIndex}`}
                  >
                    <input
                      aria-label="Condition branch ID"
                      data-pipeline-inspector-field="condition-branch-id"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          condition: node.condition
                            ? {
                                ...node.condition,
                                branches: node.condition.branches.map(
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
                      data-pipeline-inspector-field="condition-branch-label"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          condition: node.condition
                            ? {
                                ...node.condition,
                                branches: node.condition.branches.map(
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
                    <select
                      aria-label="Condition branch kind"
                      data-pipeline-inspector-field="condition-branch-kind"
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, (node) => ({
                          ...node,
                          condition: node.condition
                            ? {
                                ...node.condition,
                                branches: node.condition.branches.map(
                                  (candidate, candidateIndex) =>
                                    candidateIndex === branchIndex
                                      ? {
                                          ...candidate,
                                          kind: event.target.value as
                                            | "match"
                                            | "no-match"
                                            | "default",
                                        }
                                      : candidate,
                                ),
                              }
                            : undefined,
                        }))
                      }
                      value={branch.kind}
                    >
                      <option value="match">match</option>
                      <option value="no-match">no-match</option>
                      <option value="default">default</option>
                    </select>
                  </div>
                ))}
              </>
            ) : null}
            <button
              className="danger-button"
              onClick={() => onRemoveNode(selectedNode.id)}
              type="button"
            >
              {t.removeNode}
            </button>
          </div>
        ) : selectedEdge ? (
          <div className="pipeline-inspector-body">
            <h3>{t.pipelineEdges}</h3>
            <label>
              {t.fromNode}
              <select
                onChange={(event) =>
                  onUpdateEdge(selectedEdgeIndex ?? 0, (edge) => ({
                    ...edge,
                    from: event.target.value,
                  }))
                }
                value={selectedEdge.from}
              >
                {graph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.toNode}
              <select
                onChange={(event) =>
                  onUpdateEdge(selectedEdgeIndex ?? 0, (edge) => ({
                    ...edge,
                    to: event.target.value,
                  }))
                }
                value={selectedEdge.to}
              >
                {graph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            {graph.nodes.find((node) => node.id === selectedEdge.from)?.type ===
            "condition" ? (
              <label>
                Branch
                <select
                  data-pipeline-inspector-field="edge-branch"
                  onChange={(event) =>
                    onUpdateEdge(selectedEdgeIndex ?? 0, (edge) => ({
                      ...edge,
                      branchId: event.target.value || undefined,
                    }))
                  }
                  value={selectedEdge.branchId ?? ""}
                >
                  <option value="">{t.none}</option>
                  {graph.nodes
                    .find((node) => node.id === selectedEdge.from)
                    ?.condition?.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.label}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <button
              className="danger-button"
              onClick={() => onRemoveEdge(selectedEdgeIndex ?? 0)}
              type="button"
            >
              {t.removeEdge}
            </button>
          </div>
        ) : (
          <p className="pipeline-inspector-empty">{t.noNodeSelected}</p>
        )}
      </aside>
    </section>
  );
}

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
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    editor.draft.graph.nodes[0]?.id ?? null,
  );
  const [selectedEdgeIndex, setSelectedEdgeIndex] = useState<number | null>(
    null,
  );
  const [nodePositions, setNodePositions] = useState<PipelineNodePositions>(
    () => loadPipelinePositions(editor.department.id, editor.draft.graph),
  );
  const graphRef = useRef(graph);
  const dirtyRef = useRef(false);
  const editSequenceRef = useRef(0);
  const serverRevisionRef = useRef(editor.draft.revision);
  const departmentIdRef = useRef(editor.department.id);
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const saveDraftRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    const departmentChanged = departmentIdRef.current !== editor.department.id;
    departmentIdRef.current = editor.department.id;
    serverRevisionRef.current = editor.draft.revision;
    setValidation(editor.validation);
    if (departmentChanged || !dirtyRef.current) {
      graphRef.current = editor.draft.graph;
      dirtyRef.current = false;
      setGraph(editor.draft.graph);
      setDirty(false);
      setDraftSaveError(null);
      setSelectedNodeId((current) =>
        current && editor.draft.graph.nodes.some((node) => node.id === current)
          ? current
          : (editor.draft.graph.nodes[0]?.id ?? null),
      );
      setSelectedEdgeIndex(null);
      setNodePositions((current) => {
        const fallback = createPipelineAutoLayout(editor.draft.graph);
        return Object.fromEntries(
          editor.draft.graph.nodes.map((node) => [
            node.id,
            current[node.id] ?? fallback[node.id] ?? { x: 72, y: 72 },
          ]),
        );
      });
    }
  }, [editor.department.id, editor.draft.revision, editor.published?.id]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        pipelineLayoutStorageKey(editor.department.id),
        JSON.stringify(nodePositions),
      );
    } catch {
      // Layout persistence is a renderer convenience; graph editing still works.
    }
  }, [editor.department.id, nodePositions]);

  const replaceGraph = (nextGraph: DepartmentPipelineDraftGraph): void => {
    graphRef.current = nextGraph;
    dirtyRef.current = true;
    editSequenceRef.current += 1;
    setGraph(nextGraph);
    setDirty(true);
    setDraftSaveError(null);
  };

  const saveCurrentDraft = async (): Promise<void> => {
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return;
    }
    if (!dirtyRef.current) return;

    const graphSnapshot = graphRef.current;
    const savedEditSequence = editSequenceRef.current;
    saveInFlightRef.current = true;
    setSaving(true);
    setDraftSaveError(null);
    try {
      const nextEditor = await onSave({
        departmentId: editor.department.id,
        expectedRevision: serverRevisionRef.current,
        graph: graphSnapshot,
      });
      serverRevisionRef.current = nextEditor.draft.revision;
      setValidation(nextEditor.validation);
      if (editSequenceRef.current === savedEditSequence) {
        dirtyRef.current = false;
        graphRef.current = nextEditor.draft.graph;
        setGraph(nextEditor.draft.graph);
        setDirty(false);
      } else {
        saveAgainRef.current = true;
      }
    } catch (nextError) {
      setDraftSaveError(errorMessage(nextError));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
      if (saveAgainRef.current && dirtyRef.current) {
        saveAgainRef.current = false;
        window.setTimeout(() => void saveDraftRef.current(), 0);
      }
    }
  };
  saveDraftRef.current = saveCurrentDraft;
  useEffect(() => {
    if (!dirty) return;
    const timeout = window.setTimeout(() => void saveDraftRef.current(), 700);
    return () => window.clearTimeout(timeout);
  }, [dirty, graph]);
  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);
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
  const addNode = (
    type: (typeof pipelineNodeTypes)[number] = "ai-task",
    point?: PipelineNodePoint,
  ): void => {
    let index = graph.nodes.length + 1;
    while (graph.nodes.some((node) => node.id === `node-${index}`)) index += 1;
    const nodeId = `node-${index}`;
    replaceGraph({
      ...graph,
      nodes: [...graph.nodes, { id: nodeId, type, name: `Node ${index}` }],
    });
    setNodePositions((current) => ({
      ...current,
      [nodeId]: point ?? {
        x: 48 + (graph.nodes.length % 4) * 218,
        y: 72 + Math.floor(graph.nodes.length / 4) * 146,
      },
    }));
    setSelectedNodeId(nodeId);
    setSelectedEdgeIndex(null);
  };
  const removeNode = (nodeId: string): void => {
    replaceGraph({
      nodes: graph.nodes.filter((candidate) => candidate.id !== nodeId),
      edges: graph.edges.filter(
        (edge) => edge.from !== nodeId && edge.to !== nodeId,
      ),
    });
    setNodePositions((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
    setSelectedNodeId((current) => (current === nodeId ? null : current));
    setSelectedEdgeIndex(null);
  };
  const connectNodes = (from: string, to: string): void => {
    if (
      from === to ||
      graph.edges.some((edge) => edge.from === from && edge.to === to)
    ) {
      return;
    }
    replaceGraph({ ...graph, edges: [...graph.edges, { from, to }] });
    setSelectedNodeId(null);
    setSelectedEdgeIndex(graph.edges.length);
  };
  const updateEdge = (
    edgeIndex: number,
    update: (edge: PipelineDraftEdge) => PipelineDraftEdge,
  ): void => {
    replaceGraph({
      ...graph,
      edges: graph.edges.map((edge, index) =>
        index === edgeIndex ? update(edge) : edge,
      ),
    });
  };
  const removeEdge = (edgeIndex: number): void => {
    replaceGraph({
      ...graph,
      edges: graph.edges.filter((_edge, index) => index !== edgeIndex),
    });
    setSelectedEdgeIndex(null);
  };

  const editorView = (
    <section
      className={`create-panel pipeline-panel pipeline-editor${fullscreen ? " pipeline-editor-fullscreen" : ""}`}
      data-department-panel="pipeline"
      data-pipeline-draft-revision={editor.draft.revision}
      data-pipeline-fullscreen={fullscreen ? "true" : "false"}
      data-pipeline-published-version={editor.published?.version}
      data-pipeline-state={editor.published ? "published" : "draft-only"}
    >
      <div className="stage-heading pipeline-editor-heading">
        <div>
          <h2>{t.pipelineTab}</h2>
          <p>
            {t.draftBasedOn}{" "}
            {editor.published ? `v${editor.published.version}` : t.none}
            {` · ${t.draftRevision} ${serverRevisionRef.current}`}
            {saving
              ? ` · ${t.savingDraft}`
              : dirty
                ? ` · ${t.unsavedChanges}`
                : ` · ${t.draftSaved}`}
          </p>
        </div>
        <div className="action-bar">
          <button
            aria-pressed={fullscreen}
            data-pipeline-fullscreen-toggle
            onClick={() => setFullscreen((current) => !current)}
            type="button"
          >
            {fullscreen ? t.exitPipelineFullscreen : t.enterPipelineFullscreen}
          </button>
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
            disabled={busy || saving || !dirty}
            onClick={() => void saveDraftRef.current()}
            type="button"
          >
            {saving ? t.savingDraft : t.saveDraft}
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

      {draftSaveError ? (
        <div className="warn" data-pipeline-save-error>
          {t.draftSaveFailed}: {draftSaveError}
        </div>
      ) : null}

      {!editor.published ? (
        <div className="pipeline-unpublished-note">
          <strong>{t.noPublishedPipeline}</strong>
          <span>{t.noPublishedPipelineBody}</span>
        </div>
      ) : null}

      <PipelineVisualEditor
        department={department}
        editor={editor}
        graph={graph}
        nodePositions={nodePositions}
        onAddNode={addNode}
        onConnectNodes={connectNodes}
        onRemoveEdge={removeEdge}
        onRemoveNode={removeNode}
        onSelectEdge={setSelectedEdgeIndex}
        onSelectNode={(nodeId) => {
          setSelectedNodeId(nodeId);
          setSelectedEdgeIndex(null);
        }}
        onUpdateEdge={updateEdge}
        onUpdateNode={updateNode}
        selectedEdgeIndex={selectedEdgeIndex}
        selectedNodeId={selectedNodeId}
        setNodePositions={setNodePositions}
        skillConfiguration={skillConfiguration}
        t={t}
      />

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
  return fullscreen && typeof document !== "undefined"
    ? createPortal(editorView, document.body)
    : editorView;
}

const pipelineValidationMessage = (t: Messages, code: string): string => {
  const key = `validation${code
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}` as keyof Messages;
  return t[key] ?? code;
};

export function PositionDrawerEditor({
  departmentId,
  position,
  configuration,
  agentCatalog,
  t,
  busy,
  onArchive,
  onClose,
  onSave,
}: {
  readonly departmentId: string;
  readonly position: DepartmentInspect["positions"][number];
  readonly configuration: SkillConfigurationView;
  readonly agentCatalog: AgentCatalogView;
  readonly t: Messages;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onArchive: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
  readonly onSave: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly expectedSkillRevision: number;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
    readonly aiMemberStatus: "active" | "inactive";
    readonly defaultAgentId: string;
    readonly skillIds: readonly string[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState(position.name);
  const [responsibility, setResponsibility] = useState(position.responsibility);
  const [displayName, setDisplayName] = useState(position.aiMember.displayName);
  const [profile, setProfile] = useState(position.aiMember.profile);
  const [status, setStatus] = useState(position.aiMember.status);
  const [defaultAgentId, setDefaultAgentId] = useState(position.defaultAgentId);
  const [skillIds, setSkillIds] = useState<string[]>(
    () =>
      configuration.positions
        .find((candidate) => candidate.id === position.id)
        ?.skillIds.slice() ?? [],
  );
  const [search, setSearch] = useState("");
  const [closePrompt, setClosePrompt] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setName(position.name);
    setResponsibility(position.responsibility);
    setDisplayName(position.aiMember.displayName);
    setProfile(position.aiMember.profile);
    setStatus(position.aiMember.status);
    setDefaultAgentId(position.defaultAgentId);
    setSkillIds(
      configuration.positions
        .find((candidate) => candidate.id === position.id)
        ?.skillIds.slice() ?? [],
    );
    setDirty(false);
  }, [configuration, position]);
  const visibleSkills = configuration.activeSkills.filter((skill) =>
    fuzzyMatch(search, `${skill.name} ${skill.description}`),
  );
  const save = () => {
    void onSave({
      departmentId,
      positionId: position.id,
      expectedRevision: position.revision,
      expectedSkillRevision: configuration.revision,
      name: name.trim(),
      responsibility: responsibility.trim(),
      aiMemberDisplayName: displayName.trim(),
      aiMemberProfile: profile,
      aiMemberResponsibilityMetadata: position.aiMember.responsibilityMetadata,
      aiMemberStatus: status,
      defaultAgentId,
      skillIds,
    }).then(() => setDirty(false));
  };
  const requestClose = () => (dirty ? setClosePrompt(true) : onClose());
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dirty, onClose]);
  return (
    <aside
      className="position-drawer"
      data-position-drawer={position.id}
      data-position-drawer-layer
    >
      <button
        aria-label={t.closePositionEditor}
        className="position-drawer-backdrop"
        data-position-drawer-backdrop
        type="button"
        onClick={requestClose}
      />
      <div className="drawer-heading">
        <div>
          <span className="eyebrow">{t.editPosition}</span>
          <h2>{positionName(t, position)}</h2>
        </div>
        <button
          aria-label={t.closePositionEditor}
          className="drawer-close-button"
          data-close-position-drawer
          title={t.closePositionEditor}
          type="button"
          onClick={requestClose}
        >
          <span className="drawer-close-icon" data-drawer-close-icon>
            <Icon name="close" size={20} />
          </span>
        </button>
      </div>
      <section className="drawer-section">
        <h3>{t.name}</h3>
        <label>
          <span>{t.name}</span>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          <span>{t.responsibility}</span>
          <textarea
            value={responsibility}
            onChange={(event) => {
              setResponsibility(event.target.value);
              setDirty(true);
            }}
            rows={3}
          />
        </label>
        <label>
          <span>{t.aiMemberDisplayName}</span>
          <input
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          <span>{t.aiMemberProfile}</span>
          <textarea
            value={profile}
            onChange={(event) => {
              setProfile(event.target.value);
              setDirty(true);
            }}
            rows={2}
          />
        </label>
        <label>
          <span>{t.status}</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as "active" | "inactive");
              setDirty(true);
            }}
          >
            <option value="active">{t.activeStatus}</option>
            <option value="inactive">{t.inactiveStatus}</option>
          </select>
        </label>
      </section>
      <section className="drawer-section">
        <h3>{t.defaultAgent}</h3>
        <p className="muted">{t.inheritedAgent}</p>
        <select
          value={defaultAgentId}
          onChange={(event) => {
            setDefaultAgentId(event.target.value);
            setDirty(true);
          }}
        >
          {agentCatalog.agents.map((agent) => (
            <option
              disabled={agent.status !== "installed"}
              key={agent.id}
              value={agent.id}
            >
              {agent.name} · {agent.status}
            </option>
          ))}
        </select>
      </section>
      <section className="drawer-section">
        <div className="project-card-top">
          <h3>{t.positionSkills}</h3>
          <span className="pill">
            {skillIds.length} {t.selectedSkillsCount}
          </span>
        </div>
        <input
          placeholder={t.searchSkills}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="selected-tags">
          {skillIds.map((skillId) => (
            <button
              key={skillId}
              type="button"
              onClick={() => {
                setSkillIds((current) =>
                  current.filter((candidate) => candidate !== skillId),
                );
                setDirty(true);
              }}
            >
              {configuration.activeSkills.find((skill) => skill.id === skillId)
                ?.name ?? skillId}{" "}
              ×
            </button>
          ))}
        </div>
        <div className="skill-picker-list">
          {visibleSkills.map((skill) => (
            <label
              className={
                skillIds.includes(skill.id)
                  ? "skill-picker-option selected"
                  : "skill-picker-option"
              }
              data-position-skill-option={skill.id}
              key={skill.id}
            >
              <input
                className="skill-picker-checkbox"
                type="checkbox"
                checked={skillIds.includes(skill.id)}
                onChange={(event) => {
                  setSkillIds((current) =>
                    event.target.checked
                      ? [...current, skill.id]
                      : current.filter((candidate) => candidate !== skill.id),
                  );
                  setDirty(true);
                }}
              />
              <span className="skill-picker-option-copy">
                <strong className="skill-picker-option-name">
                  {skill.name}
                </strong>
                <small>{skill.description}</small>
              </span>
            </label>
          ))}
        </div>
      </section>
      <div className="drawer-actions">
        <button
          data-save-position-configuration
          disabled={busy}
          type="button"
          onClick={save}
        >
          {t.savePositionConfiguration}
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={requestClose}
        >
          {t.closePositionEditor}
        </button>
      </div>
      <section className="drawer-danger" data-position-danger-zone>
        <h3>{t.positionDangerZone}</h3>
        <button
          className="danger-button"
          disabled={busy || position.status === "archived"}
          type="button"
          onClick={() =>
            void onArchive({
              departmentId,
              positionId: position.id,
              expectedRevision: position.revision,
            })
          }
        >
          {t.archivePosition}
        </button>
      </section>
      {closePrompt ? (
        <div
          aria-modal="true"
          className="unsaved-dialog"
          data-unsaved-dialog
          role="dialog"
        >
          <p>{t.unsavedChangesPrompt}</p>
          <button type="button" onClick={save}>
            {t.saveChanges}
          </button>
          <button type="button" onClick={onClose}>
            {t.discardChanges}
          </button>
          <button type="button" onClick={() => setClosePrompt(false)}>
            {t.continueEditing}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

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

type InteractionMemberOption = {
  readonly id: string;
  readonly displayName: string;
  readonly positionName: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly defaultAgentId: string;
};

type InteractionRuntime = Pick<
  (typeof window.sandcastle)["runtime"],
  | "interactions"
  | "memoryCandidates"
  | "memoryEntries"
  | "legacyMemoryRecords"
  | "runs"
>;

type RunCollaborationRuntime = Pick<
  (typeof window.sandcastle)["runtime"],
  | "interactions"
  | "createInteractionSession"
  | "addInteractionParticipant"
  | "inspectInteraction"
>;

type ProjectConsultationRuntime = Pick<
  (typeof window.sandcastle)["runtime"],
  | "createInteractionSession"
  | "addInteractionParticipant"
  | "inspectInteraction"
>;

type InteractionPromptRuntime = Pick<
  (typeof window.sandcastle)["runtime"],
  "promptInteraction" | "inspectInteraction"
>;

export const RUN_PROGRESS_POLL_INTERVAL_MS = 2_500;

const pendingRunCollaborationSessions = new Map<
  string,
  Promise<InteractionView>
>();

export const loadInteractionProjectContext = async (
  runtime: InteractionRuntime,
  projectId: string,
): Promise<{
  readonly sessions: readonly InteractionView[];
  readonly memoryCandidates: readonly MemoryCandidateView[];
  readonly memoryEntries: readonly MemoryEntryView[];
  readonly legacyMemoryRecords: readonly LegacyMemoryRecordView[];
  readonly runs: readonly DepartmentRunView[];
}> => {
  const [sessions, memoryCandidates, memoryEntries, legacyMemoryRecords, runs] =
    await Promise.all([
      runtime.interactions(projectId),
      runtime.memoryCandidates(projectId),
      runtime.memoryEntries(projectId),
      runtime.legacyMemoryRecords(projectId),
      runtime.runs(projectId),
    ]);
  return {
    sessions,
    memoryCandidates,
    memoryEntries,
    legacyMemoryRecords,
    runs,
  };
};

export const startRunProgressPolling = (
  poll: () => void,
  timers: Pick<Window, "setInterval" | "clearInterval"> = window,
): (() => void) => {
  const timer = timers.setInterval(poll, RUN_PROGRESS_POLL_INTERVAL_MS);
  return () => timers.clearInterval(timer);
};

export const promptInteractionSession = async (
  runtime: InteractionPromptRuntime,
  interaction: InteractionView,
  content: string,
): Promise<InteractionView> => {
  const participant = interaction.participants.find(
    (candidate) => candidate.participantType === "human",
  );
  if (!participant || !content.trim()) return interaction;
  await runtime.promptInteraction({
    sessionId: interaction.session.id,
    participantId: participant.id,
    content: content.trim(),
  });
  return runtime.inspectInteraction(interaction.session.id);
};

const interactionRunsToDisplay = (
  runs: readonly DepartmentRunView[],
  selectedRunId?: string | null,
  currentRunId?: string | null,
): readonly DepartmentRunView[] => {
  const activeRuns = runs.filter((run) =>
    activeRunStatuses.has(run.run.status),
  );
  const selected = runs.find(
    (run) => run.run.id === (selectedRunId ?? currentRunId),
  );
  const visible =
    selected && !activeRunStatuses.has(selected.run.status)
      ? [...activeRuns, selected]
      : activeRuns;
  if (visible.length > 0) return visible;
  return runs[0] ? [runs[0]] : [];
};

export const createRunCollaborationSession = async (
  runtime: RunCollaborationRuntime,
  projectId: string,
  run: DepartmentRunView,
): Promise<InteractionView | null> => {
  const current = currentRunNode(run);
  const aiMemberId = current.position?.aiMember.id;
  const nodeRun = current.nodeRun;
  if (!nodeRun || !aiMemberId) return null;
  const key = `${projectId}:${run.run.id}:${nodeRun.id}`;
  const pending = pendingRunCollaborationSessions.get(key);
  if (pending) return pending;
  const creation = (async (): Promise<InteractionView> => {
    const existing = (await runtime.interactions(projectId)).find(
      (item) =>
        item.session.mode === "run-collaboration" &&
        item.session.runId === run.run.id &&
        item.session.nodeRunId === nodeRun.id,
    );
    if (existing) return existing;
    const session = await runtime.createInteractionSession({
      projectId,
      mode: "run-collaboration",
      runId: run.run.id,
      nodeRunId: nodeRun.id,
    });
    await runtime.addInteractionParticipant({
      sessionId: session.id,
      participantType: "human",
      participantRef: "user-local",
      role: "requester",
    });
    await runtime.addInteractionParticipant({
      sessionId: session.id,
      participantType: "ai-member",
      participantRef: aiMemberId,
      role: "current-node-agent",
    });
    return runtime.inspectInteraction(session.id);
  })();
  pendingRunCollaborationSessions.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingRunCollaborationSessions.get(key) === creation) {
      pendingRunCollaborationSessions.delete(key);
    }
  }
};

export const createProjectConsultationSession = async (
  runtime: ProjectConsultationRuntime,
  projectId: string,
  aiMemberId: string,
): Promise<InteractionView> => {
  const session = await runtime.createInteractionSession({
    projectId,
    mode: "consultation",
  });
  await runtime.addInteractionParticipant({
    sessionId: session.id,
    participantType: "human",
    participantRef: "user-local",
    role: "requester",
  });
  await runtime.addInteractionParticipant({
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: aiMemberId,
    role: "product-manager",
  });
  return runtime.inspectInteraction(session.id);
};

export function InteractionRunPanel({
  currentRunId,
  onCollaborate,
  onSelectRun,
  runs,
  selectedRunId,
  t,
}: {
  readonly currentRunId?: string | null;
  readonly onCollaborate: (run: DepartmentRunView) => void;
  readonly onSelectRun: (runId: string) => void;
  readonly runs: readonly DepartmentRunView[];
  readonly selectedRunId?: string | null;
  readonly t: Messages;
}) {
  const visibleRuns = interactionRunsToDisplay(
    runs,
    selectedRunId,
    currentRunId,
  );
  return (
    <section className="interaction-run-panel" data-interaction-active-run>
      <div className="interaction-panel-heading">
        <h2>{t.departmentRuns}</h2>
        <span>{visibleRuns.length}</span>
      </div>
      {visibleRuns.length === 0 ? (
        <div className="empty-state">{t.noDepartmentRuns}</div>
      ) : (
        <div className="interaction-run-list">
          {visibleRuns.map((run) => {
            const progress = runProgress(run);
            const current = currentRunNode(run);
            const canCollaborate =
              activeRunStatuses.has(run.run.status) &&
              current.position?.aiMember.status === "active";
            return (
              <article
                className={
                  selectedRunId === run.run.id || currentRunId === run.run.id
                    ? "interaction-run-card selected"
                    : "interaction-run-card"
                }
                data-interaction-run={run.run.id}
                key={run.run.id}
              >
                <div className="interaction-run-card-heading">
                  <strong>{run.snapshot.payload.department.name}</strong>
                  <span className="pill primary">
                    {statusName(t, run.run.status)}
                  </span>
                </div>
                <div className="interaction-run-meta">
                  <span>
                    {t.runSnapshot}: r{run.snapshot.revision}
                  </span>
                  <span>
                    {t.currentNode}:{" "}
                    {current.node ? pipelineNodeName(t, current.node) : t.none}
                  </span>
                  <span>
                    {t.currentAiMember}:{" "}
                    {current.position?.aiMember.displayName ?? t.none}
                  </span>
                  <span>
                    {t.interactionPosition}:{" "}
                    {current.position
                      ? positionName(t, current.position)
                      : t.none}
                  </span>
                </div>
                <div
                  className="interaction-run-progress"
                  data-interaction-run-progress
                >
                  <div className="interaction-run-progress-heading">
                    <span>{t.runProgress}</span>
                    <strong>
                      {progress.completed} / {progress.total} (
                      {progress.percentage}%)
                    </strong>
                  </div>
                  <progress
                    aria-label={t.runProgress}
                    max={Math.max(progress.total, 1)}
                    value={progress.completed}
                  />
                </div>
                <div
                  className="interaction-run-current-node"
                  data-interaction-current-node
                >
                  <span>{t.currentNode}</span>
                  <strong>
                    {current.node
                      ? pipelineNodeName(t, current.node)
                      : (current.nodeRun?.pipelineNodeId ?? t.none)}
                  </strong>
                </div>
                <ol className="interaction-run-timeline">
                  {run.nodes.map((nodeRun) => {
                    const node =
                      run.snapshot.payload.pipelineVersion.graph.nodes.find(
                        (candidate) => candidate.id === nodeRun.pipelineNodeId,
                      );
                    return (
                      <li
                        data-interaction-run-node={nodeRun.id}
                        data-interaction-run-node-status={nodeRun.status}
                        key={nodeRun.id}
                      >
                        <span>
                          {node
                            ? pipelineNodeName(t, node)
                            : nodeRun.pipelineNodeId}
                        </span>
                        <strong>{statusName(t, nodeRun.status)}</strong>
                      </li>
                    );
                  })}
                </ol>
                <button
                  className="primary-button"
                  data-interaction-collaborate={run.run.id}
                  disabled={!canCollaborate}
                  onClick={() => onCollaborate(run)}
                  type="button"
                >
                  {t.collaborateWithAgent}
                </button>
                <button
                  className="text-button"
                  data-interaction-select-run={run.run.id}
                  onClick={() => onSelectRun(run.run.id)}
                  type="button"
                >
                  {t.viewRunContext}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export const memoryCandidateDecisionLabel = (
  candidate: MemoryCandidateView,
  noneLabel: string,
): string =>
  candidate.decision
    ? `${candidate.decision.decision} · gate ${candidate.decision.qualityGateResultId} · entry ${candidate.decision.entryId ?? noneLabel}`
    : "";

export function CompanyInteractionPage({ t }: { readonly t: Messages }) {
  const [projects, setProjects] = useState<readonly CompanyProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [members, setMembers] = useState<readonly InteractionMemberOption[]>(
    [],
  );
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalogView | null>(
    null,
  );
  const [sessions, setSessions] = useState<readonly InteractionView[]>([]);
  const [runs, setRuns] = useState<readonly DepartmentRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<InteractionView | null>(null);
  const [message, setMessage] = useState("");
  const [permissionScope, setPermissionScope] = useState("");
  const [memoryCandidates, setMemoryCandidates] = useState<
    readonly MemoryCandidateView[]
  >([]);
  const [memoryEntries, setMemoryEntries] = useState<
    readonly MemoryEntryView[]
  >([]);
  const [legacyMemoryRecords, setLegacyMemoryRecords] = useState<
    readonly LegacyMemoryRecordView[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);

  const selectedMember = members.find(
    (member) => member.id === selectedMemberId,
  );
  const selectedProject = projects.find((project) => project.id === projectId);
  const participantById = new Map(
    selected?.participants.map((participant) => [
      participant.id,
      participant,
    ]) ?? [],
  );
  const selectedAiParticipant = selected?.participants.find(
    (participant) => participant.participantType === "ai-member",
  );

  const refresh = async (nextProjectId: string): Promise<void> => {
    if (!nextProjectId) return;
    const context = await loadInteractionProjectContext(
      window.sandcastle.runtime,
      nextProjectId,
    );
    setSessions(context.sessions);
    setMemoryCandidates(context.memoryCandidates);
    setMemoryEntries(context.memoryEntries);
    setLegacyMemoryRecords(context.legacyMemoryRecords);
    setRuns(context.runs);
    setSelectedRunId((current) =>
      current && context.runs.some((run) => run.run.id === current)
        ? current
        : (context.runs.find((run) => activeRunStatuses.has(run.run.status))
            ?.run.id ??
          context.runs[0]?.run.id ??
          null),
    );
    setSelected((current) =>
      current
        ? (context.sessions.find(
            (item) => item.session.id === current.session.id,
          ) ?? current)
        : (context.sessions[0] ?? null),
    );
  };

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      const [nextProjects, departments, agents] = await Promise.all([
        window.sandcastle.runtime.projects(),
        window.sandcastle.runtime.departments(),
        window.sandcastle.runtime.inspectAgentCatalog(),
      ]);
      const inspected = await Promise.all(
        departments
          .filter((department) => department.status === "active")
          .map((department) =>
            window.sandcastle.runtime.inspectDepartment(department.id),
          ),
      );
      const nextMembers: InteractionMemberOption[] = inspected.flatMap(
        (department) =>
          department.positions
            .filter(
              (position) =>
                position.status === "active" &&
                position.aiMember.status === "active",
            )
            .map((position) => ({
              id: position.aiMember.id,
              displayName:
                position.aiMember.displayName.trim() || position.name,
              positionName: position.name,
              departmentId: department.id,
              departmentName: department.name,
              defaultAgentId: position.defaultAgentId,
            })),
      );
      if (!active) return;
      setProjects(nextProjects);
      setAgentCatalog(agents);
      setMembers(nextMembers);
      const nextProjectId = nextProjects[0]?.id ?? "";
      setProjectId(nextProjectId);
      setSelectedMemberId(nextMembers[0]?.id ?? "");
      if (nextProjectId) await refresh(nextProjectId);
    };
    load().catch((nextError: unknown) => {
      if (active) setError(errorMessage(nextError));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const poll = (): void => {
      void refresh(projectId).catch((nextError: unknown) => {
        if (active) setError(errorMessage(nextError));
      });
    };
    const stopPolling = startRunProgressPolling(poll);
    return () => {
      active = false;
      stopPolling();
    };
  }, [projectId]);

  const selectSession = (item: InteractionView): void => {
    setNotice(null);
    setSelected(item);
    if (item.session.runId) setSelectedRunId(item.session.runId);
    setSelectedMemberId(
      item.participants.find(
        (participant) => participant.participantType === "ai-member",
      )?.participantRef ?? selectedMemberId,
    );
  };

  const createSession = async (): Promise<void> => {
    if (!projectId || !selectedMemberId) return;
    try {
      setNotice(null);
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
      await window.sandcastle.runtime.addInteractionParticipant({
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: selectedMemberId,
        role: "consulted-member",
      });
      const inspected = await window.sandcastle.runtime.inspectInteraction(
        session.id,
      );
      setSelected(inspected);
      await refresh(projectId);
      setSelected(inspected);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const createRunCollaboration = async (
    run: DepartmentRunView,
  ): Promise<void> => {
    const current = currentRunNode(run);
    const aiMemberId = current.position?.aiMember.id;
    if (!projectId || !current.nodeRun || !aiMemberId) return;
    try {
      const inspected = await createRunCollaborationSession(
        window.sandcastle.runtime,
        projectId,
        run,
      );
      if (!inspected) return;
      setSelectedMemberId(aiMemberId);
      setSelectedRunId(run.run.id);
      setSelected(inspected);
      await refresh(projectId);
      setSelected(inspected);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const sendMessage = async (): Promise<void> => {
    if (!selected || !message.trim()) return;
    try {
      setError(null);
      setSendingMessage(true);
      const inspected = await promptInteractionSession(
        window.sandcastle.runtime,
        selected,
        message,
      );
      setMessage("");
      setSelected(inspected);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSendingMessage(false);
    }
  };

  const closeSession = async (): Promise<void> => {
    if (!selected || selected.session.status === "closed") return;
    try {
      await window.sandcastle.runtime.closeInteractionSession(
        selected.session.id,
      );
      await refresh(selected.session.projectId);
      setSelected(null);
      setNotice(t.sessionClosedBody);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const requestPermission = async (): Promise<void> => {
    if (!selected || !permissionScope.trim()) return;
    try {
      await window.sandcastle.runtime.requestPermission({
        sessionId: selected.session.id,
        scope: permissionScope.trim(),
      });
      setPermissionScope("");
      setSelected(
        await window.sandcastle.runtime.inspectInteraction(selected.session.id),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const decidePermission = async (
    permissionId: string,
    decision: "approved" | "denied",
  ): Promise<void> => {
    if (!selected) return;
    try {
      await window.sandcastle.runtime.decidePermission({
        permissionId,
        expectedStatus: "pending",
        decision,
      });
      setSelected(
        await window.sandcastle.runtime.inspectInteraction(selected.session.id),
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const agentName =
    selectedMember && agentCatalog
      ? (agentCatalog.agents.find(
          (agent) => agent.id === selectedMember.defaultAgentId,
        )?.name ?? selectedMember.defaultAgentId)
      : (selectedMember?.defaultAgentId ?? t.none);
  const currentRunId =
    selectedRunId ??
    selected?.session.runId ??
    runs.find((run) => activeRunStatuses.has(run.run.status))?.run.id ??
    runs[0]?.run.id ??
    null;

  return (
    <section className="page" data-page="interaction">
      <div className="page-heading interaction-page-heading">
        <div>
          <span className="eyebrow">{t.agentInteraction}</span>
          <h1>{t.agentInteraction}</h1>
          <p>{t.agentInteractionBody}</p>
        </div>
        <button
          className="primary-button"
          disabled={!projectId || !selectedMemberId}
          onClick={() => void createSession()}
          type="button"
        >
          {t.createConsultation}
        </button>
      </div>
      {error ? <div className="warn">{error}</div> : null}
      {notice ? (
        <div className="interaction-notice" data-interaction-notice>
          {notice}
        </div>
      ) : null}
      <div className="interaction-workspace">
        <aside
          className="interaction-sidebar"
          data-interaction-member-directory
        >
          <div className="interaction-panel-heading">
            <h2>{t.interactionMembers}</h2>
            <span>{members.length}</span>
          </div>
          <label className="interaction-project-select">
            {t.interactionProjects}
            <select
              value={projectId}
              onChange={(event) => {
                const nextProjectId = event.target.value;
                setProjectId(nextProjectId);
                setSelected(null);
                setSelectedRunId(null);
                setNotice(null);
                void refresh(nextProjectId).catch((nextError: unknown) =>
                  setError(errorMessage(nextError)),
                );
              }}
            >
              <option value="">{t.none}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="interaction-member-list">
            {members.length === 0 ? (
              <div className="empty-state">{t.interactionNoMembers}</div>
            ) : (
              members.map((member) => (
                <button
                  className={
                    selectedMemberId === member.id
                      ? "interaction-member selected"
                      : "interaction-member"
                  }
                  data-interaction-member={member.id}
                  key={member.id}
                  onClick={() => setSelectedMemberId(member.id)}
                  type="button"
                >
                  <Icon
                    name={roleIconForPosition(member.positionName)}
                    size={24}
                  />
                  <span>
                    <strong>{member.displayName}</strong>
                    <span>{member.positionName}</span>
                    <small>{member.departmentName}</small>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="interaction-session-history">
            <div className="interaction-panel-heading">
              <h2>{t.interactionSessions}</h2>
              <span>{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <div className="empty-state">{t.interactionNoSessions}</div>
            ) : (
              sessions.map((item) => (
                <button
                  className={
                    selected?.session.id === item.session.id
                      ? "interaction-session selected"
                      : "interaction-session"
                  }
                  key={item.session.id}
                  onClick={() => selectSession(item)}
                  type="button"
                >
                  <strong>
                    {item.session.mode === "consultation"
                      ? t.interactionConsultation
                      : t.interactionRunCollaboration}
                  </strong>
                  <span>
                    {item.messages.length} {t.messages.toLowerCase()}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
        <main
          className="interaction-conversation"
          data-interaction-conversation
          data-interaction-session={selected?.session.id}
        >
          {selectedMember ? (
            <>
              <header className="interaction-conversation-header">
                <div>
                  <span className="eyebrow">
                    {selected?.session.mode === "run-collaboration"
                      ? t.interactionRunCollaboration
                      : t.interactionConsultation}
                  </span>
                  <h2>{selectedMember.displayName}</h2>
                  <p>
                    {selectedMember.positionName} ·{" "}
                    {selectedMember.departmentName}
                  </p>
                </div>
                {selected ? (
                  <button
                    className="secondary-button"
                    disabled={selected.session.status === "closed"}
                    onClick={() => void closeSession()}
                    type="button"
                  >
                    {interactionSessionCloseLabel(t, selected.session.status)}
                  </button>
                ) : null}
              </header>
              <div className="interaction-message-list">
                {selected?.messages.length ? (
                  selected.messages.map((item) => {
                    const participant = participantById.get(item.participantId);
                    const member = members.find(
                      (candidate) =>
                        candidate.id === participant?.participantRef,
                    );
                    const sender =
                      participant?.participantType === "ai-member"
                        ? (member?.displayName ?? selectedMember.displayName)
                        : participant?.participantType === "system"
                          ? t.interactionSystem
                          : t.interactionHuman;
                    return item.kind === "status" ? (
                      item.content.startsWith("Agent execution failed: ") ? (
                        <details
                          className="interaction-prompt-status failure"
                          data-interaction-prompt-status="failure"
                          data-session-message={item.id}
                          key={item.id}
                        >
                          <summary>
                            {interactionStatusLabel(t, item.content)}
                          </summary>
                          <pre>{item.content}</pre>
                        </details>
                      ) : (
                        <div
                          className="interaction-prompt-status"
                          data-interaction-prompt-status
                          data-session-message={item.id}
                          key={item.id}
                        >
                          <span>{interactionStatusLabel(t, item.content)}</span>
                        </div>
                      )
                    ) : (
                      <article
                        className={
                          "interaction-message interaction-message-" +
                          (participant?.participantType ?? "system")
                        }
                        data-session-message={item.id}
                        key={item.id}
                      >
                        <header>
                          <strong>{sender}</strong>
                          <span>{item.kind}</span>
                        </header>
                        <p>{item.content}</p>
                      </article>
                    );
                  })
                ) : (
                  <div className="interaction-empty-conversation">
                    <strong>{t.interactionNoMessages}</strong>
                    <span>
                      {selected
                        ? t.interactionMessagePlaceholder
                        : t.createConsultation}
                    </span>
                  </div>
                )}
              </div>
              {sendingMessage ? (
                <div
                  className="interaction-prompt-status active"
                  data-interaction-prompt-status="pending"
                >
                  <span>{t.interactionAgentWorking}</span>
                </div>
              ) : null}
              {selected?.session.status === "closed" ? (
                <div className="interaction-session-closed">
                  <strong>{t.sessionClosed}</strong>
                  <span>{t.sessionClosedBody}</span>
                </div>
              ) : (
                <div className="interaction-composer">
                  <textarea
                    disabled={!selected || sendingMessage}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder={t.interactionMessagePlaceholder}
                    value={message}
                  />
                  <button
                    className="primary-button"
                    disabled={
                      !selected || sendingMessage || message.trim() === ""
                    }
                    onClick={() => void sendMessage()}
                    type="button"
                  >
                    {t.sendMessage}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="interaction-empty-conversation">
              <strong>{t.interactionSelectMember}</strong>
            </div>
          )}
        </main>
        <aside className="interaction-context" data-interaction-context>
          <div className="interaction-panel-heading">
            <h2>{t.interactionContext}</h2>
          </div>
          <dl className="interaction-context-list">
            <div className="interaction-context-item">
              <dt>{t.interactionProjects}</dt>
              <dd>{selectedProject?.name ?? t.none}</dd>
            </div>
            <div className="interaction-context-item">
              <dt>{t.interactionMembers}</dt>
              <dd>{selectedMember?.displayName ?? t.none}</dd>
            </div>
            <div className="interaction-context-item">
              <dt>{t.interactionPosition}</dt>
              <dd>{selectedMember?.positionName ?? t.none}</dd>
            </div>
            <div className="interaction-context-item">
              <dt>{t.interactionProvider}</dt>
              <dd>{agentName}</dd>
            </div>
            <div className="interaction-context-item">
              <dt>{t.departmentRuns}</dt>
              <dd>{currentRunId ?? t.interactionUnboundRun}</dd>
            </div>
          </dl>
          <InteractionRunPanel
            currentRunId={currentRunId}
            onCollaborate={(run) => void createRunCollaboration(run)}
            onSelectRun={setSelectedRunId}
            runs={runs}
            selectedRunId={currentRunId}
            t={t}
          />
          {selected ? (
            <>
              <section className="interaction-context-section">
                <div className="interaction-panel-heading">
                  <h3>{t.permissions}</h3>
                </div>
                <input
                  aria-label={t.requestPermission}
                  onChange={(event) => setPermissionScope(event.target.value)}
                  placeholder={t.requestPermission}
                  value={permissionScope}
                />
                <button
                  disabled={!permissionScope.trim()}
                  onClick={() => void requestPermission()}
                  type="button"
                >
                  {t.requestPermission}
                </button>
                {selected.permissions.map((permission) => (
                  <div
                    className="interaction-permission"
                    data-permission-request={permission.id}
                    key={permission.id}
                  >
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
              </section>
              <section className="interaction-context-section">
                <div className="interaction-panel-heading">
                  <h3>{t.memoryCandidates}</h3>
                </div>
                {memoryCandidates.map((candidate) => (
                  <div
                    className="interaction-memory-candidate"
                    data-memory-candidate={candidate.id}
                    key={candidate.id}
                  >
                    <span>
                      {candidate.currentRevision.content} · {candidate.status}
                    </span>
                    <small>
                      {candidate.reviewTopicId ?? t.none} · revision{" "}
                      {candidate.revision}
                      {candidate.decision
                        ? ` · ${memoryCandidateDecisionLabel(candidate, t.none)}`
                        : ""}
                    </small>
                  </div>
                ))}
                {memoryEntries.map((entry) => (
                  <div
                    className="interaction-memory-candidate"
                    data-memory-entry={entry.id}
                    key={entry.id}
                  >
                    <strong>{t.memoryEntries}</strong>
                    <span>
                      {entry.content} · v{entry.version}
                    </span>
                  </div>
                ))}
                {legacyMemoryRecords.map((record) => (
                  <div
                    className="interaction-memory-candidate"
                    data-legacy-memory-record={record.id}
                    key={record.id}
                  >
                    <strong>{t.legacyMemoryRecords}</strong>
                    <span>
                      {record.content} · {record.status}
                    </span>
                  </div>
                ))}
              </section>
            </>
          ) : null}
        </aside>
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
  icon,
  label,
  value,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="metric-card">
      <Icon name={icon} size={24} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
