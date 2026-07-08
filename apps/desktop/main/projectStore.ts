import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureCompanyDirectory } from "./companyDirectory.js";

export type ProjectStatus =
  | "draft"
  | "prd-confirmed"
  | "design-ready"
  | "in-rd"
  | "ready-for-review"
  | "accepted"
  | "changes-requested"
  | "rejected";

export type DocumentStageStatus = "draft" | "confirmed" | "skipped" | "stale";

export interface ProjectDocumentStage {
  readonly path: string;
  readonly status: DocumentStageStatus;
  readonly confirmedAt?: string;
  readonly confirmedHash?: string;
  readonly skippedReason?: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ProjectStatus;
  readonly prd: ProjectDocumentStage;
  readonly design: ProjectDocumentStage;
  readonly rd: {
    readonly repositories: readonly string[];
    readonly currentBoardTaskId: string | null;
    readonly history: readonly string[];
  };
  readonly review?: {
    readonly decision?: "accepted" | "changes-requested" | "rejected";
    readonly changeScope?: string;
  };
}

export interface CreateProjectInput {
  readonly name: string;
  readonly summary: string;
  readonly repositories?: readonly string[];
}

export type ProjectDocumentKind =
  | "prd"
  | "design"
  | "review-verification"
  | "review-decision"
  | "review-feedback";

interface ProjectIndex {
  readonly projects: Array<{
    readonly id: string;
    readonly path: string;
  }>;
}

const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
};

const projectDir = (companyDir: string, projectId: string): string =>
  join(companyDir, "projects", projectId);

const projectJsonPath = (companyDir: string, projectId: string): string =>
  join(projectDir(companyDir, projectId), "project.json");

const indexPath = (companyDir: string): string =>
  join(companyDir, ".sandcastle", "project-index.json");

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const documentPath = (
  companyDir: string,
  project: ProjectRecord,
  relativePath: string,
): string => join(projectDir(companyDir, project.id), relativePath);

const projectDocumentRelativePath = (
  project: ProjectRecord,
  kind: ProjectDocumentKind,
): string => {
  switch (kind) {
    case "prd":
      return project.prd.path;
    case "design":
      return project.design.path;
    case "review-verification":
      return "review/verification.md";
    case "review-decision":
      return "review/decision.md";
    case "review-feedback":
      return "review/feedback.md";
  }
};

const fileHash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const writeProject = (
  companyDir: string,
  project: ProjectRecord,
): ProjectRecord => {
  writeJson(projectJsonPath(companyDir, project.id), project);
  return project;
};

const confirmedDocumentChanged = (
  companyDir: string,
  project: ProjectRecord,
  stage: ProjectDocumentStage,
): boolean =>
  stage.status === "confirmed" &&
  stage.confirmedHash !== undefined &&
  fileHash(documentPath(companyDir, project, stage.path)) !==
    stage.confirmedHash;

const refreshStaleState = (
  companyDir: string,
  project: ProjectRecord,
): ProjectRecord => {
  if (confirmedDocumentChanged(companyDir, project, project.prd)) {
    return writeProject(companyDir, {
      ...project,
      status: "draft",
      prd: {
        ...project.prd,
        status: "stale",
      },
    });
  }
  if (confirmedDocumentChanged(companyDir, project, project.design)) {
    return writeProject(companyDir, {
      ...project,
      status: "prd-confirmed",
      design: {
        ...project.design,
        status: "stale",
      },
    });
  }
  return project;
};

const readIndex = (companyDir: string): ProjectIndex =>
  existsSync(indexPath(companyDir))
    ? readJson<ProjectIndex>(indexPath(companyDir))
    : { projects: [] };

const writeIndex = (companyDir: string, index: ProjectIndex): void => {
  writeJson(indexPath(companyDir), index);
};

const nextProjectId = (companyDir: string, name: string): string => {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while (existsSync(projectDir(companyDir, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

export const createProject = (
  companyDir: string,
  input: CreateProjectInput,
): ProjectRecord => {
  ensureCompanyDirectory(companyDir);
  const id = nextProjectId(companyDir, input.name);
  const dir = projectDir(companyDir, id);
  for (const relativeDir of [
    "prd/assets",
    "design/assets",
    "review",
    "artifacts/screenshots",
    "artifacts/files",
  ]) {
    mkdirSync(join(dir, relativeDir), { recursive: true });
  }

  const project: ProjectRecord = {
    id,
    name: input.name,
    summary: input.summary,
    status: "draft",
    prd: { path: "prd/prd.md", status: "draft" },
    design: { path: "design/design.md", status: "draft" },
    rd: {
      repositories: input.repositories ?? [],
      currentBoardTaskId: null,
      history: [],
    },
  };

  writeFileSync(join(dir, project.prd.path), "");
  writeFileSync(join(dir, project.design.path), "");
  writeFileSync(join(dir, "review", "verification.md"), "");
  writeFileSync(join(dir, "review", "decision.md"), "");
  writeFileSync(join(dir, "review", "feedback.md"), "");
  writeJson(join(dir, "artifacts", "manifest.json"), { artifacts: [] });
  writeJson(projectJsonPath(companyDir, id), project);

  const index = readIndex(companyDir);
  writeIndex(companyDir, {
    projects: [...index.projects, { id, path: `projects/${id}` }],
  });

  return project;
};

export const readProject = (
  companyDir: string,
  projectId: string,
): ProjectRecord =>
  refreshStaleState(
    companyDir,
    readJson<ProjectRecord>(projectJsonPath(companyDir, projectId)),
  );

export const listProjects = (companyDir: string): ProjectRecord[] => {
  const index = readIndex(companyDir);
  return index.projects
    .filter((entry) => existsSync(projectJsonPath(companyDir, entry.id)))
    .map((entry) => readProject(companyDir, entry.id));
};

export const readProjectDocument = (
  companyDir: string,
  projectId: string,
  kind: ProjectDocumentKind,
): string => {
  const project = readProject(companyDir, projectId);
  return readFileSync(
    documentPath(
      companyDir,
      project,
      projectDocumentRelativePath(project, kind),
    ),
    "utf8",
  );
};

export const saveProjectDocument = (
  companyDir: string,
  projectId: string,
  kind: ProjectDocumentKind,
  markdown: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  writeFileSync(
    documentPath(
      companyDir,
      project,
      projectDocumentRelativePath(project, kind),
    ),
    markdown,
  );
  return readProject(companyDir, projectId);
};

export const importProjectDocument = (
  companyDir: string,
  projectId: string,
  kind: ProjectDocumentKind,
  sourcePath: string,
): ProjectRecord =>
  saveProjectDocument(
    companyDir,
    projectId,
    kind,
    readFileSync(sourcePath, "utf8"),
  );

export const projectDocumentFolder = (
  companyDir: string,
  projectId: string,
  kind: ProjectDocumentKind,
): string => {
  const project = readProject(companyDir, projectId);
  return dirname(
    documentPath(
      companyDir,
      project,
      projectDocumentRelativePath(project, kind),
    ),
  );
};

export const confirmPrd = (
  companyDir: string,
  projectId: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  const path = documentPath(companyDir, project, project.prd.path);
  return writeProject(companyDir, {
    ...project,
    status: "prd-confirmed",
    prd: {
      ...project.prd,
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
      confirmedHash: fileHash(path),
    },
  });
};

export const confirmDesign = (
  companyDir: string,
  projectId: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  if (project.prd.status !== "confirmed") {
    throw new Error("PRD is not confirmed.");
  }
  const path = documentPath(companyDir, project, project.design.path);
  return writeProject(companyDir, {
    ...project,
    status: "design-ready",
    design: {
      ...project.design,
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
      confirmedHash: fileHash(path),
    },
  });
};

export const skipDesign = (
  companyDir: string,
  projectId: string,
  reason: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  if (project.prd.status !== "confirmed") {
    throw new Error("PRD is not confirmed.");
  }
  if (reason.trim().length === 0) {
    throw new Error("Design skip reason is required.");
  }
  return writeProject(companyDir, {
    ...project,
    status: "design-ready",
    design: {
      path: project.design.path,
      status: "skipped",
      skippedReason: reason,
    },
  });
};

export const startRdExecution = (
  companyDir: string,
  projectId: string,
  boardTaskId: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  if (project.prd.status !== "confirmed") {
    throw new Error("PRD is not confirmed.");
  }
  if (
    project.design.status !== "confirmed" &&
    project.design.status !== "skipped"
  ) {
    throw new Error("Design is neither confirmed nor skipped.");
  }
  if (project.rd.currentBoardTaskId) {
    throw new Error("Another current board task is still active.");
  }
  return writeProject(companyDir, {
    ...project,
    status: "in-rd",
    review: undefined,
    rd: {
      ...project.rd,
      currentBoardTaskId: boardTaskId,
    },
  });
};

export const markRdVerified = (
  companyDir: string,
  projectId: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  if (project.status !== "in-rd" || !project.rd.currentBoardTaskId) {
    throw new Error("R&D execution is not active.");
  }
  return writeProject(companyDir, {
    ...project,
    status: "ready-for-review",
    rd: {
      ...project.rd,
      currentBoardTaskId: null,
      history: [...project.rd.history, project.rd.currentBoardTaskId],
    },
  });
};

const requireReadyForReview = (project: ProjectRecord): void => {
  if (project.status !== "ready-for-review") {
    throw new Error("Project is not ready for review.");
  }
};

export const acceptDelivery = (
  companyDir: string,
  projectId: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  requireReadyForReview(project);
  return writeProject(companyDir, {
    ...project,
    status: "accepted",
    review: { decision: "accepted" },
  });
};

export const requestChanges = (
  companyDir: string,
  projectId: string,
  changeScope: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  requireReadyForReview(project);
  return writeProject(companyDir, {
    ...project,
    status: "changes-requested",
    review: {
      decision: "changes-requested",
      changeScope,
    },
  });
};

export const rejectDelivery = (
  companyDir: string,
  projectId: string,
): ProjectRecord => {
  const project = readProject(companyDir, projectId);
  requireReadyForReview(project);
  return writeProject(companyDir, {
    ...project,
    status: "rejected",
    review: { decision: "rejected" },
  });
};

export const readProjectArtifacts = (
  companyDir: string,
  projectId: string,
): unknown => {
  const project = readProject(companyDir, projectId);
  return readJson(documentPath(companyDir, project, "artifacts/manifest.json"));
};
