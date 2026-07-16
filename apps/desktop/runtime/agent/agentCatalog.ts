import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

export type AgentCapability =
  | "non-interactive"
  | "structured-output"
  | "session-resume";

export type AgentDetectionStatus =
  | "installed"
  | "not-installed"
  | "detection-failed";

export interface AgentCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly status: AgentDetectionStatus;
  readonly version: string | null;
  readonly executablePath: string | null;
  readonly lastDetectedAt: string;
  readonly capabilities: readonly AgentCapability[];
  readonly errorCode: string | null;
}

export interface AgentCatalogView {
  readonly agents: readonly AgentCatalogEntry[];
}

export interface AgentTestResult {
  readonly agentId: string;
  readonly status: "passed" | "failed";
  readonly testedAt: string;
  readonly summary: string;
}

export class AgentCatalogError extends Error {
  constructor(
    readonly code:
      | "AGENT_NOT_FOUND"
      | "AGENT_UNAVAILABLE"
      | "AGENT_TEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "AgentCatalogError";
  }
}

export interface AgentHostResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LocalAgentHost {
  readonly resolveExecutable: (
    executableNames: readonly string[],
  ) => Promise<string | null>;
  readonly run: (input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
    readonly stdin?: string;
  }) => Promise<AgentHostResult>;
}

interface CompanyAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly executableNames: readonly string[];
  readonly capabilities: readonly AgentCapability[];
  readonly versionArgs: readonly string[];
  readonly testArgs: readonly string[];
  readonly testStdin?: string;
}

const SAFE_PROBE_PROMPT = "Reply with OK only.";

const registeredAdapters: readonly CompanyAgentAdapter[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    executableNames: ["claude"],
    capabilities: ["non-interactive", "structured-output", "session-resume"],
    versionArgs: ["--version"],
    testArgs: [
      "--print",
      "--output-format",
      "text",
      "--no-session-persistence",
      "-p",
      "-",
    ],
    testStdin: SAFE_PROBE_PROMPT,
  },
  {
    id: "codex",
    name: "Codex",
    executableNames: ["codex"],
    capabilities: ["non-interactive", "structured-output", "session-resume"],
    versionArgs: ["--version"],
    testArgs: [
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "-",
    ],
    testStdin: SAFE_PROBE_PROMPT,
  },
  {
    id: "pi-agent",
    name: "Pi Agent",
    executableNames: ["pi"],
    capabilities: ["non-interactive", "session-resume"],
    versionArgs: ["--version"],
    testArgs: ["-p", "--mode", "json", "--no-session"],
    testStdin: SAFE_PROBE_PROMPT,
  },
  {
    id: "codem",
    name: "Codem",
    executableNames: ["codem"],
    capabilities: ["non-interactive"],
    versionArgs: ["--version"],
    testArgs: ["--help"],
  },
  {
    id: "hermes",
    name: "Hermes",
    executableNames: ["hermes"],
    capabilities: ["non-interactive", "session-resume"],
    versionArgs: ["--version"],
    testArgs: ["--help"],
  },
];

export const isRegisteredCompanyAgentId = (agentId: string): boolean =>
  registeredAdapters.some((adapter) => adapter.id === agentId);

const executableCandidates = (name: string): readonly string[] =>
  process.platform === "win32"
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];

export const createLocalAgentHost = (): LocalAgentHost => ({
  resolveExecutable: async (executableNames) => {
    const directories = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((directory) => directory.length > 0);
    for (const name of executableNames) {
      for (const directory of directories) {
        for (const candidate of executableCandidates(name)) {
          const path = join(directory, candidate);
          try {
            await access(path, constants.X_OK);
            return path;
          } catch {
            // Continue through the registered executable names and PATH entries.
          }
        }
      }
    }
    return null;
  },
  run: ({ executablePath, args, timeoutMs, stdin }) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executablePath,
        [...args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({
            exitCode: error && typeof error.code === "number" ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    }),
});

const versionFromOutput = (output: string): string | null =>
  output.match(/\b\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;

export interface AgentCatalog {
  readonly inspect: () => AgentCatalogView;
  readonly discover: () => Promise<AgentCatalogView>;
  readonly test: (agentId: string) => Promise<AgentTestResult>;
}

export const openAgentCatalog = (
  database: DatabaseSync,
  options: {
    readonly host?: LocalAgentHost;
    readonly clock?: () => Date;
  } = {},
): AgentCatalog => {
  const host = options.host ?? createLocalAgentHost();
  const clock = options.clock ?? (() => new Date());

  const inspect = (): AgentCatalogView => {
    const rows = database
      .prepare(
        `SELECT adapter_id AS adapterId, status, version,
                executable_path AS executablePath,
                last_detected_at AS lastDetectedAt, error_code AS errorCode
           FROM agent_detection_results`,
      )
      .all() as Array<{
      readonly adapterId: string;
      readonly status: AgentDetectionStatus;
      readonly version: string | null;
      readonly executablePath: string | null;
      readonly lastDetectedAt: string;
      readonly errorCode: string | null;
    }>;
    const detected = new Map(rows.map((row) => [row.adapterId, row]));
    return {
      agents: registeredAdapters.map((adapter) => {
        const result = detected.get(adapter.id);
        return {
          id: adapter.id,
          name: adapter.name,
          status: result?.status ?? "not-installed",
          version: result?.version ?? null,
          executablePath: result?.executablePath ?? null,
          lastDetectedAt: result?.lastDetectedAt ?? clock().toISOString(),
          capabilities: adapter.capabilities,
          errorCode: result?.errorCode ?? null,
        };
      }),
    };
  };

  return {
    inspect,
    test: async (agentId) => {
      const adapter = registeredAdapters.find(
        (candidate) => candidate.id === agentId,
      );
      if (!adapter) {
        throw new AgentCatalogError(
          "AGENT_NOT_FOUND",
          `Company Agent Adapter ${agentId} is not registered.`,
        );
      }
      const executablePath = await host.resolveExecutable(
        adapter.executableNames,
      );
      if (!executablePath) {
        throw new AgentCatalogError(
          "AGENT_UNAVAILABLE",
          `${adapter.name} is not installed.`,
        );
      }
      const result = await host.run({
        executablePath,
        args: adapter.testArgs,
        timeoutMs: adapter.testStdin ? 30_000 : 5_000,
        stdin: adapter.testStdin,
      });
      if (
        result.exitCode !== 0 ||
        (result.stdout.trim() === "" && result.stderr.trim() === "")
      ) {
        throw new AgentCatalogError(
          "AGENT_TEST_FAILED",
          `${adapter.name} did not pass its non-destructive test.`,
        );
      }
      return {
        agentId: adapter.id,
        status: "passed",
        testedAt: clock().toISOString(),
        summary: adapter.testStdin
          ? "Agent executable completed a safe non-interactive probe."
          : "Agent executable accepted a safe capability probe.",
      };
    },
    discover: async () => {
      const detectedAt = clock().toISOString();
      const save = database.prepare(
        `INSERT INTO agent_detection_results(
           adapter_id, status, version, executable_path,
           last_detected_at, error_code
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(adapter_id) DO UPDATE SET
           status = excluded.status,
           version = excluded.version,
           executable_path = excluded.executable_path,
           last_detected_at = excluded.last_detected_at,
           error_code = excluded.error_code`,
      );
      for (const adapter of registeredAdapters) {
        try {
          const executablePath = await host.resolveExecutable(
            adapter.executableNames,
          );
          if (!executablePath) {
            save.run(adapter.id, "not-installed", null, null, detectedAt, null);
            continue;
          }
          const result = await host.run({
            executablePath,
            args: adapter.versionArgs,
            timeoutMs: 5_000,
          });
          const output = `${result.stdout}\n${result.stderr}`;
          if (result.exitCode !== 0) {
            save.run(
              adapter.id,
              "detection-failed",
              null,
              executablePath,
              detectedAt,
              "VERSION_PROBE_FAILED",
            );
            continue;
          }
          save.run(
            adapter.id,
            "installed",
            versionFromOutput(output),
            executablePath,
            detectedAt,
            null,
          );
        } catch {
          save.run(
            adapter.id,
            "detection-failed",
            null,
            null,
            detectedAt,
            "DETECTION_FAILED",
          );
        }
      }
      return inspect();
    },
  };
};
