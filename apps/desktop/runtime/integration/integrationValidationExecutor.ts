import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  IntegrationValidationExecutor,
  IntegrationValidationInput,
  IntegrationValidationResult,
} from "./integrationNodeHandler.js";
import { prepareExactIntegrationWorkspace } from "./integrationWorkspaceGit.js";

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right),
          ),
        )
      : entry,
  );

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export type IntegrationValidationProviderResult =
  | {
      readonly status: "completed";
      readonly exitCode: number;
      readonly providerId: string;
      readonly providerOperationId: string;
      readonly terminalReceiptHash: string;
      readonly evidenceRefs: readonly string[];
      readonly output: string;
    }
  | {
      readonly status: "not-started";
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    };

export interface IntegrationValidationProvider {
  readonly execute: (input: {
    readonly operationKey: string;
    readonly repositoryReference: string;
    readonly workspaceRef: string;
    readonly integratedCommit: string;
    readonly commands: readonly (readonly string[])[];
    readonly timeoutMs: number;
    readonly onOperationStarted: (input: {
      readonly providerId: string;
      readonly providerOperationId: string;
      readonly evidenceRefs: readonly string[];
    }) => void;
  }) => Promise<IntegrationValidationProviderResult>;
  readonly inspect: (
    providerOperationId: string,
  ) => Promise<"running" | "not-running" | "not-found" | "unknown">;
  readonly cancel: (
    providerOperationId: string,
  ) => Promise<"cancelled" | "not-found" | "unknown">;
}

export const blockingIntegrationValidationProvider: IntegrationValidationProvider =
  {
    execute: async () => ({
      status: "not-started",
      code: "PROVIDER_ISOLATION_REQUIRED",
      message:
        "Integration validation requires a configured Docker-only isolated execution provider.",
      evidence: { sandboxRef: null },
    }),
    inspect: async () => "unknown",
    cancel: async () => "unknown",
  };

export const createSandcastleIntegrationValidationProvider = (runtime: {
  readonly executeIntegrationValidation?: IntegrationValidationProvider["execute"];
  readonly inspectIntegrationValidationOperation?: IntegrationValidationProvider["inspect"];
  readonly cancelIntegrationValidationOperation?: IntegrationValidationProvider["cancel"];
}): IntegrationValidationProvider => ({
  execute:
    runtime.executeIntegrationValidation ??
    blockingIntegrationValidationProvider.execute,
  inspect:
    runtime.inspectIntegrationValidationOperation ??
    blockingIntegrationValidationProvider.inspect,
  cancel:
    runtime.cancelIntegrationValidationOperation ??
    blockingIntegrationValidationProvider.cancel,
});

type DurableValidationRecord =
  | {
      readonly requestHash: string;
      readonly state: "intent";
    }
  | {
      readonly requestHash: string;
      readonly state: "executing";
      readonly fence: string;
    }
  | {
      readonly requestHash: string;
      readonly state: "started";
      readonly providerId: string;
      readonly providerOperationId: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly requestHash: string;
      readonly state: "completed";
      readonly result: IntegrationValidationResult;
    };

type DurableValidationClaim = {
  readonly requestHash: string;
  readonly fence: string;
};

type DurableValidationCompletion = {
  readonly requestHash: string;
  readonly recordHash: string;
};

type DurableRead<T> =
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly error: string }
  | { readonly status: "valid"; readonly value: T; readonly raw: string };

export const openIsolatedIntegrationValidationExecutor = (options: {
  readonly evidenceRoot: string;
  readonly provider?: IntegrationValidationProvider;
  readonly timeoutMs?: number;
  readonly workspaceGitTimeoutMs?: number;
  readonly gitExecutable?: string;
}): IntegrationValidationExecutor => {
  mkdirSync(options.evidenceRoot, { recursive: true, mode: 0o700 });
  const provider = options.provider ?? blockingIntegrationValidationProvider;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const workspaceGitTimeoutMs = options.workspaceGitTimeoutMs ?? 30_000;
  const activeWorkspacePreparations = new Map<string, AbortController>();

  const recordPath = (operationKey: string): string =>
    join(options.evidenceRoot, `${sha256(operationKey)}.json`);

  const claimPath = (operationKey: string): string =>
    join(options.evidenceRoot, `${sha256(operationKey)}.claim`);

  const completionPath = (operationKey: string): string =>
    join(options.evidenceRoot, `${sha256(operationKey)}.completed`);

  const requestHash = (input: IntegrationValidationInput): string =>
    sha256(canonicalJson(input));

  const readDurableJson = <T>(
    path: string,
    validate: (value: unknown) => value is T,
  ): DurableRead<T> => {
    try {
      const raw = readFileSync(path, "utf8");
      const value = JSON.parse(raw) as unknown;
      return validate(value)
        ? { status: "valid", value, raw }
        : { status: "corrupt", error: "stored JSON shape is invalid" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "corrupt", error: String(error) };
    }
  };

  const isRecord = (value: unknown): value is DurableValidationRecord => {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    if (
      typeof record.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.requestHash) ||
      typeof record.state !== "string"
    ) {
      return false;
    }
    if (record.state === "intent") return true;
    if (record.state === "executing") return typeof record.fence === "string";
    if (record.state === "started") {
      return (
        typeof record.providerId === "string" &&
        typeof record.providerOperationId === "string" &&
        Array.isArray(record.evidenceRefs) &&
        record.evidenceRefs.every((entry) => typeof entry === "string")
      );
    }
    if (record.state !== "completed") return false;
    if (typeof record.result !== "object" || record.result === null) {
      return false;
    }
    const result = record.result as Record<string, unknown>;
    if (result.status === "unknown") {
      return (
        typeof result.code === "string" && typeof result.message === "string"
      );
    }
    return (
      (result.status === "passed" || result.status === "failed") &&
      Array.isArray(result.evidenceRefs) &&
      result.evidenceRefs.every((entry) => typeof entry === "string") &&
      Array.isArray(result.responsibleWorkPackageVersionIds) &&
      result.responsibleWorkPackageVersionIds.every(
        (entry) => typeof entry === "string",
      )
    );
  };

  const isClaim = (value: unknown): value is DurableValidationClaim =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).requestHash === "string" &&
    /^[a-f0-9]{64}$/.test(
      (value as Record<string, unknown>).requestHash as string,
    ) &&
    typeof (value as Record<string, unknown>).fence === "string";

  const isCompletion = (value: unknown): value is DurableValidationCompletion =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).requestHash === "string" &&
    /^[a-f0-9]{64}$/.test(
      (value as Record<string, unknown>).requestHash as string,
    ) &&
    typeof (value as Record<string, unknown>).recordHash === "string" &&
    /^[a-f0-9]{64}$/.test(
      (value as Record<string, unknown>).recordHash as string,
    );

  const readRecord = (input: IntegrationValidationInput) =>
    readDurableJson(recordPath(input.operationKey), isRecord);

  const readClaim = (input: IntegrationValidationInput) =>
    readDurableJson(claimPath(input.operationKey), isClaim);

  const readCompletion = (input: IntegrationValidationInput) =>
    readDurableJson(completionPath(input.operationKey), isCompletion);

  const acquireClaim = (input: IntegrationValidationInput): string | null => {
    const fence = randomUUID();
    try {
      writeFileSync(
        claimPath(input.operationKey),
        canonicalJson({ requestHash: requestHash(input), fence }),
        { flag: "wx", mode: 0o600 },
      );
      return fence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  };

  const releaseClaim = (input: IntegrationValidationInput): void => {
    try {
      unlinkSync(claimPath(input.operationKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const persistRecord = (
    input: IntegrationValidationInput,
    record: DurableValidationRecord,
  ): string => {
    const target = recordPath(input.operationKey);
    const temporary = `${target}.tmp`;
    const raw = canonicalJson(record);
    writeFileSync(temporary, raw, { mode: 0o600 });
    renameSync(temporary, target);
    return sha256(raw);
  };

  const persistCompletion = (
    input: IntegrationValidationInput,
    recordHash: string,
  ): void => {
    const target = completionPath(input.operationKey);
    const temporary = `${target}.tmp`;
    writeFileSync(
      temporary,
      canonicalJson({ requestHash: requestHash(input), recordHash }),
      { mode: 0o600 },
    );
    renameSync(temporary, target);
  };

  const prepareWorkspace = async (
    input: IntegrationValidationInput,
  ): Promise<string> => {
    const workspace = join(
      options.evidenceRoot,
      `workspace-${sha256(input.operationKey)}`,
    );
    const controller = new AbortController();
    activeWorkspacePreparations.set(input.operationKey, controller);
    try {
      await prepareExactIntegrationWorkspace({
        repositoryReference: input.repositoryReference,
        commit: input.integratedCommit,
        workspace,
        timeoutMs: workspaceGitTimeoutMs,
        signal: controller.signal,
        ...(options.gitExecutable
          ? { gitExecutable: options.gitExecutable }
          : {}),
      });
    } finally {
      if (activeWorkspacePreparations.get(input.operationKey) === controller) {
        activeWorkspacePreparations.delete(input.operationKey);
      }
    }
    const makeReadOnly = (path: string): void => {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) return;
      if (entry.isDirectory()) {
        for (const child of readdirSync(path)) {
          makeReadOnly(join(path, child));
        }
        chmodSync(path, entry.mode & 0o555);
        return;
      }
      chmodSync(path, entry.mode & 0o555);
    };
    makeReadOnly(workspace);
    return workspace;
  };

  const conflict = (input: IntegrationValidationInput) => ({
    status: "unknown" as const,
    code: "INTEGRATION_VALIDATION_CONFLICT",
    message: "Validation operation identity was reused with changed input.",
    evidence: { operationKey: input.operationKey },
  });

  const reconcile = async (
    input: IntegrationValidationInput,
  ): Promise<IntegrationValidationResult> => {
    const recordRead = readRecord(input);
    const claimRead = readClaim(input);
    const completionRead = readCompletion(input);
    if (recordRead.status === "corrupt") {
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message:
          "The durable validation record is corrupt; the command will not be reissued.",
        evidence: { error: recordRead.error },
      };
    }
    if (completionRead.status === "corrupt") {
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message:
          "The durable validation completion fence is corrupt; the command will not be reissued.",
        evidence: { error: completionRead.error },
      };
    }
    if (claimRead.status === "corrupt") {
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message:
          "The durable validation execution claim is corrupt; the command will not be reissued.",
        evidence: { error: claimRead.error },
      };
    }
    const claim = claimRead.status === "valid" ? claimRead.value : null;
    const completion =
      completionRead.status === "valid" ? completionRead.value : null;
    if (recordRead.status === "missing") {
      if (completion) {
        if (completion.requestHash !== requestHash(input)) {
          return conflict(input);
        }
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message:
            "The terminal validation receipt is missing behind a durable completion fence; the command will not be reissued.",
          evidence: { recordHash: completion.recordHash },
        };
      }
      if (!claim) return { status: "not-applied" };
      if (claim.requestHash !== requestHash(input)) return conflict(input);
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message:
          "Validation execution was claimed before a provider receipt was durably recorded; the command will not be reissued.",
        evidence: { fence: claim.fence },
      };
    }
    const record = recordRead.value;
    if (record.requestHash !== requestHash(input)) return conflict(input);
    if (record.state === "completed") {
      if (
        completion &&
        (completion.requestHash !== record.requestHash ||
          completion.recordHash !== sha256(recordRead.raw))
      ) {
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message:
            "The terminal validation receipt disagrees with its durable completion fence; the command will not be reissued.",
          evidence: {
            recordHash: sha256(recordRead.raw),
            completionRecordHash: completion.recordHash,
          },
        };
      }
      return record.result;
    }
    if (record.state === "intent" && !claim) return { status: "not-applied" };
    if (record.state === "intent" || record.state === "executing") {
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message:
          "Validation execution is durably fenced without a provider-started receipt; the command will not be reissued.",
        evidence: {
          fence: record.state === "executing" ? record.fence : claim?.fence,
        },
      };
    }
    const providerStatus = await provider.inspect(record.providerOperationId);
    return {
      status: "unknown",
      code: "RECONCILE_UNKNOWN",
      message:
        "Validation provider started without a durable terminal receipt; the command will not be reissued.",
      evidence: {
        providerId: record.providerId,
        providerOperationId: record.providerOperationId,
        providerStatus,
        evidenceRefs: record.evidenceRefs,
      },
    };
  };

  return {
    reconcile,
    cancel: async (input) => {
      activeWorkspacePreparations.get(input.operationKey)?.abort();
      const record = readRecord(input);
      if (record.status !== "valid" || record.value.state !== "started") {
        return reconcile(input);
      }
      const cancellation = await provider.cancel(
        record.value.providerOperationId,
      );
      const reconciled = await reconcile(input);
      if (reconciled.status !== "unknown") return reconciled;
      return {
        ...reconciled,
        evidence: {
          ...(typeof reconciled.evidence === "object" &&
          reconciled.evidence !== null
            ? reconciled.evidence
            : { reconciliationEvidence: reconciled.evidence }),
          cancellation,
        },
      };
    },
    execute: async (input) => {
      const reconciled = await reconcile(input);
      if (reconciled.status !== "not-applied") return reconciled;
      const fence = acquireClaim(input);
      if (!fence) {
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message:
            "Validation execution is already claimed; the command will not be reissued.",
          evidence: { operationKey: input.operationKey },
        };
      }
      persistRecord(input, {
        requestHash: requestHash(input),
        state: "executing",
        fence,
      });
      try {
        const result = await provider.execute({
          operationKey: input.operationKey,
          repositoryReference: input.repositoryReference,
          workspaceRef: await prepareWorkspace(input),
          integratedCommit: input.integratedCommit,
          commands: input.validation.commands,
          timeoutMs,
          onOperationStarted: (started) => {
            persistRecord(input, {
              requestHash: requestHash(input),
              state: "started",
              providerId: started.providerId,
              providerOperationId: started.providerOperationId,
              evidenceRefs: [...started.evidenceRefs],
            });
          },
        });
        if (result.status === "not-started") {
          const unknown: IntegrationValidationResult = {
            status: "unknown",
            code: result.code,
            message: result.message,
            evidence: result.evidence,
          };
          const completedRecordHash = persistRecord(input, {
            requestHash: requestHash(input),
            state: "completed",
            result: unknown,
          });
          persistCompletion(input, completedRecordHash);
          releaseClaim(input);
          return unknown;
        }
        const logPath = join(
          options.evidenceRoot,
          `${sha256(input.operationKey)}.log`,
        );
        writeFileSync(logPath, result.output, { mode: 0o600 });
        const evidenceRefs = [
          ...new Set([
            ...input.validation.evidenceRefs,
            ...result.evidenceRefs,
            logPath,
            `provider-terminal:${result.terminalReceiptHash}`,
          ]),
        ];
        const completed: IntegrationValidationResult = {
          status: result.exitCode === 0 ? "passed" : "failed",
          evidenceRefs,
          responsibleWorkPackageVersionIds:
            result.exitCode === 0
              ? []
              : [...input.responsibleWorkPackageVersionIds],
          ...(result.exitCode !== 0 && input.validation.kind === "contract"
            ? {
                contractFailure: {
                  producerApplicationId:
                    input.validation.contract!.producerApplicationId,
                  consumerApplicationId:
                    input.validation.contract!.consumerApplicationId,
                  contractId: input.validation.contract!.id,
                  contractVersion: input.validation.contract!.version,
                  fixtureRef: input.validation.evidenceRefs[0]!,
                  runtimeEvidenceRef: logPath,
                },
              }
            : {}),
        };
        const completedRecordHash = persistRecord(input, {
          requestHash: requestHash(input),
          state: "completed",
          result: completed,
        });
        persistCompletion(input, completedRecordHash);
        releaseClaim(input);
        return completed;
      } catch (error) {
        const record = readRecord(input);
        if (record.status === "valid" && record.value.state === "started") {
          return reconcile(input);
        }
        const unknown: IntegrationValidationResult = {
          status: "unknown",
          code: "INTEGRATION_VALIDATION_PROVIDER_FAILED",
          message:
            "The isolated validation provider failed before proving a terminal result.",
          evidence: { error: String(error) },
        };
        const completedRecordHash = persistRecord(input, {
          requestHash: requestHash(input),
          state: "completed",
          result: unknown,
        });
        persistCompletion(input, completedRecordHash);
        return unknown;
      }
    },
  };
};
