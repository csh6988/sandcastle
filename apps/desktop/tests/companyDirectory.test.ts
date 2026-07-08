import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureCompanyDirectory } from "../main/companyDirectory.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-company-"));

describe("ensureCompanyDirectory", () => {
  it("creates the local AI company directory structure", () => {
    const companyDir = tempCompanyDir();

    const result = ensureCompanyDirectory(companyDir);

    assert.equal(result.companyDir, companyDir);
    assert.equal(result.projectsDir, join(companyDir, "projects"));
    assert.equal(result.sandcastleDir, join(companyDir, ".sandcastle"));
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(companyDir, ".sandcastle", "project-index.json"),
          "utf8",
        ),
      ),
      { projects: [] },
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(companyDir, ".sandcastle", "skill-flows.json"),
          "utf8",
        ),
      ),
      { flows: [] },
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(companyDir, ".sandcastle", "role-profiles.json"),
          "utf8",
        ),
      ),
      { departments: [] },
    );
  });

  it("does not overwrite existing company configuration", () => {
    const companyDir = tempCompanyDir();
    const existing = { projects: [{ id: "existing" }] };
    ensureCompanyDirectory(companyDir);
    writeFileSync(
      join(companyDir, ".sandcastle", "project-index.json"),
      `${JSON.stringify(existing, null, 2)}\n`,
    );

    ensureCompanyDirectory(companyDir);

    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(companyDir, ".sandcastle", "project-index.json"),
          "utf8",
        ),
      ),
      existing,
    );
  });
});
