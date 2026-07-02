import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePrdInput } from "./prdAssets.js";

describe("preparePrdInput", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-prd-assets-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("copies markdown image references into task assets and appends asset instructions", () => {
    const prdFile = join(dir, "prd.md");
    const imageFile = join(dir, "login design.png");
    const taskAssetsDir = join(dir, "board", "tasks", "task-1", "assets");
    writeFileSync(imageFile, "fake image");

    const prepared = preparePrdInput({
      prdFile,
      prdText: "Build this UI.\n\n![Login design](./login%20design.png)\n",
      taskAssetsDir,
    });

    expect(prepared.assets).toEqual([
      expect.objectContaining({
        altText: "Login design",
        originalReference: "./login%20design.png",
        taskAssetPath: join(taskAssetsDir, "001-login-design.png"),
      }),
    ]);
    expect(existsSync(join(taskAssetsDir, "001-login-design.png"))).toBe(true);
    expect(
      readFileSync(join(taskAssetsDir, "001-login-design.png"), "utf8"),
    ).toBe("fake image");
    expect(prepared.prompt).toContain("## PRD visual assets");
    expect(prepared.prompt).toContain("Inspect these image files");
    expect(prepared.prompt).toContain(
      join(taskAssetsDir, "001-login-design.png"),
    );
    expect(prepared.warnings).toEqual([]);
  });

  it("treats a direct image file as a visual PRD", () => {
    const prdFile = join(dir, "mock.png");
    const taskAssetsDir = join(dir, "board", "tasks", "task-1", "assets");
    writeFileSync(prdFile, "fake image");

    const prepared = preparePrdInput({
      prdFile,
      prdText: "",
      taskAssetsDir,
    });

    expect(prepared.prompt).toContain("The PRD is a visual design asset.");
    expect(prepared.prompt).toContain(
      join(taskAssetsDir, "001-prd-visual-design.png"),
    );
    expect(prepared.assets).toEqual([
      expect.objectContaining({
        altText: "PRD visual design",
        originalReference: prdFile,
        sourcePath: prdFile,
        taskAssetPath: join(taskAssetsDir, "001-prd-visual-design.png"),
      }),
    ]);
  });
});
