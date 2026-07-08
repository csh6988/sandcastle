import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCompanyDirectory } from "./companyDirectory.js";

export interface SkillFlow {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly source: "built-in" | "custom";
}

export interface AiMember {
  readonly id: string;
  readonly name: string;
  readonly responsibility: string;
  readonly skillFlowIds: readonly string[];
}

export interface Department {
  readonly id: string;
  readonly name: string;
  readonly members: readonly AiMember[];
}

export interface CreateSkillFlowInput {
  readonly name: string;
  readonly skills: readonly string[];
}

export interface BindSkillFlowsInput {
  readonly departmentId: string;
  readonly memberId: string;
  readonly flowIds: readonly string[];
}

interface SkillFlowFile {
  readonly flows: readonly SkillFlow[];
}

interface RoleProfilesFile {
  readonly departments: readonly Department[];
}

const BUILT_IN_FLOWS: readonly SkillFlow[] = [
  {
    id: "planning-flow",
    name: "Planning Flow",
    skills: ["grill-with-docs", "domain-modeling", "decision-mapping"],
    source: "built-in",
  },
  {
    id: "implementation-flow",
    name: "Implementation Flow",
    skills: ["tdd"],
    source: "built-in",
  },
  {
    id: "review-flow",
    name: "Review Flow",
    skills: ["review"],
    source: "built-in",
  },
];

const DEFAULT_DEPARTMENTS: readonly Department[] = [
  {
    id: "software-rnd",
    name: "Software R&D",
    members: [
      {
        id: "planner",
        name: "Planner",
        responsibility: "Turns requirements into reviewed plans.",
        skillFlowIds: ["planning-flow"],
      },
      {
        id: "designer",
        name: "Designer",
        responsibility: "Shapes design input before R&D execution.",
        skillFlowIds: ["planning-flow"],
      },
      {
        id: "generator",
        name: "Generator",
        responsibility: "Executes approved R&D plans.",
        skillFlowIds: ["implementation-flow"],
      },
      {
        id: "evaluator",
        name: "Evaluator",
        responsibility: "Verifies delivery against recorded evidence.",
        skillFlowIds: ["review-flow"],
      },
    ],
  },
];

const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill-flow";
};

const skillFlowsPath = (companyDir: string): string =>
  join(companyDir, ".sandcastle", "skill-flows.json");

const roleProfilesPath = (companyDir: string): string =>
  join(companyDir, ".sandcastle", "role-profiles.json");

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const readCustomFlows = (companyDir: string): readonly SkillFlow[] =>
  readJson<SkillFlowFile>(skillFlowsPath(companyDir), { flows: [] }).flows;

const readDepartments = (companyDir: string): readonly Department[] => {
  const file = readJson<RoleProfilesFile>(roleProfilesPath(companyDir), {
    departments: [],
  });
  return file.departments.length > 0 ? file.departments : DEFAULT_DEPARTMENTS;
};

export const listSkillFlows = (companyDir: string): readonly SkillFlow[] => {
  ensureCompanyDirectory(companyDir);
  return [...BUILT_IN_FLOWS, ...readCustomFlows(companyDir)];
};

export const createSkillFlow = (
  companyDir: string,
  input: CreateSkillFlowInput,
): SkillFlow => {
  ensureCompanyDirectory(companyDir);
  const existing = readCustomFlows(companyDir);
  const flow: SkillFlow = {
    id: slugify(input.name),
    name: input.name,
    skills: input.skills,
    source: "custom",
  };
  writeJson(skillFlowsPath(companyDir), {
    flows: [...existing.filter((item) => item.id !== flow.id), flow],
  });
  return flow;
};

export const getDepartments = (companyDir: string): readonly Department[] => {
  ensureCompanyDirectory(companyDir);
  return readDepartments(companyDir);
};

export const bindSkillFlows = (
  companyDir: string,
  input: BindSkillFlowsInput,
): readonly Department[] => {
  ensureCompanyDirectory(companyDir);
  const departments = readDepartments(companyDir).map((department) =>
    department.id !== input.departmentId
      ? department
      : {
          ...department,
          members: department.members.map((member) =>
            member.id !== input.memberId
              ? member
              : { ...member, skillFlowIds: input.flowIds },
          ),
        },
  );
  writeJson(roleProfilesPath(companyDir), { departments });
  return departments;
};
