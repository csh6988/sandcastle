import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// This suite is the honesty gate for T27 Phase C (decisions D11 / R6): every
// behavior that can ONLY be validated on a real Windows host must be marked
// UNVERIFIED + fail-closed in source and catalogued in a delivered matrix, so
// the codebase never falsely claims real-Windows support from a darwin/CI box.
// It reads tracked files at the existing docs-contract seam (see
// windowsPackaging.test.ts) — no new production seam.

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..", "..");

const adrDir = join(repoRoot, "docs", "adr");
const matrixAdrFile = readdirSync(adrDir).find((name) =>
  name.startsWith("0053-"),
);
const matrixAdr = matrixAdrFile
  ? readFileSync(join(adrDir, matrixAdrFile), "utf8")
  : "";

// The five real-Windows-host-only behaviors from D11/R6, each pinned to the
// source file(s) that must carry the UNVERIFIED marker. Named-pipe IPC spans
// both the bind (server) and connect (client) sides.
const REAL_HOST_MARKED_FILES = [
  "apps/desktop/runtime/server.ts",
  "apps/desktop/runtime/client.ts",
  "apps/desktop/runtime/testing/electronTestFixture.ts",
  "apps/desktop/runtime/release/artifactExportAdapter.ts",
  "apps/desktop/runtime/storage/sqlite.ts",
  "src/mountUtils.ts",
] as const;

describe("Windows real-host verification boundary", () => {
  it("delivers a matrix ADR cataloguing emulation-covered vs requires-real-host behaviors", () => {
    assert.ok(
      matrixAdrFile,
      "expected a matrix ADR at docs/adr/0053-*.md cataloguing the Windows real-host boundary",
    );
    // Both classification axes must be present and named.
    assert.match(matrixAdr, /emulation-covered/i);
    assert.match(matrixAdr, /requires-real-host/i);
    // Every real-host-only behavior from D11/R6 appears in the matrix.
    assert.match(matrixAdr, /named[- ]pipe/i);
    assert.match(matrixAdr, /patchGitMountsForWindows/);
    assert.match(matrixAdr, /electronTestFixture|Electron Test fixture/i);
    assert.match(matrixAdr, /\bWAL\b/);
    assert.match(matrixAdr, /export on win32/i);
  });

  it("records the current macOS status as real-host-pending, never passed", () => {
    assert.match(matrixAdr, /UNVERIFIED/);
    // Honest about the environment: darwin, real-host verification still pending.
    assert.match(matrixAdr, /darwin|macOS/);
    // "pending" (or an explicit "not verified") must actually appear — do NOT
    // allow the bare "unverified" alternation to satisfy this, since the
    // /UNVERIFIED/ assertion above already guarantees that word. This keeps the
    // named property (macOS status recorded as PENDING) genuinely enforced.
    assert.match(matrixAdr, /pending|not (yet )?verified/i);
    // Must not claim, within a single clause, that real Windows is
    // verified/passed/confirmed. Stops at a comma so honest negations
    // ("real-Windows gap ... not passed") are allowed while a bare false
    // claim ("real Windows support verified") is still caught.
    assert.doesNotMatch(
      matrixAdr,
      /real[- ]windows[^,.\n]*\b(verified|passed|confirmed)\b/i,
    );
  });

  it("declares the matrix is carried into the final integration ticket, not silently closed", () => {
    // Bind to the actual clause (matrix carried into the integration ticket,
    // gap recorded as pending), not any stray occurrence of "integration".
    assert.match(
      matrixAdr,
      /references this matrix and records[\s\S]*?verification gap[\s\S]*?\bpending\b/i,
    );
  });

  it("carries a committed final-integration record that back-references the matrix ADR and keeps the real-Windows gap pending", () => {
    // AC#2 + AC#3: ADR-0053 forward-references "the final integration ticket";
    // this is that ticket's durable committed artifact. It must cite 0053 so
    // the matrix link is navigable both ways (planning scratch under issues/ is
    // never committed), and it must record the real-Windows verification status
    // as pending — never as a passed check.
    const record = readFileSync(
      join(
        repoRoot,
        "docs",
        "research",
        "t27-windows-real-host-verification.md",
      ),
      "utf8",
    );
    // Back-reference completes the bidirectional link to the matrix ADR.
    assert.match(
      record,
      /0053/,
      "the final-integration record must cite ADR-0053 so the matrix link is bidirectional",
    );
    // The real-Windows verification status is recorded as pending.
    assert.match(
      record,
      /real[- ]windows[\s\S]*?verification[\s\S]*?\bpending\b/i,
      "the record must state the real-Windows verification status as pending",
    );
    // Comma/period/newline-bounded honesty guard (mirrors the ADR test): no
    // single clause may claim real Windows is verified/passed/confirmed. Honest
    // negations after a comma ("... pending, not passed") remain allowed.
    assert.doesNotMatch(
      record,
      /real[- ]windows[^,.\n]*\b(verified|passed|confirmed)\b/i,
    );
  });

  for (const relPath of REAL_HOST_MARKED_FILES) {
    it(`marks the real-host code path in ${relPath} UNVERIFIED and points to the matrix`, () => {
      const source = readFileSync(join(repoRoot, relPath), "utf8");
      assert.match(
        source,
        /UNVERIFIED\(real-windows-host\)/,
        `${relPath} must carry an UNVERIFIED(real-windows-host) marker on its real-Windows-only path`,
      );
      assert.match(
        source,
        /0053/,
        `${relPath}'s UNVERIFIED marker must cross-reference the matrix ADR (0053) so the marker and doc cannot drift apart`,
      );
    });
  }
});
