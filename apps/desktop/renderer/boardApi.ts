// Thin client over the existing Sandcastle board HTTP API. The desktop shell
// adds no board surface of its own — every call below is an endpoint the
// embedded board already exposes.

export interface BoardStage {
  readonly label: string;
  readonly mode: string;
  readonly description?: string;
  readonly terminalPhase?: string;
  readonly recoverPhase?: string;
  readonly canComplete?: boolean;
  readonly canApprove?: boolean;
  readonly canReject?: boolean;
  readonly canCancel?: boolean;
  readonly canRecover?: boolean;
}

export interface BoardTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly stage?: BoardStage;
  readonly workflow?: {
    readonly status?: string;
    readonly currentPhase?: string;
    readonly role?: string;
    readonly message?: string;
    readonly verificationStatus?: string;
  };
  readonly plan?: unknown;
}

export interface BoardArtifact {
  readonly kind: string;
  readonly displayPath: string;
  readonly absolutePath: string;
  readonly createdAt: string;
}

export interface CompanyView {
  readonly name: string;
  readonly departments: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly operational: boolean;
  }>;
  readonly projects: ReadonlyArray<{
    readonly name: string;
    readonly cwd: string;
  }>;
}

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
};

const postJson = async (path: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!res.ok)
    throw new Error(payload.error ?? `${path} failed: HTTP ${res.status}`);
  return payload;
};

const putJson = async (path: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!res.ok)
    throw new Error(payload.error ?? `${path} failed: HTTP ${res.status}`);
  return payload;
};

export interface CompanyArtifact extends BoardArtifact {
  readonly taskId: string;
  readonly taskTitle: string;
}

export interface CompanyReview {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly finishedAt?: string;
}

export interface DesktopProject {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: string;
  readonly prd: {
    readonly path: string;
    readonly status: string;
  };
  readonly design: {
    readonly path: string;
    readonly status: string;
    readonly skippedReason?: string;
  };
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

export interface CreateDesktopProjectInput {
  readonly name: string;
  readonly summary: string;
  readonly repositories: readonly string[];
}

export interface SkillFlow {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly source: "built-in" | "custom";
}

export interface AiMember {
  readonly id: string;
  readonly name: string;
  readonly responsibility: string;
  readonly skillFlowIds: readonly string[];
}

export interface Department {
  readonly id: string;
  readonly name: string;
  readonly members: readonly AiMember[];
}

export const fetchCompany = () => getJson<CompanyView>("/api/company");
export const fetchCompanyArtifacts = () =>
  getJson<{ artifacts: CompanyArtifact[] }>("/api/artifacts");
export const fetchCompanyReviews = () =>
  getJson<{ reviews: CompanyReview[] }>("/api/reviews");
export const fetchTasks = () => getJson<BoardTask[]>("/api/tasks");
export const fetchProjects = () =>
  getJson<{ projects: DesktopProject[] }>("/api/projects");
export const fetchProject = (projectId: string) =>
  getJson<DesktopProject>(`/api/projects/${encodeURIComponent(projectId)}`);
export const createProject = (input: CreateDesktopProjectInput) =>
  postJson("/api/projects", input) as Promise<DesktopProject>;
export const fetchProjectDocument = (projectId: string, kind: string) =>
  getJson<{ markdown: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(kind)}`,
  );
export const saveProjectDocument = (
  projectId: string,
  kind: string,
  markdown: string,
) =>
  putJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(kind)}`,
    { markdown },
  ) as Promise<DesktopProject>;
export const importProjectDocument = (
  projectId: string,
  kind: string,
  sourcePath: string,
) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(kind)}/import`,
    { sourcePath },
  ) as Promise<DesktopProject>;
export const openProjectDocumentFolder = (projectId: string, kind: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(kind)}/open-folder`,
  ) as Promise<{ opened: string }>;
export const confirmProjectPrd = (projectId: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/prd/confirm`,
  ) as Promise<DesktopProject>;
export const confirmProjectDesign = (projectId: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/design/confirm`,
  ) as Promise<DesktopProject>;
export const skipProjectDesign = (projectId: string, reason: string) =>
  postJson(`/api/projects/${encodeURIComponent(projectId)}/design/skip`, {
    reason,
  }) as Promise<DesktopProject>;
export const startProjectRd = (projectId: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/rd/start`,
  ) as Promise<DesktopProject>;
export const markProjectRdVerified = (projectId: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/rd/mark-verified`,
  ) as Promise<DesktopProject>;
export const acceptProjectReview = (projectId: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/review/accept`,
  ) as Promise<DesktopProject>;
export const requestProjectChanges = (projectId: string, changeScope: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/review/request-changes`,
    { changeScope },
  ) as Promise<DesktopProject>;
export const rejectProjectReview = (projectId: string) =>
  postJson(
    `/api/projects/${encodeURIComponent(projectId)}/review/reject`,
  ) as Promise<DesktopProject>;
export const fetchProjectArtifacts = (projectId: string) =>
  getJson<{ artifacts: unknown[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/artifacts`,
  );
export const fetchDepartments = () =>
  getJson<{ departments: Department[] }>("/api/departments");
export const fetchSkillFlows = () =>
  getJson<{ skillFlows: SkillFlow[] }>("/api/skill-flows");
export const createSkillFlow = (input: {
  readonly name: string;
  readonly skills: readonly string[];
}) => postJson("/api/skill-flows", input) as Promise<SkillFlow>;
export const bindMemberSkillFlows = (
  departmentId: string,
  memberId: string,
  flowIds: readonly string[],
) =>
  putJson(
    `/api/departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(memberId)}/skill-flows`,
    { flowIds },
  ) as Promise<{ departments: Department[] }>;
export const fetchRoleProfiles = () =>
  getJson<{ roleProfiles: Record<string, unknown> }>("/api/role-profiles");
export const fetchArtifacts = (taskId: string) =>
  getJson<{ artifacts: BoardArtifact[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/artifacts`,
  );
export const fetchVerification = (taskId: string) =>
  getJson<{ markdown: string }>(
    `/api/tasks/${encodeURIComponent(taskId)}/verification`,
  );

export const completePhase = (taskId: string, phase: string) =>
  postJson(
    `/api/tasks/${encodeURIComponent(taskId)}/phases/${encodeURIComponent(phase)}/complete`,
  );
export const resumeTask = (taskId: string, decision: "approve" | "reject") =>
  postJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { decision });
export const cancelTask = (taskId: string) =>
  postJson(`/api/tasks/${encodeURIComponent(taskId)}/cancel`);
export const recoverTask = (taskId: string) =>
  postJson(`/api/tasks/${encodeURIComponent(taskId)}/recover`);
