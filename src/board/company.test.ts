import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCompanyView } from "./company.js";

describe("getCompanyView", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "company-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the company after the host repository directory", () => {
    const view = getCompanyView(dir);
    expect(view.name).toBe(basename(dir));
  });

  it("lists the Software R&D department as the only operational department", () => {
    const view = getCompanyView(dir);
    const operational = view.departments.filter((d) => d.operational);
    expect(operational).toHaveLength(1);
    expect(operational[0]!.id).toBe("software-rnd");
    expect(view.departments.length).toBeGreaterThan(1);
    for (const placeholder of view.departments.filter((d) => !d.operational)) {
      expect(placeholder.id).not.toBe("software-rnd");
    }
  });

  it("returns no projects when workspace.json is missing", () => {
    expect(getCompanyView(dir).projects).toEqual([]);
  });

  it("projects workspace.json repositories as company projects", () => {
    mkdirSync(join(dir, ".sandcastle"), { recursive: true });
    writeFileSync(
      join(dir, ".sandcastle", "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "api", cwd: ".", kind: "backend" },
          { name: "web", cwd: "../web", description: "frontend app" },
        ],
      }),
    );
    expect(getCompanyView(dir).projects).toEqual([
      { name: "api", cwd: ".", kind: "backend" },
      { name: "web", cwd: "../web", description: "frontend app" },
    ]);
  });

  it("tolerates an unreadable workspace.json instead of failing the company view", () => {
    mkdirSync(join(dir, ".sandcastle"), { recursive: true });
    writeFileSync(join(dir, ".sandcastle", "workspace.json"), "{ broken");
    expect(getCompanyView(dir).projects).toEqual([]);
  });
});
