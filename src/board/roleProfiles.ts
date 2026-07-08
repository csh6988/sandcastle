import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardRole } from "./BoardStore.js";

/**
 * The explicit configuration behind a **Board role** (ADR 0026): its
 * responsibility boundary, allowed and forbidden actions, selected **skill
 * flows**, optional extra prompt guidance, and optional agent/model
 * preferences. Role profiles belong to the Software R&D department, not to an
 * agent provider — any agent can fill the same role.
 */
export interface RoleProfile {
  readonly role: BoardRole;
  readonly label: string;
  /** One-sentence responsibility boundary for the role. */
  readonly responsibility: string;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions: readonly string[];
  /**
   * Named skill flows the role should load progressively via
   * `.sandcastle/SKILL_ROUTER.md`. Never expands to "load every skill".
   */
  readonly skillFlows: readonly string[];
  /** Extra prompt guidance appended after the structured boundary section. */
  readonly promptGuidance?: string;
  /** Advisory agent-provider preference (not enforced in v1). */
  readonly agent?: string;
  /** Advisory model preference (not enforced in v1). */
  readonly model?: string;
}

export type RoleProfiles = Record<BoardRole, RoleProfile>;

export const ROLE_PROFILES_FILENAME = "role-profiles.json";

export const DEFAULT_ROLE_PROFILES: RoleProfiles = {
  planner: {
    role: "planner",
    label: "Planner",
    responsibility:
      "Turn requirements into an aligned PRD understanding, a technical plan, a workspace plan, and Board issues ready for human approval.",
    allowedActions: [
      "read repository docs, code, and project guidance to understand scope",
      "collaborate with the user during interactive planning phases",
      "produce alignment notes, technical plans, workspace plans, and Board issues",
    ],
    forbiddenActions: [
      "implement the task or edit source files",
      "start repository execution",
      "commit changes",
    ],
    skillFlows: ["grill-with-docs", "to-prd", "to-issues", "domain-modeling"],
  },
  generator: {
    role: "generator",
    label: "Generator",
    responsibility:
      "Execute only the approved workspace plan inside sandboxed repository runs and deliver committed, verifiable work.",
    allowedActions: [
      "implement the approved repository issues",
      "run the project's verification commands",
      "commit completed repository work",
    ],
    forbiddenActions: [
      "re-plan or regenerate Board issues",
      "expand scope beyond the approved plan",
      "skip approval gates",
    ],
    skillFlows: ["tdd", "diagnosing-bugs", "resolving-merge-conflicts"],
  },
  evaluator: {
    role: "evaluator",
    label: "Evaluator",
    responsibility:
      "Verify delivery against the approved plan and recorded evidence, and write the Board verification report.",
    allowedActions: [
      "read the PRD, approved plan, progress document, runtime events, commits, and deterministic evidence",
      "judge delivery status and write or enrich the Board verification report",
    ],
    forbiddenActions: [
      "plan or re-plan",
      "implement or edit files",
      "run implementation commands",
      "commit changes",
    ],
    skillFlows: ["review"],
  },
};

const OVERRIDABLE_FIELDS = [
  "label",
  "responsibility",
  "allowedActions",
  "forbiddenActions",
  "skillFlows",
  "promptGuidance",
  "agent",
  "model",
] as const;

type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const validOverrideValue = (
  field: OverridableField,
  value: unknown,
): boolean =>
  field === "allowedActions" ||
  field === "forbiddenActions" ||
  field === "skillFlows"
    ? isStringArray(value)
    : typeof value === "string";

const mergeProfile = (
  role: BoardRole,
  base: RoleProfile,
  override: unknown,
): RoleProfile => {
  if (typeof override !== "object" || override === null) {
    throw new Error(
      `Invalid ${ROLE_PROFILES_FILENAME}: the "${role}" entry must be an object.`,
    );
  }
  const record = override as Record<string, unknown>;
  let merged: RoleProfile = base;
  for (const field of OVERRIDABLE_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (!validOverrideValue(field, value)) {
      throw new Error(
        `Invalid ${ROLE_PROFILES_FILENAME}: "${role}.${field}" has the wrong type.`,
      );
    }
    merged = { ...merged, [field]: value };
  }
  return merged;
};

/**
 * Load role profiles from `<configDir>/role-profiles.json`, merging partial
 * per-role overrides onto {@link DEFAULT_ROLE_PROFILES}. A missing file
 * returns the defaults; an invalid file fails fast with a descriptive error
 * (ADR 0020 fail-fast precedent). Unknown role keys are ignored so the file
 * stays forward-compatible with future departments.
 */
export const loadRoleProfiles = (configDir: string): RoleProfiles => {
  const path = join(configDir, ROLE_PROFILES_FILENAME);
  if (!existsSync(path)) return DEFAULT_ROLE_PROFILES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid ${ROLE_PROFILES_FILENAME} at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Invalid ${ROLE_PROFILES_FILENAME} at ${path}: expected a JSON object keyed by board role.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  return {
    planner:
      record.planner !== undefined
        ? mergeProfile("planner", DEFAULT_ROLE_PROFILES.planner, record.planner)
        : DEFAULT_ROLE_PROFILES.planner,
    generator:
      record.generator !== undefined
        ? mergeProfile(
            "generator",
            DEFAULT_ROLE_PROFILES.generator,
            record.generator,
          )
        : DEFAULT_ROLE_PROFILES.generator,
    evaluator:
      record.evaluator !== undefined
        ? mergeProfile(
            "evaluator",
            DEFAULT_ROLE_PROFILES.evaluator,
            record.evaluator,
          )
        : DEFAULT_ROLE_PROFILES.evaluator,
  };
};

/**
 * Render a role profile as the prompt section injected into agent prompts.
 * The first line is the stable role-boundary sentence existing prompts and
 * tests already rely on; the structured lines and progressive skill-flow
 * instruction follow it.
 */
export const renderRoleProfilePromptSection = (
  profile: RoleProfile,
): string => {
  const lines = [
    `Board role: ${profile.label}. Stay inside the ${profile.label} responsibility boundary.`,
    `Responsibility: ${profile.responsibility}`,
    `Allowed actions: ${profile.allowedActions.join("; ")}.`,
    `Do not: ${profile.forbiddenActions.join("; ")}.`,
    `Skill flows: consult .sandcastle/SKILL_ROUTER.md and progressively load only these skill flows when the matching work starts: ${profile.skillFlows.join(", ")}. Do not copy every installed skill into this session.`,
  ];
  if (profile.promptGuidance) lines.push(profile.promptGuidance);
  return lines.join("\n");
};
