import { describe, expect, it } from "vitest";
import {
  AgentError,
  AgentIdleTimeoutError,
  DockerError,
  ExecError,
  WorktreeError,
} from "./errors.js";
import { StructuredOutputError } from "./Output.js";
import {
  buildRunFailureRecovery,
  classifyRunFailure,
  isInfrastructureFailureMessage,
} from "./RunFailureEvidence.js";

describe("classifyRunFailure", () => {
  it("classifies sandbox/host errors as infrastructure", () => {
    expect(
      classifyRunFailure(new DockerError({ message: "boom" })),
    ).toMatchObject({ failureKind: "infrastructure" });
    expect(
      classifyRunFailure(new WorktreeError({ message: "worktree boom" })),
    ).toMatchObject({ failureKind: "infrastructure" });
  });

  it("classifies agent process failures as agent", () => {
    expect(
      classifyRunFailure(new AgentError({ message: "exit 1" })),
    ).toMatchObject({ failureKind: "agent", failurePhase: "agent" });
    expect(
      classifyRunFailure(
        new AgentIdleTimeoutError({ message: "idle", timeoutMs: 1000 }),
      ),
    ).toMatchObject({ failureKind: "agent" });
  });

  it("classifies structured-output failures as task", () => {
    const error = new StructuredOutputError("bad output", {
      tag: "result",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    expect(classifyRunFailure(error)).toMatchObject({ failureKind: "task" });
  });

  it("falls back to unknown for unclassified errors", () => {
    expect(classifyRunFailure(new Error("mystery"))).toMatchObject({
      failureKind: "unknown",
    });
    expect(classifyRunFailure("not even an error")).toMatchObject({
      failureKind: "unknown",
    });
  });

  it("uses the infrastructure message signal when the tag is unknown", () => {
    // A generic Error whose message matches the missing-image signal.
    expect(
      classifyRunFailure(
        new Error(
          "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally. Build it first with 'sandcastle docker build-image'.",
        ),
      ),
    ).toMatchObject({ failureKind: "infrastructure" });
  });
});

describe("isInfrastructureFailureMessage", () => {
  it("matches the missing-image and create-failed signals", () => {
    expect(
      isInfrastructureFailureMessage(
        "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally.",
      ),
    ).toBe(true);
    expect(
      isInfrastructureFailureMessage(
        "Image 'x' not found locally. Build it first",
      ),
    ).toBe(true);
  });

  it("does not match ordinary task failures", () => {
    expect(isInfrastructureFailureMessage("agent exited with code 1")).toBe(
      false,
    );
    expect(isInfrastructureFailureMessage("")).toBe(false);
  });
});

describe("buildRunFailureRecovery", () => {
  it("gathers evidence carried on the error", () => {
    const error = new AgentError({
      message: "exit 1",
      preservedWorktreePath: "/tmp/wt",
    });
    const recovery = buildRunFailureRecovery(error, {});
    expect(recovery).toMatchObject({
      failureKind: "agent",
      failurePhase: "agent",
      preservedWorktreePath: "/tmp/wt",
    });
  });

  it("gathers session evidence from structured-output errors", () => {
    const error = new StructuredOutputError("bad output", {
      tag: "result",
      rawMatched: undefined,
      commits: [{ sha: "abc123" }],
      branch: "main",
      preservedWorktreePath: "/tmp/wt2",
      sessionId: "sess-1",
      sessionFilePath: "/tmp/sess-1.jsonl",
    });
    const recovery = buildRunFailureRecovery(error, {});
    expect(recovery).toMatchObject({
      failureKind: "task",
      preservedWorktreePath: "/tmp/wt2",
      sessionId: "sess-1",
      sessionFilePath: "/tmp/sess-1.jsonl",
    });
  });

  it("merges emit-site context and prefers error-carried worktree path", () => {
    const error = new ExecError({ command: "agent", message: "exec failed" });
    const recovery = buildRunFailureRecovery(error, {
      runLogPath: "/logs/run.log",
      sessionId: "sess-ctx",
      completionSignalSeen: true,
      commits: ["c1", "c2"],
      preservedWorktreePath: "/tmp/ctx-wt",
    });
    expect(recovery).toMatchObject({
      runLogPath: "/logs/run.log",
      sessionId: "sess-ctx",
      completionSignalSeen: true,
      commits: ["c1", "c2"],
      preservedWorktreePath: "/tmp/ctx-wt",
    });
  });

  it("omits undefined optional fields (stays JSON-minimal)", () => {
    const recovery = buildRunFailureRecovery(new Error("mystery"), {});
    expect(recovery).toEqual({ failureKind: "unknown" });
    expect("preservedWorktreePath" in recovery).toBe(false);
    expect("sessionId" in recovery).toBe(false);
  });
});
