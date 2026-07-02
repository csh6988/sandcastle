import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePrdAssetsForExecution } from "./prdExecutionAssets.js";
import type { BoardTaskRecord } from "./BoardStore.js";

describe("preparePrdAssetsForExecution", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-prd-execution-assets-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("copies PRD visual assets into each repo and marks them for worktree copy", () => {
    const sourceAsset = join(
      dir,
      "board",
      "tasks",
      "task-1",
      "assets",
      "001-mock.png",
    );
    const repo = join(dir, "web");
    mkdirSync(join(dir, "board", "tasks", "task-1", "assets"), {
      recursive: true,
    });
    mkdirSync(repo);
    writeFileSync(sourceAsset, "fake image", { flush: true });
    const task: BoardTaskRecord = {
      id: "task-1",
      title: "Build UI",
      prompt: "Build UI",
      status: "running",
      createdAt: "2026-07-01T00:00:00.000Z",
      runIds: [],
      source: {
        type: "prd-file",
        prdFile: join(dir, "prd.md"),
        assets: [
          {
            altText: "Mock",
            originalReference: "./mock.png",
            sourcePath: join(dir, "mock.png"),
            taskAssetPath: sourceAsset,
          },
        ],
      },
    };

    const prepared = preparePrdAssetsForExecution({
      task,
      repositories: [
        { name: "web", cwd: repo, copyToWorktree: ["node_modules"] },
      ],
    });

    const relativeAssetDir = ".sandcastle/task-assets/task-1";
    expect(prepared.repositories).toEqual([
      {
        name: "web",
        cwd: repo,
        copyToWorktree: ["node_modules", relativeAssetDir],
      },
    ]);
    expect(existsSync(join(repo, relativeAssetDir, "001-mock.png"))).toBe(true);
    expect(prepared.promptSection).toContain(relativeAssetDir);
    expect(prepared.promptSection).toContain(
      "Inspect PRD visual assets before implementation",
    );
  });
});
