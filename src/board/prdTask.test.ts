import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { createPrdFileBoardTask } from "./prdTask.js";

describe("createPrdFileBoardTask", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-prd-task-"));
    store = new BoardStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a pending board task from a PRD file", () => {
    const task = createPrdFileBoardTask(store, {
      prdFile: "/tmp/my-feature/prd.md",
      prd: "Build the PRD flow.",
    });

    expect(task).toMatchObject({
      title: "PRD: my-feature",
      prompt: "# Product Requirements Document\n\nBuild the PRD flow.",
      status: "pending",
      source: {
        type: "prd-file",
        prdFile: "/tmp/my-feature/prd.md",
      },
    });
  });

  it("records markdown PRD visual assets on the task", () => {
    const prdFile = join(dir, "prd.md");
    const imageFile = join(dir, "mock.png");
    writeFileSync(imageFile, "fake image");

    const task = createPrdFileBoardTask(store, {
      prdFile,
      prd: "Build this UI.\n\n![Mock](./mock.png)\n",
    });

    expect(task.prompt).toContain("## PRD visual assets");
    expect(task.prompt).toContain("Inspect these image files");
    expect(task.source).toMatchObject({
      type: "prd-file",
      prdFile,
      assets: [
        {
          altText: "Mock",
          originalReference: "./mock.png",
        },
      ],
    });
    const asset =
      task.source?.type === "prd-file" ? task.source.assets?.[0] : undefined;
    expect(asset?.taskAssetPath).toBe(
      join(dir, "tasks", task.id, "assets", "001-mock.png"),
    );
    expect(existsSync(asset?.taskAssetPath ?? "")).toBe(true);
    expect(store.listTaskArtifacts(task.id)).toEqual([
      expect.objectContaining({
        kind: "asset",
        absolutePath: join(dir, "tasks", task.id, "assets", "001-mock.png"),
      }),
    ]);
  });
});
