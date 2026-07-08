import { useEffect, useMemo, useState } from "react";
import {
  acceptProjectReview,
  bindMemberSkillFlows,
  confirmProjectDesign,
  confirmProjectPrd,
  createProject,
  createSkillFlow,
  fetchDepartments,
  fetchProjectArtifacts,
  fetchProjectDocument,
  fetchProjects,
  fetchSkillFlows,
  importProjectDocument,
  markProjectRdVerified,
  openProjectDocumentFolder,
  rejectProjectReview,
  requestProjectChanges,
  saveProjectDocument,
  skipProjectDesign,
  startProjectRd,
  type Department,
  type DesktopProject,
  type SkillFlow,
} from "./boardApi.js";
import { markdownPreviewBlocks } from "./markdownPreview.js";
import {
  currentStage,
  rdPipelineSteps,
  reviewStatusLabel,
  workbenchStages,
  type WorkbenchStage,
} from "./projectViewModel.js";

const splitLines = (value: string): string[] =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const stageLabel = (project: DesktopProject): string =>
  workbenchStages.find((stage) => stage.id === currentStage(project))?.label ??
  "PRD";

export function ProjectsPage({
  onProjectContextChange,
}: {
  readonly onProjectContextChange?: (project: DesktopProject | null) => void;
}) {
  const [projects, setProjects] = useState<DesktopProject[] | null>(null);
  const [selectedProject, setSelectedProject] = useState<DesktopProject | null>(
    null,
  );
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [repositories, setRepositories] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    fetchProjects()
      .then((body) => {
        setProjects(body.projects);
        setSelectedProject((current) =>
          current
            ? (body.projects.find((project) => project.id === current.id) ??
              current)
            : null,
        );
      })
      .catch((nextError: unknown) => {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
        setProjects([]);
      });
  };

  useEffect(refresh, []);
  useEffect(() => {
    onProjectContextChange?.(selectedProject);
  }, [onProjectContextChange, selectedProject]);

  const submitProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const project = await createProject({
        name,
        summary,
        repositories: splitLines(repositories),
      });
      setName("");
      setSummary("");
      setRepositories("");
      setSelectedProject(project);
      refresh();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  };

  if (selectedProject) {
    return (
      <ProjectWorkbench
        project={selectedProject}
        onBack={() => setSelectedProject(null)}
        onProjectChange={setSelectedProject}
      />
    );
  }

  const projectCount = projects?.length ?? 0;
  const activeCount =
    projects?.filter((project) => project.rd.currentBoardTaskId).length ?? 0;
  const reviewCount =
    projects?.filter((project) => project.status === "ready-for-review")
      .length ?? 0;

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Projects-first workbench</span>
          <h1>Projects</h1>
          <p>
            Delivery objects moving through PRD, Design, R&D Execution, Review,
            and Artifacts.
          </p>
        </div>
      </div>
      {error && <div className="warn">{error}</div>}
      <div className="metric-row">
        <Metric label="Projects" value={projectCount} />
        <Metric label="Active board tasks" value={activeCount} />
        <Metric label="Ready for review" value={reviewCount} />
      </div>
      <div className="project-dashboard">
        <section className="project-grid" aria-label="Project list">
          {projects === null ? (
            <div className="empty-state">Loading projects...</div>
          ) : projects.length === 0 ? (
            <div className="empty-state">
              <strong>No projects yet</strong>
              <span>
                Create a project to attach PRD, design, linked repositories, and
                review evidence.
              </span>
            </div>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                className="project-card"
                onClick={() => setSelectedProject(project)}
                type="button"
              >
                <span className="project-card-top">
                  <strong>{project.name}</strong>
                  <span className="pill primary">{project.status}</span>
                </span>
                <span className="project-summary">{project.summary}</span>
                <span className="project-meta-grid">
                  <span>
                    Stage <strong>{stageLabel(project)}</strong>
                  </span>
                  <span>
                    Repository{" "}
                    <strong>
                      {project.rd.repositories[0] ?? "Not linked"}
                    </strong>
                  </span>
                  <span>
                    Board task{" "}
                    <strong>{project.rd.currentBoardTaskId ?? "Idle"}</strong>
                  </span>
                  <span>
                    Review <strong>{reviewStatusLabel(project)}</strong>
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
        <aside className="create-panel" aria-labelledby="create-project-title">
          <h2 id="create-project-title">Create Project</h2>
          <form
            className="form"
            onSubmit={(event) => void submitProject(event)}
          >
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              name="projectName"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <label htmlFor="project-summary">Summary / goal</label>
            <textarea
              id="project-summary"
              name="projectSummary"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              required
              rows={4}
            />
            <label htmlFor="project-repositories">
              Linked repositories, one per line
            </label>
            <textarea
              id="project-repositories"
              name="projectRepositories"
              value={repositories}
              onChange={(event) => setRepositories(event.target.value)}
              rows={4}
            />
            <button type="submit">Create project</button>
          </form>
        </aside>
      </div>
    </div>
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
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ProjectWorkbench({
  project,
  onBack,
  onProjectChange,
}: {
  readonly project: DesktopProject;
  readonly onBack: () => void;
  readonly onProjectChange: (project: DesktopProject) => void;
}) {
  const [stage, setStage] = useState<WorkbenchStage>(() =>
    currentStage(project),
  );

  useEffect(() => {
    setStage(currentStage(project));
  }, [project.status, project.rd.currentBoardTaskId]);

  const updateProject = (nextProject: DesktopProject) => {
    onProjectChange(nextProject);
  };

  return (
    <div className="page workbench-page">
      <button className="link-button" onClick={onBack} type="button">
        Back to projects
      </button>
      <div className="workbench-header">
        <div>
          <span className="eyebrow">Project Workbench</span>
          <h1>{project.name}</h1>
          <p>{project.summary}</p>
        </div>
        <span className="pill primary">{project.status}</span>
      </div>
      <div className="workbench-layout">
        <aside className="stage-rail" aria-label="Project stage timeline">
          {workbenchStages.map((item) => (
            <button
              key={item.id}
              className={`stage-step ${stage === item.id ? "on" : ""}`}
              onClick={() => setStage(item.id)}
              type="button"
            >
              <span>{item.shortLabel}</span>
              <strong>{item.label}</strong>
            </button>
          ))}
        </aside>
        <section className="stage-workspace">
          {stage === "prd" && (
            <MarkdownStage
              project={project}
              documentKind="prd"
              title="PRD"
              status={project.prd.status}
              path={project.prd.path}
              confirmLabel="Confirm PRD"
              onConfirm={async () => {
                updateProject(await confirmProjectPrd(project.id));
              }}
              onProjectChange={updateProject}
            />
          )}
          {stage === "design" && (
            <MarkdownStage
              project={project}
              documentKind="design"
              title="Design"
              status={project.design.status}
              path={project.design.path}
              confirmLabel="Confirm Design"
              onConfirm={async () => {
                updateProject(await confirmProjectDesign(project.id));
              }}
              onSkip={async (reason) => {
                updateProject(await skipProjectDesign(project.id, reason));
              }}
              onProjectChange={updateProject}
            />
          )}
          {stage === "rd" && (
            <RdStage project={project} onProjectChange={updateProject} />
          )}
          {stage === "review" && (
            <ReviewStage project={project} onProjectChange={updateProject} />
          )}
          {stage === "artifacts" && <ArtifactsStage project={project} />}
        </section>
        <ProjectInspector project={project} />
      </div>
    </div>
  );
}

function ProjectInspector({ project }: { readonly project: DesktopProject }) {
  return (
    <aside className="inspector" aria-label="Project inspector">
      <section>
        <h2>Status</h2>
        <dl>
          <dt>Project</dt>
          <dd>{project.status}</dd>
          <dt>Current stage</dt>
          <dd>{stageLabel(project)}</dd>
          <dt>Review</dt>
          <dd>{reviewStatusLabel(project)}</dd>
        </dl>
      </section>
      <section>
        <h2>Linked repos</h2>
        {project.rd.repositories.length === 0 ? (
          <p>No repositories linked.</p>
        ) : (
          <ul className="plain-list">
            {project.rd.repositories.map((repository) => (
              <li key={repository}>{repository}</li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>AI members</h2>
        <div className="chip-row">
          {["Planner", "Designer", "Generator", "Evaluator"].map((member) => (
            <span key={member} className="chip">
              {member}
            </span>
          ))}
        </div>
      </section>
      <section>
        <h2>Evidence</h2>
        <dl>
          <dt>Current board task</dt>
          <dd>{project.rd.currentBoardTaskId ?? "None"}</dd>
          <dt>Prior tasks</dt>
          <dd>{project.rd.history.length}</dd>
        </dl>
      </section>
    </aside>
  );
}

function RdStage({
  project,
  onProjectChange,
}: {
  readonly project: DesktopProject;
  readonly onProjectChange: (project: DesktopProject) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const steps = ["Planning", "Approval", "Running", "Verifying", "Done"];
  const stepStates = rdPipelineSteps(project);

  const runAction = async (
    action: () => Promise<DesktopProject>,
    success: string,
  ) => {
    try {
      const nextProject = await action();
      onProjectChange(nextProject);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="stage-view">
      <StageHeader
        title="R&D Execution"
        status={project.rd.currentBoardTaskId ?? project.status}
        body="Existing board task workflow as the project pipeline instance."
      />
      <div className="pipeline">
        {steps.map((step, index) => (
          <span key={step} className={`pipeline-step ${stepStates[index]}`}>
            {step}
          </span>
        ))}
      </div>
      <div className="rd-grid">
        <section>
          <h3>Linked repositories</h3>
          {project.rd.repositories.length === 0 ? (
            <div className="empty-state compact">
              No R&D repositories linked.
            </div>
          ) : (
            <ul className="repo-list">
              {project.rd.repositories.map((repository) => (
                <li key={repository}>{repository}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="task-card">
          <h3>Current board task</h3>
          <dl>
            <dt>Task</dt>
            <dd>{project.rd.currentBoardTaskId ?? "Not started"}</dd>
            <dt>Last result</dt>
            <dd>{project.rd.history.at(-1) ?? "No completed task yet"}</dd>
          </dl>
        </section>
      </div>
      {notice && <div className="inline-notice">{notice}</div>}
      <div className="action-bar">
        <button
          type="button"
          onClick={() =>
            void runAction(
              () => startProjectRd(project.id),
              "R&D pipeline started.",
            )
          }
        >
          Start R&D
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            void runAction(
              () => markProjectRdVerified(project.id),
              "R&D marked verified.",
            )
          }
        >
          Mark verified
        </button>
      </div>
    </div>
  );
}

function ReviewStage({
  project,
  onProjectChange,
}: {
  readonly project: DesktopProject;
  readonly onProjectChange: (project: DesktopProject) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const runReviewAction = async (
    action: () => Promise<DesktopProject>,
    success: string,
  ) => {
    try {
      const nextProject = await action();
      onProjectChange(nextProject);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="stage-view">
      <MarkdownStage
        project={project}
        documentKind="review-decision"
        title="Review"
        status={reviewStatusLabel(project)}
        path="review/decision.md"
        secondaryDocument={{
          kind: "review-feedback",
          label: "Feedback",
          path: "review/feedback.md",
        }}
        onProjectChange={onProjectChange}
      />
      {notice && <div className="inline-notice">{notice}</div>}
      <div className="action-bar">
        <button
          type="button"
          onClick={() =>
            void runReviewAction(
              () => acceptProjectReview(project.id),
              "Delivery accepted.",
            )
          }
        >
          Accept delivery
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            void runReviewAction(
              () => requestProjectChanges(project.id, "Rerun R&D only"),
              "Changes requested.",
            )
          }
        >
          Request changes
        </button>
        <button
          type="button"
          className="secondary-button danger"
          onClick={() =>
            void runReviewAction(
              () => rejectProjectReview(project.id),
              "Delivery rejected.",
            )
          }
        >
          Reject delivery
        </button>
      </div>
    </div>
  );
}

function ArtifactsStage({ project }: { readonly project: DesktopProject }) {
  const [artifacts, setArtifacts] = useState<unknown[] | null>(null);

  useEffect(() => {
    fetchProjectArtifacts(project.id)
      .then((body) => setArtifacts(body.artifacts))
      .catch(() => setArtifacts([]));
  }, [project.id]);

  return (
    <div className="stage-view">
      <StageHeader
        title="Artifacts"
        status={`${artifacts?.length ?? 0} recorded`}
        body="Delivery manifest and final project outputs."
      />
      <dl className="artifact-summary">
        <dt>Manifest path</dt>
        <dd>artifacts/manifest.json</dd>
        <dt>Artifact count</dt>
        <dd>{artifacts?.length ?? 0}</dd>
      </dl>
      {artifacts === null ? (
        <div className="empty-state">Loading artifacts...</div>
      ) : artifacts.length === 0 ? (
        <div className="empty-state">
          <strong>No delivery artifacts recorded</strong>
          <span>
            Final files, screenshots, and delivery notes will appear here when
            the project records them.
          </span>
        </div>
      ) : (
        <pre>{JSON.stringify(artifacts, null, 2)}</pre>
      )}
    </div>
  );
}

function MarkdownStage({
  project,
  documentKind,
  title,
  status,
  path,
  confirmLabel,
  onConfirm,
  onSkip,
  onProjectChange,
  secondaryDocument,
}: {
  readonly project: DesktopProject;
  readonly documentKind: string;
  readonly title: string;
  readonly status: string;
  readonly path: string;
  readonly confirmLabel?: string;
  readonly onConfirm?: () => Promise<void>;
  readonly onSkip?: (reason: string) => Promise<void>;
  readonly onProjectChange: (project: DesktopProject) => void;
  readonly secondaryDocument?: {
    readonly kind: string;
    readonly label: string;
    readonly path: string;
  };
}) {
  const [markdown, setMarkdown] = useState("");
  const [secondaryMarkdown, setSecondaryMarkdown] = useState("");
  const [importSource, setImportSource] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const editorId = `${project.id}-${documentKind}-markdown`;
  const importId = `${project.id}-${documentKind}-import-path`;
  const skipId = `${project.id}-${documentKind}-skip-reason`;
  const secondaryEditorId = `${project.id}-${secondaryDocument?.kind ?? "secondary"}-markdown`;

  useEffect(() => {
    let active = true;
    fetchProjectDocument(project.id, documentKind)
      .then((body) => {
        if (active) setMarkdown(body.markdown);
      })
      .catch((error: unknown) => {
        if (active)
          setNotice(error instanceof Error ? error.message : String(error));
      });
    if (secondaryDocument) {
      fetchProjectDocument(project.id, secondaryDocument.kind)
        .then((body) => {
          if (active) setSecondaryMarkdown(body.markdown);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [documentKind, project.id, secondaryDocument]);

  const save = async () => {
    const nextProject = await saveProjectDocument(
      project.id,
      documentKind,
      markdown,
    );
    if (secondaryDocument) {
      await saveProjectDocument(
        project.id,
        secondaryDocument.kind,
        secondaryMarkdown,
      );
    }
    onProjectChange(nextProject);
    setNotice("Saved.");
  };

  const importSourceFile = async () => {
    const nextProject = await importProjectDocument(
      project.id,
      documentKind,
      importSource,
    );
    const body = await fetchProjectDocument(nextProject.id, documentKind);
    setMarkdown(body.markdown);
    onProjectChange(nextProject);
    setNotice("Imported.");
  };

  const openFolder = async () => {
    const result = await openProjectDocumentFolder(project.id, documentKind);
    setNotice(`Opened ${result.opened}`);
  };

  return (
    <div className="stage-view">
      <StageHeader title={title} status={status} body={path} />
      {notice && <div className="inline-notice">{notice}</div>}
      <div className="split-editor">
        <div className="editor-pane">
          <label htmlFor={editorId}>{title} markdown</label>
          <textarea
            id={editorId}
            name={`${documentKind}Markdown`}
            className="markdown-editor"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
          />
        </div>
        <div className="preview-pane" aria-label={`${title} preview`}>
          <MarkdownPreview markdown={markdown} />
        </div>
      </div>
      {secondaryDocument && (
        <div className="split-editor secondary-editor">
          <div className="editor-pane">
            <label htmlFor={secondaryEditorId}>
              {secondaryDocument.label} markdown
            </label>
            <textarea
              id={secondaryEditorId}
              name={`${secondaryDocument.kind}Markdown`}
              className="markdown-editor"
              value={secondaryMarkdown}
              onChange={(event) => setSecondaryMarkdown(event.target.value)}
            />
          </div>
          <div
            className="preview-pane"
            aria-label={`${secondaryDocument.label} preview`}
          >
            <MarkdownPreview markdown={secondaryMarkdown} />
          </div>
        </div>
      )}
      <div className="action-bar">
        <button type="button" onClick={() => void save()}>
          Save
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void openFolder()}
        >
          Open folder
        </button>
        {onConfirm && confirmLabel && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </button>
        )}
      </div>
      <div className="inline-form-row">
        <label htmlFor={importId}>Markdown file path</label>
        <input
          id={importId}
          name={`${documentKind}ImportPath`}
          value={importSource}
          onChange={(event) => setImportSource(event.target.value)}
          placeholder="/path/to/file.md"
        />
        <button type="button" onClick={() => void importSourceFile()}>
          Import
        </button>
      </div>
      {onSkip && (
        <div className="inline-form-row">
          <label htmlFor={skipId}>Skip reason</label>
          <input
            id={skipId}
            name={`${documentKind}SkipReason`}
            value={skipReason}
            onChange={(event) => setSkipReason(event.target.value)}
            placeholder="Why design is not required"
          />
          <button type="button" onClick={() => void onSkip(skipReason)}>
            Skip Design
          </button>
        </div>
      )}
    </div>
  );
}

function StageHeader({
  title,
  status,
  body,
}: {
  readonly title: string;
  readonly status: string;
  readonly body: string;
}) {
  return (
    <div className="stage-heading">
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <span className="pill">{status}</span>
    </div>
  );
}

function MarkdownPreview({ markdown }: { readonly markdown: string }) {
  const blocks = markdownPreviewBlocks(markdown);
  if (blocks.length === 0) {
    return (
      <div className="markdown-preview">
        <span className="muted">Empty preview</span>
      </div>
    );
  }

  return (
    <div className="markdown-preview">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = `h${block.level}` as "h1" | "h2" | "h3";
          return <Heading key={index}>{block.text}</Heading>;
        }
        if (block.type === "list") {
          return (
            <ul key={index}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "code") {
          return (
            <pre key={index}>
              <code>{block.code}</code>
            </pre>
          );
        }
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

export function DepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [skillFlows, setSkillFlows] = useState<SkillFlow[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState("planner");
  const [selectedFlowIds, setSelectedFlowIds] = useState<string[]>([]);
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null);
  const [newFlowName, setNewFlowName] = useState("");
  const [newFlowSkills, setNewFlowSkills] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const softwareRnd = departments.find(
    (department) => department.id === "software-rnd",
  );
  const selectedMember = softwareRnd?.members.find(
    (member) => member.id === selectedMemberId,
  );

  const refresh = () => {
    fetchDepartments()
      .then((body) => {
        setDepartments(body.departments);
        const member =
          body.departments
            .find((department) => department.id === "software-rnd")
            ?.members.find((item) => item.id === selectedMemberId) ??
          body.departments[0]?.members[0];
        if (member) {
          setSelectedMemberId(member.id);
          setSelectedFlowIds([...member.skillFlowIds]);
        }
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : String(error)),
      );
    fetchSkillFlows()
      .then((body) => setSkillFlows(body.skillFlows))
      .catch(() => setSkillFlows([]));
  };

  useEffect(refresh, []);

  const selectMember = (memberId: string) => {
    setSelectedMemberId(memberId);
    const member = softwareRnd?.members.find((item) => item.id === memberId);
    setSelectedFlowIds(member ? [...member.skillFlowIds] : []);
  };

  const toggleFlow = (flowId: string) => {
    setSelectedFlowIds((current) =>
      current.includes(flowId)
        ? current.filter((item) => item !== flowId)
        : [...current, flowId],
    );
  };

  const moveFlow = (flowId: string, offset: -1 | 1) => {
    setSelectedFlowIds((current) => {
      const index = current.indexOf(flowId);
      const nextIndex = index + offset;
      if (index === -1 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = current.slice();
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  };

  const saveBinding = async () => {
    const body = await bindMemberSkillFlows(
      "software-rnd",
      selectedMemberId,
      selectedFlowIds,
    );
    setDepartments(body.departments);
    setNotice("Saved skill-flow bindings.");
  };

  const submitFlow = async (event: React.FormEvent) => {
    event.preventDefault();
    const flow = await createSkillFlow({
      name: newFlowName,
      skills: splitLines(newFlowSkills),
    });
    setNewFlowName("");
    setNewFlowSkills("");
    setSkillFlows((current) => [...current, flow]);
    setNotice("Created skill flow.");
  };

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AI company configuration</span>
          <h1>Departments</h1>
          <p>AI members, skill-flow bindings, and role boundaries.</p>
        </div>
      </div>
      {notice && <div className="inline-notice">{notice}</div>}
      <div className="department-layout">
        <section className="department-roster" aria-label="Department roster">
          <h2>{softwareRnd?.name ?? "Software R&D"}</h2>
          {(softwareRnd?.members ?? []).map((member) => (
            <button
              key={member.id}
              className={`member-row ${member.id === selectedMemberId ? "on" : ""}`}
              onClick={() => selectMember(member.id)}
              type="button"
            >
              <strong>{member.name}</strong>
              <span>{member.responsibility}</span>
            </button>
          ))}
        </section>
        <section className="member-config">
          <div className="stage-heading">
            <div>
              <h2>{selectedMember?.name ?? "AI Member"}</h2>
              <p>{selectedMember?.responsibility}</p>
            </div>
            <span className="pill">{selectedFlowIds.length} flows</span>
          </div>
          <div className="flow-list">
            {skillFlows.map((flow) => {
              const checked = selectedFlowIds.includes(flow.id);
              const checkboxId = `flow-${flow.id}`;
              return (
                <div key={flow.id} className="flow-row">
                  <div className="flow-heading">
                    <label htmlFor={checkboxId}>
                      <input
                        id={checkboxId}
                        name="skillFlow"
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFlow(flow.id)}
                      />
                      <span>{flow.name}</span>
                    </label>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setExpandedFlowId(
                          expandedFlowId === flow.id ? null : flow.id,
                        )
                      }
                    >
                      Details
                    </button>
                    <span className="pill">{flow.source}</span>
                  </div>
                  {expandedFlowId === flow.id && (
                    <div className="chip-row">
                      {flow.skills.map((skill) => (
                        <span key={skill} className="chip">
                          {skill}
                        </span>
                      ))}
                    </div>
                  )}
                  {checked && (
                    <div className="action-bar compact">
                      <button
                        type="button"
                        onClick={() => moveFlow(flow.id, -1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        onClick={() => moveFlow(flow.id, 1)}
                      >
                        Move down
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="action-bar">
            <button type="button" onClick={() => void saveBinding()}>
              Save bindings
            </button>
          </div>
        </section>
        <aside className="create-panel">
          <h2>Create flow</h2>
          <form className="form" onSubmit={(event) => void submitFlow(event)}>
            <label htmlFor="skill-flow-name">Name</label>
            <input
              id="skill-flow-name"
              name="skillFlowName"
              value={newFlowName}
              onChange={(event) => setNewFlowName(event.target.value)}
              required
            />
            <label htmlFor="skill-flow-skills">Skills, one per line</label>
            <textarea
              id="skill-flow-skills"
              name="skillFlowSkills"
              value={newFlowSkills}
              onChange={(event) => setNewFlowSkills(event.target.value)}
              rows={5}
              required
            />
            <button type="submit">Create flow</button>
          </form>
          <div className="empty-state compact">
            Missing skills appear here as diagnostics when the registry reports
            them.
          </div>
        </aside>
      </div>
    </div>
  );
}

export function RunsBoardPage({
  project,
}: {
  readonly project: DesktopProject | null;
}) {
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Runs / Board</span>
          <h1>Execution workspace</h1>
          <p>Board process state is started only from Project R&D execution.</p>
        </div>
      </div>
      <div className="empty-state">
        <strong>
          {project?.rd.currentBoardTaskId ?? "No active board task"}
        </strong>
        <span>
          Use a project R&D stage to create or resume the board task pipeline.
        </span>
      </div>
    </div>
  );
}

export function CompanyArtifactsPage({
  project,
}: {
  readonly project: DesktopProject | null;
}) {
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Artifacts</span>
          <h1>Delivery artifacts</h1>
          <p>
            Project manifests and final delivery files stay under the company
            directory.
          </p>
        </div>
      </div>
      <div className="empty-state">
        <strong>
          {project ? `${project.name} artifacts` : "No project selected"}
        </strong>
        <span>
          Open a project workbench to inspect manifest path, artifact count, and
          artifact records.
        </span>
      </div>
    </div>
  );
}

export function SettingsPage({
  language,
  onLanguageChange,
}: {
  readonly language: "en" | "zh";
  readonly onLanguageChange: (language: "en" | "zh") => void;
}) {
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>Local preferences</h1>
          <p>Low-frequency configuration and diagnostics.</p>
        </div>
      </div>
      <div className="settings-list">
        <label htmlFor="settings-language">Language</label>
        <select
          id="settings-language"
          name="language"
          value={language}
          onChange={(event) =>
            onLanguageChange(event.target.value === "zh" ? "zh" : "en")
          }
        >
          <option value="en">English</option>
          <option value="zh">Chinese</option>
        </select>
        <section>
          <h2>Board/store diagnostics</h2>
          <p>No diagnostics reported.</p>
        </section>
        <section>
          <h2>Skill registry diagnostics</h2>
          <p>No missing skill flows reported.</p>
        </section>
      </div>
    </div>
  );
}
