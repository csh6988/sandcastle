import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  boardCommandRequiresShell,
  resolveBoardCommand,
} from "./boardProcess.js";

describe("board CLI resolution", () => {
  it("resolves the npm Windows command shim before the dogfood fallback", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandcastle-board-windows-"));
    const binDir = join(repoDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "sandcastle.cmd");
    writeFileSync(shim, "@echo off\r\n");

    const resolved = resolveBoardCommand(repoDir, repoDir, "win32");

    assert.equal(basename(resolved.command), "sandcastle.cmd");
    assert.deepEqual(resolved.args, []);
    assert.equal(boardCommandRequiresShell(resolved.command, "win32"), true);
    assert.equal(boardCommandRequiresShell("C:\\node.exe", "win32"), false);
  });
});
