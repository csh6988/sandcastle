import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-skill-discovery-company-"));

describe("Skill Discovery", () => {
  it("discovers SKILL.md metadata and stores only a stable reference and fingerprint", async () => {
    const sourceDirectory = mkdtempSync(
      join(tmpdir(), "sandcastle-skill-discovery-source-"),
    );
    const skillDirectory = join(sourceDirectory, "local-review");
    mkdirSync(skillDirectory);
    const content = `---\nname: Local Review\ndescription: Reviews a change without modifying the repository.\n---\n\nDo not persist this body.\n`;
    const skillPath = join(skillDirectory, "SKILL.md");
    writeFileSync(skillPath, content);
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const catalog = await database.skillCatalog.discover({
        directories: [sourceDirectory],
      });
      const discovered = catalog.skills.find(
        (skill) => skill.locationReference === skillPath,
      );
      assert.ok(discovered);
      assert.equal(discovered.id.startsWith("local-"), true);
      assert.equal(discovered.name, "Local Review");
      assert.equal(
        discovered.description,
        "Reviews a change without modifying the repository.",
      );
      assert.equal(discovered.sourceDirectory, sourceDirectory);
      assert.equal(
        discovered.version,
        `sha256:${createHash("sha256").update(content).digest("hex")}`,
      );
      assert.equal(discovered.status, "discovered");
      assert.equal("content" in discovered, false);

      const enabled = await database.skillCatalog.enable(discovered.id);
      assert.equal(
        enabled.skills.find((skill) => skill.id === discovered.id)?.status,
        "enabled",
      );
      const archived = await database.skillCatalog.archive(discovered.id);
      assert.equal(
        archived.skills.find((skill) => skill.id === discovered.id)?.status,
        "archived",
      );
    } finally {
      database.close();
    }
  });
});
