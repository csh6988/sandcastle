import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  InteractionSessionView,
  ProjectEditorView,
  SessionParticipantView,
} from "../interface.js";
import type { SandcastleExecutionRuntime } from "./sandcastleExecutionPort.js";

export interface InteractionExecutionInput {
  readonly session: InteractionSessionView;
  readonly project: ProjectEditorView;
  readonly aiParticipant: SessionParticipantView;
  readonly position: {
    readonly id: string;
    readonly name: string;
    readonly responsibility: string;
    readonly defaultAgentId: string;
    readonly aiMember: {
      readonly id: string;
      readonly displayName: string;
      readonly profile: string;
    };
  };
  readonly executionProfile: {
    readonly providerRef: string;
    readonly model: string;
    readonly sandboxRef: string;
    readonly limits: {
      readonly timeoutSeconds: number;
    };
  };
  readonly prompt: string;
}

export interface InteractionExecutionResult {
  readonly response: string;
}

export interface InteractionExecutionAdapter {
  readonly execute: (
    input: InteractionExecutionInput,
  ) => Promise<InteractionExecutionResult>;
}

const resolvedProvider = (
  position: InteractionExecutionInput["position"],
  providerRef: string,
): string =>
  providerRef === "default-agent" ? position.defaultAgentId : providerRef;

const resolvedModel = (providerRef: string, model: string): string => {
  if (model !== "default") return model;
  if (providerRef === "codex") return "x5/gpt-5.5";
  if (providerRef === "claude-code") return "claude-opus-4-8";
  return model;
};

const gitRootFor = (repositoryReference: string): string => {
  const original = resolve(repositoryReference);
  let candidate = original;
  while (true) {
    if (existsSync(join(candidate, ".git"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return original;
    candidate = parent;
  }
};

const consultationPrompt = (input: InteractionExecutionInput): string =>
  `# Sandcastle AI Member Consultation

Project: ${input.project.name}
Project goal: ${input.project.goal}
Project context: ${input.project.sharedContext || "(none)"}
Position: ${input.position.name}
Position responsibility: ${input.position.responsibility}
AI Member: ${input.position.aiMember.displayName}
AI Member profile: ${input.position.aiMember.profile || "(none)"}

This is an informal consultation. Answer the user's message clearly and concisely. Do not edit files, run commands that change a repository, modify a Department Run, or create a formal Artifact. If the user asks for execution, explain the next explicit action they should take.

User message:
${input.prompt}`;

export const createSandcastleInteractionExecutionAdapter = (
  runtime: SandcastleExecutionRuntime,
): InteractionExecutionAdapter => ({
  execute: async (input) => {
    const profile = input.executionProfile;
    const repositories = input.project.repositoryReferences;
    const repositoryRoot = gitRootFor(repositories[0] ?? process.cwd());
    const providerRef = resolvedProvider(input.position, profile.providerRef);
    const result = await runtime.run({
      agent: runtime.resolveAgent(
        providerRef,
        resolvedModel(providerRef, profile.model),
        { captureSessions: false },
      ),
      sandbox: runtime.resolveSandbox(profile.sandboxRef),
      cwd: repositoryRoot,
      prompt: consultationPrompt(input),
      branchStrategy: {
        type: "branch",
        branch: `sandcastle/interaction/${input.session.id}`,
      },
      maxIterations: 1,
      idleTimeoutSeconds: profile.limits.timeoutSeconds,
      completionTimeoutSeconds: profile.limits.timeoutSeconds,
      name: `interaction:${input.position.aiMember.displayName}`,
    });
    const response = result.stdout?.trim() ?? "";
    if (!response) {
      throw new Error("Agent returned no response text.");
    }
    return { response };
  },
});
