import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStartupSelection } from "../main/startup.js";

describe("resolveStartupSelection", () => {
  it("opens the configured company directory without auto-starting the old repository", () => {
    assert.deepEqual(
      resolveStartupSelection(
        {},
        {
          companyDir: "/company",
          repoDir: "/old-repo",
        },
      ),
      {
        companyDir: "/company",
        repoDir: undefined,
        needsCompanyPicker: false,
      },
    );
  });

  it("keeps repository startup behind an explicit environment override", () => {
    assert.deepEqual(
      resolveStartupSelection(
        {
          SANDCASTLE_DESKTOP_COMPANY_DIR: "/env-company",
          SANDCASTLE_DESKTOP_REPO: "/env-repo",
        },
        {},
      ),
      {
        companyDir: "/env-company",
        repoDir: "/env-repo",
        needsCompanyPicker: false,
      },
    );
  });

  it("asks for a company directory when none is known", () => {
    assert.deepEqual(resolveStartupSelection({}, {}), {
      companyDir: undefined,
      repoDir: undefined,
      needsCompanyPicker: true,
    });
  });
});
