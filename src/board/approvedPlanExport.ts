import { relative } from "node:path";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";
import type { BoardStore, BoardTaskArtifact } from "./BoardStore.js";
import {
  writeWorkspacePlanningArtifacts,
  type WorkspacePlanningArtifacts,
} from "./planningArtifacts.js";

const workspacePlanningArtifactManifest = (
  cwd: string,
  artifacts: WorkspacePlanningArtifacts,
  createdAt: string,
): BoardTaskArtifact[] => [
  {
    kind: "workspace-plan",
    absolutePath: artifacts.planJsonPath,
    displayPath: relative(cwd, artifacts.planJsonPath),
    createdAt,
  },
  {
    kind: "alignment",
    absolutePath: artifacts.alignmentPath,
    displayPath: relative(cwd, artifacts.alignmentPath),
    createdAt,
  },
  {
    kind: "technical-plan",
    absolutePath: artifacts.technicalPlanPath,
    displayPath: relative(cwd, artifacts.technicalPlanPath),
    createdAt,
  },
  ...artifacts.issuePaths.map((path) => ({
    kind: "issue" as const,
    absolutePath: path,
    displayPath: relative(cwd, path),
    createdAt,
  })),
];

export const exportApprovedBoardPlan = (opts: {
  readonly store: BoardStore;
  readonly cwd: string;
  readonly taskId: string;
  readonly artifactsDir: string;
  readonly plan: WorkspaceTaskPlan;
  readonly createdAt?: string;
}): WorkspacePlanningArtifacts => {
  const artifacts = writeWorkspacePlanningArtifacts(
    opts.artifactsDir,
    opts.plan,
  );
  opts.store.writeTaskArtifactManifest(
    opts.taskId,
    workspacePlanningArtifactManifest(
      opts.cwd,
      artifacts,
      opts.createdAt ?? new Date().toISOString(),
    ),
  );
  return artifacts;
};
