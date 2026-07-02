import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { WorkspaceTaskRepositoryOptions } from "../runWorkspaceTask.js";
import type { BoardTaskRecord } from "./BoardStore.js";
import type { PrdVisualAsset } from "./prdAssets.js";

const executionAssetRelativeDir = (taskId: string): string =>
  `.sandcastle/task-assets/${taskId}`;

const prdAssetsForTask = (task: BoardTaskRecord): readonly PrdVisualAsset[] =>
  task.source?.type === "prd-file" ? (task.source.assets ?? []) : [];

const promptSectionFor = (
  taskId: string,
  assets: readonly PrdVisualAsset[],
): string => {
  if (assets.length === 0) return "";
  const lines = assets
    .map((asset) => {
      const relativePath = posix.join(
        executionAssetRelativeDir(taskId),
        basename(asset.taskAssetPath),
      );
      return `- ${relativePath}${asset.altText ? ` (${asset.altText})` : ""}`;
    })
    .join("\n");
  return `\n\n## PRD visual assets for execution\n\nInspect PRD visual assets before implementation. These images are available inside each target repository:\n\n${lines}`;
};

export const preparePrdAssetsForExecution = (input: {
  readonly task: BoardTaskRecord;
  readonly repositories: readonly WorkspaceTaskRepositoryOptions[];
}): {
  readonly repositories: readonly WorkspaceTaskRepositoryOptions[];
  readonly promptSection: string;
} => {
  const assets = prdAssetsForTask(input.task);
  if (assets.length === 0) {
    return { repositories: input.repositories, promptSection: "" };
  }

  const relativeAssetDir = executionAssetRelativeDir(input.task.id);
  const repositories = input.repositories.map((repo) => {
    const targetDir = join(repo.cwd, relativeAssetDir);
    mkdirSync(targetDir, { recursive: true });
    for (const asset of assets) {
      if (!existsSync(asset.taskAssetPath)) continue;
      copyFileSync(
        asset.taskAssetPath,
        join(targetDir, basename(asset.taskAssetPath)),
      );
    }
    const copyToWorktree = [
      ...(repo.copyToWorktree ?? []),
      ...((repo.copyToWorktree ?? []).includes(relativeAssetDir)
        ? []
        : [relativeAssetDir]),
    ];
    return { ...repo, copyToWorktree };
  });

  return {
    repositories,
    promptSection: promptSectionFor(input.task.id, assets),
  };
};
