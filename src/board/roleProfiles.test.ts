import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_PROFILES,
  loadRoleProfiles,
  renderRoleProfilePromptSection,
} from "./roleProfiles.js";

describe("DEFAULT_ROLE_PROFILES", () => {
  it("defines a profile for each board role", () => {
    expect(Object.keys(DEFAULT_ROLE_PROFILES).sort()).toEqual([
      "evaluator",
      "generator",
      "planner",
    ]);
    for (const profile of Object.values(DEFAULT_ROLE_PROFILES)) {
      expect(profile.responsibility.length).toBeGreaterThan(0);
      expect(profile.allowedActions.length).toBeGreaterThan(0);
      expect(profile.forbiddenActions.length).toBeGreaterThan(0);
      expect(profile.skillFlows.length).toBeGreaterThan(0);
    }
  });

  it("keeps the strict role boundaries", () => {
    expect(DEFAULT_ROLE_PROFILES.planner.forbiddenActions.join(" ")).toMatch(
      /implement/i,
    );
    expect(DEFAULT_ROLE_PROFILES.generator.forbiddenActions.join(" ")).toMatch(
      /re-plan/i,
    );
    expect(DEFAULT_ROLE_PROFILES.evaluator.forbiddenActions.join(" ")).toMatch(
      /implement/i,
    );
  });
});

describe("renderRoleProfilePromptSection", () => {
  it("starts with the stable role boundary line", () => {
    const section = renderRoleProfilePromptSection(
      DEFAULT_ROLE_PROFILES.planner,
    );
    expect(section.startsWith("Board role: Planner.")).toBe(true);
    expect(section).toContain(
      "Stay inside the Planner responsibility boundary",
    );
  });

  it("instructs progressive skill-flow loading instead of loading everything", () => {
    const section = renderRoleProfilePromptSection(
      DEFAULT_ROLE_PROFILES.generator,
    );
    for (const flow of DEFAULT_ROLE_PROFILES.generator.skillFlows) {
      expect(section).toContain(flow);
    }
    expect(section).toMatch(/do not (copy|load) every/i);
  });

  it("includes responsibility, allowed actions, and forbidden actions", () => {
    const section = renderRoleProfilePromptSection(
      DEFAULT_ROLE_PROFILES.evaluator,
    );
    expect(section).toContain(DEFAULT_ROLE_PROFILES.evaluator.responsibility);
    expect(section).toContain("Allowed actions:");
    expect(section).toContain("Do not:");
  });

  it("appends custom prompt guidance when present", () => {
    const section = renderRoleProfilePromptSection({
      ...DEFAULT_ROLE_PROFILES.planner,
      promptGuidance: "Always ask about non-goals first.",
    });
    expect(section).toContain("Always ask about non-goals first.");
  });
});

describe("loadRoleProfiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "role-profiles-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the defaults when no config file exists", () => {
    expect(loadRoleProfiles(dir)).toEqual(DEFAULT_ROLE_PROFILES);
  });

  it("merges partial per-role overrides onto the defaults", () => {
    writeFileSync(
      join(dir, "role-profiles.json"),
      JSON.stringify({
        planner: {
          skillFlows: ["grill-with-docs"],
          model: "claude-opus-4-8",
        },
      }),
    );
    const profiles = loadRoleProfiles(dir);
    expect(profiles.planner.skillFlows).toEqual(["grill-with-docs"]);
    expect(profiles.planner.model).toBe("claude-opus-4-8");
    expect(profiles.planner.responsibility).toBe(
      DEFAULT_ROLE_PROFILES.planner.responsibility,
    );
    expect(profiles.generator).toEqual(DEFAULT_ROLE_PROFILES.generator);
    expect(profiles.evaluator).toEqual(DEFAULT_ROLE_PROFILES.evaluator);
  });

  it("ignores unknown role keys", () => {
    writeFileSync(
      join(dir, "role-profiles.json"),
      JSON.stringify({ marketing: { skillFlows: ["seo"] } }),
    );
    expect(loadRoleProfiles(dir)).toEqual(DEFAULT_ROLE_PROFILES);
  });

  it("fails fast on invalid JSON", () => {
    writeFileSync(join(dir, "role-profiles.json"), "{ not json");
    expect(() => loadRoleProfiles(dir)).toThrow(/role-profiles\.json/);
  });

  it("fails fast when a role override is not an object", () => {
    writeFileSync(
      join(dir, "role-profiles.json"),
      JSON.stringify({ planner: "loose text" }),
    );
    expect(() => loadRoleProfiles(dir)).toThrow(/planner/);
  });
});
