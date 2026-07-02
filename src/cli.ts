import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execFileSync, execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import { ConfigDirError, InitError } from "./errors.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import type { RunEvent } from "./RunEvent.js";
import { run } from "./run.js";
import {
  executeWorkspaceTaskPlan,
  parseWorkspaceTaskPlan,
  runWorkspaceTask,
  type WorkspaceTaskPlan,
  type WorkspaceTaskRepositoryOptions,
  type WorkspaceTaskWorkspace,
} from "./runWorkspaceTask.js";
import { docker } from "./sandboxes/docker.js";
import { podman } from "./sandboxes/podman.js";
import { encodeProjectPath } from "./SessionStore.js";
import { VERSION } from "./version.js";
import {
  BoardStore,
  createRunRecorder,
  type BoardTaskRecord,
  type BoardTaskWorkflowPhase,
} from "./board/BoardStore.js";
import { startBoardServer } from "./board/server.js";
import { createTaskLauncher } from "./board/launchTask.js";
import { createLangGraphTaskWorkflow } from "./board/langGraphTaskRunner.js";
import { getBoardTaskBranchMergeContext } from "./board/taskBranchMerge.js";
import { createImportedWorkspacePlanTask } from "./board/workspacePlanImport.js";
import { createPrdFileBoardTask } from "./board/prdTask.js";
import {
  isPrdVisualAssetFile,
  isUnsupportedPrdDocumentFile,
  unsupportedPrdDocumentMessage,
} from "./board/prdAssets.js";
import { preparePrdAssetsForExecution } from "./board/prdExecutionAssets.js";
import {
  BoardTerminalManager,
  PHASE_COMPLETION_SIGNAL,
} from "./board/terminalSession.js";
import {
  sanitizePlanningArtifactSegment,
  writeWorkspacePlanningArtifacts,
  type WorkspacePlanningArtifacts,
} from "./board/planningArtifacts.js";
import { exportApprovedBoardPlan } from "./board/approvedPlanExport.js";
import {
  BOARD_EVALUATOR_REPO,
  runBoardEvaluatorAgent,
} from "./board/taskEvaluator.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Agent factory registry (by InitService factoryImport name) ---

type AgentFactory = (
  model: string,
  options?: { env?: Record<string, string> },
) => AgentProvider;

const AGENT_FACTORY_BY_NAME: Record<string, AgentFactory> = {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
};

/**
 * Build an agent provider from an InitService agent entry (its `factoryImport`
 * names one of the exported factories). Used by `init --plan` so the planner
 * runs with the same agent the user selected during init.
 */
const buildAgentFromEntry = (
  entry: AgentEntry,
  model: string,
  env: Record<string, string>,
): AgentProvider => {
  const factory = AGENT_FACTORY_BY_NAME[entry.factoryImport];
  if (!factory) {
    throw new InitError({
      message: `No agent factory registered for "${entry.factoryImport}".`,
    });
  }
  return factory(model, { env });
};

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
        }),
      );
    }
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. claude-code)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model",
  ),
  Options.optional,
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription("Sandbox provider to use (e.g. docker, podman)"),
  Options.optional,
);

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)",
  ),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const createLabelOption = Options.choice("create-label", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)',
  ),
  Options.optional,
);

const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to build the sandbox image now (ignored when --issue-tracker custom is selected)",
  ),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

const initPrdFileOption = Options.text("prd-file").pipe(
  Options.withDescription(
    "Path to a PRD file to record in .sandcastle/workspace.json so `workspace plan/run` default to it",
  ),
  Options.optional,
);

const initPlanOption = Options.choice("plan", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to run the planner after init to generate plan artifacts (requires --prd-file and a built docker/podman image)",
  ),
  Options.optional,
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
    prdFile: initPrdFileOption,
    plan: initPlanOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
    prdFile: prdFileFlag,
    plan: planFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);
      const resolvedPrdFile =
        prdFileFlag._tag === "Some" ? prdFileFlag.value : undefined;
      const planChoice = choiceToTriBool(planFlag);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (sandboxFlag._tag === "Some") {
        const valid = getSandboxProvider(sandboxFlag.value);
        if (!valid) {
          const names = listSandboxProviders()
            .map((p) => p.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (issueTrackerFlag._tag === "Some") {
        const valid = getIssueTracker(issueTrackerFlag.value);
        if (!valid) {
          const names = listIssueTrackers()
            .map((t) => t.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      const createLabelChoice = choiceToTriBool(createLabelFlag);
      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );

      const isInteractive = process.stdin.isTTY === true;
      const failIfNonInteractive = (flag: string) =>
        Effect.fail(
          new InitError({
            message: `${flag} is required in non-interactive mode (no TTY detected).`,
          }),
        );

      // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
      // fail fast in non-interactive mode naming the missing flag). Cancelling
      // the prompt is treated as abort — same shape as the select prompts above.
      const resolveConfirmFlag = (params: {
        choice: Option.Option<boolean>;
        flag: string;
        promptMessage: string;
        cancelMessage: string;
      }): Effect.Effect<boolean, InitError> =>
        Effect.gen(function* () {
          if (params.choice._tag === "Some") return params.choice.value;
          if (!isInteractive) {
            yield* failIfNonInteractive(params.flag);
          }
          const confirmed = yield* Effect.promise(() =>
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
          );
          if (clack.isCancel(confirmed)) {
            yield* Effect.fail(
              new InitError({ message: params.cancelMessage }),
            );
          }
          return confirmed === true;
        });

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--agent");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
            initialValue: "claude-code",
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      // Resolve sandbox provider: CLI flag > interactive select (no default — user must choose)
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxFlag._tag === "Some") {
        selectedSandboxProvider = getSandboxProvider(sandboxFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--sandbox");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Resolve issue tracker: CLI flag > interactive select (already validated above)
      const issueTrackers = listIssueTrackers();
      let selectedIssueTracker: IssueTrackerEntry;
      if (issueTrackerFlag._tag === "Some") {
        selectedIssueTracker = getIssueTracker(issueTrackerFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--issue-tracker");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Issue tracker selection cancelled.",
            }),
          );
        }
        selectedIssueTracker = getIssueTracker(selected as string)!;
      }

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          cancelMessage: "Label selection cancelled.",
        });

        if (shouldCreateLabel) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
          prdFile: resolvedPrdFile,
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      if (resolvedPrdFile && !existsSync(resolve(cwd, resolvedPrdFile))) {
        yield* d.status(
          `Recorded prdFile "${resolvedPrdFile}" in .sandcastle/workspace.json, but no file exists there yet. Create it before running \`sandcastle workspace plan\`.`,
          "warn",
        );
      }

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

      // If the chosen template imports zod on the host (the planner templates
      // build their <plan> output schema with it) and the host doesn't already
      // declare it, offer to install it. Without this, the very first
      // `npx tsx .sandcastle/main.ts` crashes with ERR_MODULE_NOT_FOUND.
      if (getTemplateDependencies(selectedTemplate).includes("zod")) {
        const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
        if (!alreadyInstalled) {
          const installCmd = addDependencyCommand(packageManager, "zod");
          const shouldInstall = yield* resolveConfirmFlag({
            choice: installTemplateDepsChoice,
            flag: "--install-template-deps",
            promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
            cancelMessage: "Install-template-deps selection cancelled.",
          });
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            yield* installed
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                  "warn",
                );
          }
        }
      }

      // Prompt user before building image. The custom issue tracker scaffolds
      // an intentionally unfinished Dockerfile (the install block is a TODO),
      // so there is nothing valid to build yet — skip the build prompt entirely
      // (and silently ignore --build-image) and let the next steps point the
      // user at the setup doc.
      const providerLabel = selectedSandboxProvider.label;
      let imageBuilt = false;
      if (selectedIssueTracker.name === "custom") {
        yield* d.status(
          selectedSandboxProvider.buildsImage
            ? "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building."
            : "Init complete! Your custom issue tracker isn't configured yet — see the steps below before running.",
          "success",
        );
      } else if (!selectedSandboxProvider.buildsImage) {
        yield* d.status(
          "Init complete! No sandbox image was generated because the agent will run on the host.",
          "success",
        );
      } else {
        const shouldBuild = yield* resolveConfirmFlag({
          choice: buildImageChoice,
          flag: "--build-image",
          promptMessage: `Build the default ${providerLabel} image now?`,
          cancelMessage: "Build-image selection cancelled.",
        });

        if (shouldBuild) {
          const containerfileDir = join(cwd, CONFIG_DIR);
          if (selectedSandboxProvider.name === "podman") {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              podmanBuildImage(imageName, containerfileDir),
            );
          } else {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              buildImage(imageName, containerfileDir, {
                buildArgs: defaultUidBuildArgs(),
              }),
            );
          }
          imageBuilt = true;
          yield* d.status(
            "Init complete! Image built successfully.",
            "success",
          );
        } else {
          yield* d.status(
            `Init complete! Run \`sandcastle ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
            "success",
          );
        }
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        selectedIssueTracker,
        selectedAgent,
        packageManager,
        selectedSandboxProvider,
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }

      // Feature 2: optionally run the planner now to generate plan artifacts.
      // The planner runs the selected agent inside a bind-mount sandbox, so it
      // needs a docker/podman image built in this run and a non-custom tracker
      // (custom scaffolds an intentionally unbuildable Dockerfile).
      const planPrereqsMet =
        resolvedPrdFile !== undefined &&
        selectedSandboxProvider.buildsImage &&
        selectedIssueTracker.name !== "custom" &&
        imageBuilt;

      let shouldPlan = false;
      if (planChoice._tag === "Some") {
        shouldPlan = planChoice.value;
        if (shouldPlan && !planPrereqsMet) {
          yield* d.status(
            "Skipping --plan: it needs --prd-file, a docker/podman sandbox, a non-custom issue tracker, and an image built in this run. Run `sandcastle workspace plan --prd-file <path>` once those are ready.",
            "warn",
          );
          shouldPlan = false;
        }
      } else if (planPrereqsMet && isInteractive) {
        const confirmed = yield* Effect.promise(() =>
          clack.confirm({
            message: `Run the planner now with ${resolvedPrdFile} to generate plan artifacts?`,
            initialValue: true,
          }),
        );
        shouldPlan = !clack.isCancel(confirmed) && confirmed === true;
      }

      if (shouldPlan && resolvedPrdFile !== undefined) {
        const configPath = join(cwd, CONFIG_DIR, "workspace.json");
        const workspaceConfig = readWorkspaceConfig(configPath);
        const repositories = normalizeWorkspaceRepositories(
          configPath,
          workspaceConfig,
          cwd,
        );
        const agentEnv = parseEnvFileForCli(resolveWorkspaceEnvFile(cwd));
        const plannerAgent = buildAgentFromEntry(
          selectedAgent,
          selectedModel,
          agentEnv,
        );
        const sandboxProvider =
          selectedSandboxProvider.name === "podman" ? podman() : docker();
        const artifactsDir = defaultWorkspaceArtifactsDir(
          cwd,
          Option.some(resolvedPrdFile),
        );

        const planOutcome = yield* Effect.promise(() =>
          planWorkspaceToArtifacts({
            repositories,
            promptFile: resolvedPrdFile,
            agent: plannerAgent,
            plannerAgent,
            sandbox: sandboxProvider,
            branchPrefix:
              typeof workspaceConfig.branchPrefix === "string"
                ? workspaceConfig.branchPrefix
                : undefined,
            maxIterations:
              typeof workspaceConfig.maxIterations === "number"
                ? workspaceConfig.maxIterations
                : undefined,
            artifactsDir,
            name: "init plan",
          }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({
              ok: false as const,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );

        if (planOutcome.ok) {
          const { artifacts } = planOutcome.value;
          yield* d.text(`Generated workspace plan: ${artifacts.planJsonPath}`);
          yield* d.text(`Generated PRD alignment: ${artifacts.alignmentPath}`);
          yield* d.text(
            `Generated technical plan: ${artifacts.technicalPlanPath}`,
          );
          for (const issuePath of artifacts.issuePaths) {
            yield* d.text(`Generated issue: ${issuePath}`);
          }
        } else {
          yield* d.status(
            `Planner run failed: ${planOutcome.message}. Retry later with \`sandcastle workspace plan --prd-file ${resolvedPrdFile}\` (check .sandcastle/.env credentials and that the image is built).`,
            "warn",
          );
        }
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Local issue command ---

const localIssuePathOption = Options.text("issue").pipe(
  Options.withDescription(
    "Path to a local markdown issue, relative to the target repo. Defaults to the only ready issue under .scratch/",
  ),
  Options.optional,
);

const localIssueBranchOption = Options.text("branch").pipe(
  Options.withDescription("Branch for the agent worktree"),
  Options.optional,
);

const localIssueBaseBranchOption = Options.text("base-branch").pipe(
  Options.withDescription("Base branch to create the agent branch from"),
  Options.optional,
);

const localIssueQa1ConfigOption = Options.text("qa1-config").pipe(
  Options.withDescription(
    "Path to the local QA1 Apollo config cache, relative to the target repo",
  ),
  Options.optional,
);

const localIssueAgentOption = Options.choice("agent", ["codex", "claude"]).pipe(
  Options.withDescription("Agent provider to use for implementation"),
  Options.optional,
);

const localIssueModelOption = Options.text("model").pipe(
  Options.withDescription("Model to use for the implementation agent"),
  Options.optional,
);

const localIssueReviewOption = Options.choice("review", ["true", "false"]).pipe(
  Options.withDescription("Whether to run a reviewer agent after commits"),
  Options.optional,
);

const localIssueDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Print resolved settings without running an agent"),
);

const parseEnvFileForCli = (filePath: string): Record<string, string> => {
  if (!existsSync(filePath)) return {};
  const vars: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    vars[key] = value || process.env[key] || "";
  }
  return Object.fromEntries(Object.entries(vars).filter(([, value]) => value));
};

const resolveSandcastleEnvFile = (): string => {
  if (process.env.SANDCASTLE_ENV_FILE) {
    return resolve(process.env.SANDCASTLE_ENV_FILE);
  }
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  return resolve(sourceDir, "..", ".sandcastle", ".env");
};

/**
 * Resolve the `.env` for workspace/init agent runs. Unlike
 * `resolveSandcastleEnvFile` (which is relative to the installed package and
 * only works when the package *is* the repo, i.e. dogfooding), this reads the
 * user's repo at `<cwd>/.sandcastle/.env` — where `sandcastle init` writes it.
 * `SANDCASTLE_ENV_FILE` still overrides for scripted setups.
 */
export const resolveWorkspaceEnvFile = (cwd: string): string => {
  if (process.env.SANDCASTLE_ENV_FILE) {
    return resolve(process.env.SANDCASTLE_ENV_FILE);
  }
  return resolve(cwd, CONFIG_DIR, ".env");
};

const findMarkdownFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
};

const isReadyForAgentIssue = (filePath: string): boolean =>
  /^status:\s*ready-for-agent\s*$/im.test(readFileSync(filePath, "utf8"));

type LocalIssueResolution =
  | { readonly _tag: "success"; readonly path: string }
  | { readonly _tag: "failure"; readonly error: InitError };

const resolveLocalIssuePath = (
  cwd: string,
  issue: Option.Option<string>,
): LocalIssueResolution => {
  if (issue._tag === "Some") {
    return { _tag: "success", path: resolve(cwd, issue.value) };
  }

  const scratchDir = resolve(cwd, ".scratch");
  const readyIssues =
    findMarkdownFiles(scratchDir).filter(isReadyForAgentIssue);

  if (readyIssues.length === 1) {
    return { _tag: "success", path: readyIssues[0]! };
  }

  if (readyIssues.length === 0) {
    return {
      _tag: "failure",
      error: new InitError({
        message: `No ready local issues found under ${scratchDir}. Pass --issue <path> to choose one.`,
      }),
    };
  }

  return {
    _tag: "failure",
    error: new InitError({
      message: `Multiple ready local issues found under ${scratchDir}. Pass --issue <path> to choose one:\n${readyIssues
        .map((path) => `  - ${relative(cwd, path)}`)
        .join("\n")}`,
    }),
  };
};

const sanitizeBranchSegment = (value: string): string => {
  const sanitized = value
    .replace(/^\d+[-_]/, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "local-issue";
};

const defaultLocalIssueBranch = (cwd: string, issuePath: string): string => {
  const relativeIssuePath = relative(cwd, issuePath);
  const parts = relativeIssuePath.split(/[\\/]+/);
  const scratchIndex = parts.indexOf(".scratch");
  const issueTopic = parts[scratchIndex + 1];

  if (scratchIndex >= 0 && issueTopic && parts[scratchIndex + 2] === "issues") {
    return `sandcastle/${sanitizeBranchSegment(issueTopic)}`;
  }

  const stem = basename(issuePath, extname(issuePath));
  return `sandcastle/${sanitizeBranchSegment(stem)}`;
};

const buildLocalIssuePrompt = (options: {
  issueBody: string;
  issuePath: string;
  branch: string;
  qa1ConfigPath: string;
}): string => `# TASK

Implement the local issue below.

You are working in this repository on branch \`${options.branch}\`.

<local-issue path="${options.issuePath}">
${options.issueBody}
</local-issue>

# PROJECT RULES

Read and follow \`AGENTS.md\` before editing.

- Follow the target repository's project-specific agent rules and skills.
- If changing Java/Spring backend code, follow \`java-backend-senior-engineer\` rules when available or required by the target repo.
- Keep changes surgical.
- Do not refactor unrelated code.
- Use MapStruct for cross-model mapping when mapping is needed.
- Do not log secrets, raw Apollo config values, tokens, user questions, or raw external payloads.

# LOCAL ISSUE TRACKER

The issue source is local markdown under \`.scratch/\`. Do not publish to GitHub or any external tracker. Do not create or edit PRs.

# QA1 APOLLO CONFIG

QA1 Apollo config cache is available on the local host at:

\`${options.qa1ConfigPath}\`

Use it only when runtime or local verification needs QA1-compatible configuration. Do not print config values. Do not copy secrets into committed files, prompts, logs, exceptions, tests, or generated docs.

# EXECUTION

1. Inspect the relevant code and project rules.
2. Implement the smallest correct change for the issue.
3. Add or update focused tests if there is an existing suitable seam.
4. Run targeted verification for the target repository.
5. Commit the implementation on the current branch.

When complete, output \`<promise>COMPLETE</promise>\`.
`;

const buildLocalIssueReviewPrompt = (options: {
  issueBody: string;
  issuePath: string;
  branch: string;
  qa1ConfigPath: string;
}): string => `# TASK

Review the committed changes for the local issue below.

You are working in this repository on branch \`${options.branch}\`.

<local-issue path="${options.issuePath}">
${options.issueBody}
</local-issue>

# REVIEW FOCUS

Read and follow \`AGENTS.md\`.

Check specifically:

- The implementation satisfies the local issue acceptance criteria.
- Existing behavior outside the issue remains unchanged.
- The design is extensible where the issue asks for future growth.
- Project-specific backend rules are followed.
- No secrets or raw QA1 Apollo config values from \`${options.qa1ConfigPath}\` are logged, committed, or exposed.
- Verification evidence is present or failures are clearly explained.

If fixes are needed, apply them and commit. If the implementation is clean, do not make a commit.

When complete, output \`<promise>COMPLETE</promise>\`.
`;

const localIssueCommand = Command.make(
  "local-issue",
  {
    issue: localIssuePathOption,
    branch: localIssueBranchOption,
    baseBranch: localIssueBaseBranchOption,
    qa1Config: localIssueQa1ConfigOption,
    agent: localIssueAgentOption,
    model: localIssueModelOption,
    review: localIssueReviewOption,
    dryRun: localIssueDryRunOption,
  },
  ({ issue, branch, baseBranch, qa1Config, agent, model, review, dryRun }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const issueResolution = resolveLocalIssuePath(cwd, issue);

      if (issueResolution._tag === "failure") {
        yield* Effect.fail(issueResolution.error);
        return;
      }

      const issuePath = issueResolution.path;
      const qa1ConfigPath = resolve(
        cwd,
        qa1Config._tag === "Some" ? qa1Config.value : "config-cache",
      );
      const resolvedBranch =
        branch._tag === "Some"
          ? branch.value
          : defaultLocalIssueBranch(cwd, issuePath);
      const resolvedBaseBranch =
        baseBranch._tag === "Some" ? baseBranch.value : "sit";
      const resolvedAgent = agent._tag === "Some" ? agent.value : "claude";
      const shouldReview =
        review._tag === "Some" ? review.value === "true" : true;
      const sandcastleEnvFile = resolveSandcastleEnvFile();

      if (!existsSync(issuePath)) {
        yield* Effect.fail(
          new InitError({ message: `Local issue not found: ${issuePath}` }),
        );
      }
      if (!existsSync(qa1ConfigPath)) {
        yield* Effect.fail(
          new InitError({
            message: `QA1 Apollo config cache not found: ${qa1ConfigPath}`,
          }),
        );
      }

      const agentEnv = parseEnvFileForCli(sandcastleEnvFile);
      const issueBody = readFileSync(issuePath, "utf8");
      const issuePathForPrompt = relative(cwd, issuePath);

      if (dryRun) {
        yield* d.text("Local issue run settings:");
        yield* d.text(`  repo: ${cwd}`);
        yield* d.text(`  issue: ${issuePathForPrompt}`);
        yield* d.text(`  branch: ${resolvedBranch}`);
        yield* d.text(`  base branch: ${resolvedBaseBranch}`);
        yield* d.text(`  sandbox: no-sandbox`);
        yield* d.text(`  QA1 Apollo config: ${qa1ConfigPath}`);
        yield* d.text(`  Sandcastle env file: ${sandcastleEnvFile}`);
        yield* d.text(`  agent: ${resolvedAgent}`);
        yield* d.text(`  review: ${shouldReview}`);
        return;
      }

      const implementationAgent =
        resolvedAgent === "claude"
          ? claudeCode(
              model._tag === "Some" ? model.value : "x6/claude-opus-4-8",
              {
                env: agentEnv,
              },
            )
          : codex(model._tag === "Some" ? model.value : "x5/gpt-5.5", {
              env: agentEnv,
            });

      const promptOptions = {
        issueBody,
        issuePath: issuePathForPrompt,
        branch: resolvedBranch,
        qa1ConfigPath,
      };

      const implementation = yield* Effect.promise(() =>
        run({
          cwd,
          name: "Implement local issue",
          agent: implementationAgent,
          sandbox: noSandbox({ env: agentEnv }),
          branchStrategy: {
            type: "branch",
            branch: resolvedBranch,
            baseBranch: resolvedBaseBranch,
          },
          prompt: buildLocalIssuePrompt(promptOptions),
          logging: { type: "stdout" },
        }),
      );

      if (shouldReview && implementation.commits.length > 0) {
        yield* Effect.promise(() =>
          run({
            cwd,
            name: "Review local issue",
            agent: codex("x5/gpt-5.5", { env: agentEnv }),
            sandbox: noSandbox({ env: agentEnv }),
            branchStrategy: {
              type: "branch",
              branch: resolvedBranch,
              baseBranch: resolvedBaseBranch,
            },
            prompt: buildLocalIssueReviewPrompt(promptOptions),
            logging: { type: "stdout" },
          }),
        );
      }
    }),
);

// --- Workspace command ---

const workspaceConfigOption = Options.text("config").pipe(
  Options.withDescription(
    "Workspace JSON config path. Defaults to .sandcastle/workspace.json",
  ),
  Options.optional,
);

const workspacePromptOption = Options.text("prompt").pipe(
  Options.withDescription("Workspace task prompt"),
  Options.optional,
);

const workspacePromptFileOption = Options.text("prompt-file").pipe(
  Options.withDescription("Path to a workspace task prompt file"),
  Options.optional,
);

const workspacePrdOption = Options.text("prd").pipe(
  Options.withDescription("Inline product requirements document"),
  Options.optional,
);

const workspacePrdFileOption = Options.text("prd-file").pipe(
  Options.withDescription("Path to a product requirements document file"),
  Options.optional,
);

const workspaceArtifactsDirOption = Options.text("artifacts-dir").pipe(
  Options.withDescription(
    "Directory for generated technical plan and repository issues",
  ),
  Options.optional,
);

const workspacePlanFileOption = Options.text("plan-file").pipe(
  Options.withDescription("Workspace plan JSON file to execute"),
  Options.optional,
);

const workspaceBranchPrefixOption = Options.text("branch-prefix").pipe(
  Options.withDescription(
    "Branch prefix for per-repository execution branches",
  ),
  Options.optional,
);

const workspaceAgentOption = Options.choice("agent", ["codex", "claude"]).pipe(
  Options.withDescription("Agent provider to use for planning and execution"),
  Options.optional,
);

const workspaceModelOption = Options.text("model").pipe(
  Options.withDescription("Model to use for the execution agent"),
  Options.optional,
);

const workspacePlannerModelOption = Options.text("planner-model").pipe(
  Options.withDescription("Model to use for the planner agent"),
  Options.optional,
);

const workspaceSandboxOption = Options.choice("sandbox", [
  "docker",
  "podman",
  "no-sandbox",
]).pipe(
  Options.withDescription("Sandbox provider for workspace runs"),
  Options.optional,
);

const workspaceMaxIterationsOption = Options.integer("max-iterations").pipe(
  Options.withDescription("Maximum iterations for each repository executor"),
  Options.optional,
);

const workspaceDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Plan the workspace task without executing repos"),
);

type WorkspaceCliConfig = {
  readonly repositories?: ReadonlyArray<{
    readonly name?: unknown;
    readonly cwd?: unknown;
    readonly kind?: unknown;
    readonly description?: unknown;
    readonly copyToWorktree?: unknown;
    readonly branchStrategy?: unknown;
  }>;
  readonly branchPrefix?: unknown;
  readonly maxIterations?: unknown;
  readonly prdFile?: unknown;
};

const readWorkspaceConfig = (configPath: string): WorkspaceCliConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new InitError({
      message: `Failed to read workspace config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InitError({
      message: `Workspace config ${configPath} must be a JSON object`,
    });
  }

  return parsed as WorkspaceCliConfig;
};

const normalizeWorkspaceRepositories = (
  configPath: string,
  config: WorkspaceCliConfig,
  cwd: string,
): WorkspaceTaskRepositoryOptions[] => {
  if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
    throw new InitError({
      message: `Workspace config ${configPath} must contain a non-empty repositories array`,
    });
  }

  const names = new Set<string>();
  return config.repositories.map((repo, index) => {
    if (typeof repo.name !== "string" || !repo.name.trim()) {
      throw new InitError({
        message: `Workspace config repository at index ${index} must include a name`,
      });
    }
    if (names.has(repo.name)) {
      throw new InitError({
        message: `Workspace config ${configPath} has duplicate repository name "${repo.name}"`,
      });
    }
    names.add(repo.name);
    if (typeof repo.cwd !== "string" || !repo.cwd.trim()) {
      throw new InitError({
        message: `Workspace config repository "${repo.name}" must include a cwd`,
      });
    }
    if (
      repo.copyToWorktree !== undefined &&
      (!Array.isArray(repo.copyToWorktree) ||
        repo.copyToWorktree.some((item: unknown) => typeof item !== "string"))
    ) {
      throw new InitError({
        message: `Workspace config repository "${repo.name}" copyToWorktree must be an array of strings`,
      });
    }

    return {
      name: repo.name,
      cwd: resolve(cwd, repo.cwd),
      ...(typeof repo.kind === "string" ? { kind: repo.kind } : {}),
      ...(typeof repo.description === "string"
        ? { description: repo.description }
        : {}),
      ...(Array.isArray(repo.copyToWorktree)
        ? { copyToWorktree: repo.copyToWorktree as string[] }
        : {}),
      ...(typeof repo.branchStrategy === "object" &&
      repo.branchStrategy !== null
        ? {
            branchStrategy:
              repo.branchStrategy as WorkspaceTaskRepositoryOptions["branchStrategy"],
          }
        : {}),
    };
  });
};

// Public default models for the workspace commands, sourced from the agent
// registry so there is a single place to bump them. (The internal `x6/`/`x5/`
// routing slugs are not used here — external users get public model slugs.)
const DEFAULT_WORKSPACE_CODEX_MODEL = getAgent("codex")!.defaultModel;
export const DEFAULT_BOARD_TASK_IDLE_TIMEOUT_SECONDS = 600;

const buildWorkspaceCliAgent = (
  agentName: "codex" | "claude",
  model: Option.Option<string>,
  env: Record<string, string>,
) =>
  agentName === "claude"
    ? claudeCode(model._tag === "Some" ? model.value : undefined, { env })
    : codex(
        model._tag === "Some" ? model.value : DEFAULT_WORKSPACE_CODEX_MODEL,
        {
          env,
        },
      );

export const buildWorkspaceSandboxProvider = (
  sandbox: Option.Option<"docker" | "podman" | "no-sandbox">,
  env: Record<string, string>,
): SandboxProvider => {
  const value = sandbox._tag === "Some" ? sandbox.value : "docker";
  if (value === "podman") return podman();
  if (value === "no-sandbox") {
    return createBindMountSandboxProvider({
      name: "no-sandbox",
      env,
      create: async (options) => {
        const host = await noSandbox({ env }).create({
          worktreePath: options.worktreePath,
          env: options.env,
        });
        const pathMap = new Map(
          options.mounts.map((mount) => [mount.sandboxPath, mount.hostPath]),
        );
        const encodedPathMap = new Map(
          options.mounts.map((mount) => [
            encodeProjectPath(mount.sandboxPath),
            encodeProjectPath(mount.hostPath),
          ]),
        );
        const hostHome = process.env.HOME;
        const translate = (value: string | undefined): string | undefined => {
          if (value === undefined) return undefined;
          let translated = value;
          for (const [sandboxPath, hostPath] of encodedPathMap) {
            translated = translated.split(sandboxPath).join(hostPath);
          }
          for (const [sandboxPath, hostPath] of pathMap) {
            translated = translated.split(sandboxPath).join(hostPath);
          }
          if (hostHome) {
            translated = translated.split("/home/agent").join(hostHome);
          }
          return translated;
        };
        return {
          worktreePath: translate(host.worktreePath) ?? host.worktreePath,
          exec: (command, execOptions) =>
            host.exec(translate(command) ?? command, {
              ...execOptions,
              cwd: translate(execOptions?.cwd),
              stdin: translate(execOptions?.stdin),
            }),
          interactiveExec: (args, execOptions) =>
            host.interactiveExec(
              args.map((arg) => translate(arg) ?? arg),
              {
                ...execOptions,
                cwd: translate(execOptions.cwd),
              },
            ),
          copyFileIn: async (hostPath, sandboxPath) => {
            const targetPath = translate(sandboxPath) ?? sandboxPath;
            mkdirSync(dirname(targetPath), { recursive: true });
            copyFileSync(hostPath, targetPath);
          },
          copyFileOut: async (sandboxPath, hostPath) => {
            const sourcePath = translate(sandboxPath) ?? sandboxPath;
            mkdirSync(dirname(hostPath), { recursive: true });
            copyFileSync(sourcePath, hostPath);
          },
          close: () => host.close(),
        };
      },
    });
  }
  return docker();
};

const sanitizeArtifactSegment = (value: string): string => {
  return sanitizePlanningArtifactSegment(value);
};

export const resolveBoardPlanningConfig = (
  configPath: string,
  cwd: string,
  explicitConfig: boolean,
): { readonly configPath: string; readonly config: WorkspaceCliConfig } => {
  if (existsSync(configPath) || explicitConfig) {
    return { configPath, config: readWorkspaceConfig(configPath) };
  }

  return {
    configPath: `${cwd}#planning-repository`,
    config: {
      repositories: [
        { name: sanitizeArtifactSegment(basename(cwd)), cwd: "." },
      ],
    },
  };
};

const defaultWorkspaceArtifactsDir = (
  cwd: string,
  prdFile: Option.Option<string>,
): string => {
  if (prdFile._tag === "Some") {
    const resolved = resolve(cwd, prdFile.value);
    const filename = basename(resolved, extname(resolved));
    const segment = /^(prd|requirements?|product-requirements?)$/i.test(
      filename,
    )
      ? basename(dirname(resolved))
      : filename;
    return resolve(cwd, ".scratch", sanitizeArtifactSegment(segment));
  }

  return resolve(cwd, ".scratch", "workspace-task");
};

type WorkspaceInputResolution =
  | { readonly _tag: "error"; readonly error: InitError }
  | {
      readonly _tag: "ok";
      readonly prompt?: string;
      readonly promptFile?: string;
      /** PRD path used for artifacts-dir naming; None when not PRD-driven. */
      readonly prdArtifactsBasis: Option.Option<string>;
      /** Whether the input came from a PRD (inline, file, or configured). */
      readonly isPrdDriven: boolean;
    };

/**
 * Resolve which workspace input source to use, with precedence:
 * explicit CLI flag (`--prompt`/`--prompt-file`/`--prd`/`--prd-file`) >
 * `workspace.json` `prdFile` (recorded by `init --prd-file`) >
 * the only ready local issue under `.scratch/`. Passing more than one explicit
 * flag is an error.
 */
const resolveWorkspaceInput = (params: {
  readonly cwd: string;
  readonly prompt: Option.Option<string>;
  readonly promptFile: Option.Option<string>;
  readonly prd: Option.Option<string>;
  readonly prdFile: Option.Option<string>;
  readonly configPrdFile: string | undefined;
}): WorkspaceInputResolution => {
  const explicitPromptSources = [
    params.prompt._tag === "Some" ? "--prompt" : undefined,
    params.promptFile._tag === "Some" ? "--prompt-file" : undefined,
    params.prd._tag === "Some" ? "--prd" : undefined,
    params.prdFile._tag === "Some" ? "--prd-file" : undefined,
  ].filter(Boolean) as string[];
  if (explicitPromptSources.length > 1) {
    return {
      _tag: "error",
      error: new InitError({
        message: `Pass only one workspace input source: ${explicitPromptSources.join(", ")}`,
      }),
    };
  }

  if (params.prompt._tag === "Some") {
    return {
      _tag: "ok",
      prompt: params.prompt.value,
      prdArtifactsBasis: Option.none(),
      isPrdDriven: false,
    };
  }
  if (params.promptFile._tag === "Some") {
    return {
      _tag: "ok",
      promptFile: params.promptFile.value,
      prdArtifactsBasis: Option.none(),
      isPrdDriven: false,
    };
  }
  if (params.prd._tag === "Some") {
    return {
      _tag: "ok",
      prompt: `# Product Requirements Document\n\n${params.prd.value}`,
      prdArtifactsBasis: Option.none(),
      isPrdDriven: true,
    };
  }
  if (params.prdFile._tag === "Some") {
    return {
      _tag: "ok",
      promptFile: params.prdFile.value,
      prdArtifactsBasis: params.prdFile,
      isPrdDriven: true,
    };
  }
  if (params.configPrdFile !== undefined) {
    return {
      _tag: "ok",
      promptFile: params.configPrdFile,
      prdArtifactsBasis: Option.some(params.configPrdFile),
      isPrdDriven: true,
    };
  }

  const defaultIssue = resolveLocalIssuePath(params.cwd, Option.none());
  if (defaultIssue._tag === "failure") {
    return { _tag: "error", error: defaultIssue.error };
  }
  return {
    _tag: "ok",
    promptFile: defaultIssue.path,
    prdArtifactsBasis: Option.none(),
    isPrdDriven: false,
  };
};

/** Read the optional `prdFile` recorded in a workspace config. */
const configuredPrdFile = (config: WorkspaceCliConfig): string | undefined =>
  typeof config.prdFile === "string" && config.prdFile.trim()
    ? config.prdFile
    : undefined;

export const resolveBoardStartupPrdFile = (params: {
  readonly cwd: string;
  readonly configPath: string;
  readonly explicitConfig: boolean;
  readonly planFile: Option.Option<string>;
  readonly prdFile: Option.Option<string>;
}): string | undefined => {
  if (params.planFile._tag === "Some" && params.prdFile._tag === "Some") {
    throw new InitError({
      message:
        "Pass only one board startup input source: --plan-file, --prd-file",
    });
  }
  if (params.planFile._tag === "Some") return undefined;
  if (params.prdFile._tag === "Some") {
    return resolve(params.cwd, params.prdFile.value);
  }

  const workspaceConfig = resolveBoardPlanningConfig(
    params.configPath,
    params.cwd,
    params.explicitConfig,
  ).config;
  const configPrdFile = configuredPrdFile(workspaceConfig);
  return configPrdFile ? resolve(params.cwd, configPrdFile) : undefined;
};

export const createBoardStartupTask = (params: {
  readonly store: BoardStore;
  readonly cwd: string;
  readonly configPath: string;
  readonly explicitConfig: boolean;
  readonly planFile: Option.Option<string>;
  readonly prdFile: Option.Option<string>;
  readonly planningOnly: boolean;
  readonly launchTask: (task: BoardTaskRecord) => void;
}): BoardTaskRecord | undefined => {
  const startupPrdFile = resolveBoardStartupPrdFile({
    cwd: params.cwd,
    configPath: params.configPath,
    explicitConfig: params.explicitConfig,
    planFile: params.planFile,
    prdFile: params.prdFile,
  });

  if (params.planFile._tag === "Some") {
    const resolvedPlanFile = resolve(params.cwd, params.planFile.value);
    return createImportedWorkspacePlanTask(params.store, {
      plan: readWorkspacePlan(resolvedPlanFile),
      planFile: resolvedPlanFile,
      planningOnly: params.planningOnly,
    });
  }

  if (startupPrdFile) {
    if (isUnsupportedPrdDocumentFile(startupPrdFile)) {
      throw new InitError({ message: unsupportedPrdDocumentMessage });
    }
    const task = createPrdFileBoardTask(params.store, {
      prdFile: startupPrdFile,
      prd: isPrdVisualAssetFile(startupPrdFile)
        ? ""
        : readFileSync(startupPrdFile, "utf8"),
      planningOnly: params.planningOnly,
    });
    params.launchTask(task);
    return task;
  }

  return undefined;
};

const writeWorkspaceArtifacts = (
  dir: string,
  plan: WorkspaceTaskPlan,
): WorkspacePlanningArtifacts => writeWorkspacePlanningArtifacts(dir, plan);

/**
 * Run the planner (dry run) and write the resulting plan artifacts to disk.
 * Shared by `sandcastle workspace plan` and `sandcastle init --plan` so both
 * produce the same `workspace-plan.json` + alignment/technical-plan/issue files.
 */
const planWorkspaceToArtifacts = async (opts: {
  readonly repositories: ReadonlyArray<WorkspaceTaskRepositoryOptions>;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly agent: AgentProvider;
  readonly plannerAgent?: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly branchPrefix?: string;
  readonly maxIterations?: number;
  readonly artifactsDir: string;
  readonly name: string;
}): Promise<{
  readonly plan: WorkspaceTaskPlan;
  readonly artifacts: ReturnType<typeof writeWorkspaceArtifacts>;
}> => {
  const result = await runWorkspaceTask({
    repositories: opts.repositories,
    prompt: opts.prompt,
    promptFile: opts.promptFile,
    agent: opts.agent,
    plannerAgent: opts.plannerAgent,
    sandbox: opts.sandbox,
    branchPrefix: opts.branchPrefix,
    maxIterations: opts.maxIterations,
    logging: { type: "stdout" },
    name: opts.name,
    dryRun: true,
  });
  const artifacts = writeWorkspaceArtifacts(opts.artifactsDir, result.plan);
  return { plan: result.plan, artifacts };
};

export const parseInteractiveWorkspacePlan = (
  transcript: string,
): WorkspaceTaskPlan | undefined => {
  let plan: WorkspaceTaskPlan | undefined;
  for (const match of transcript.matchAll(
    /<workspace_plan>\s*([\s\S]*?)\s*<\/workspace_plan>/g,
  )) {
    if (!match[1]) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    try {
      plan = parseWorkspaceTaskPlan(parsed, [], {
        allowPlannerWorkspace: true,
      }).plan;
    } catch {
      continue;
    }
  }
  return plan;
};

export const readInteractiveWorkspacePlanFile = (
  planPath: string,
): WorkspaceTaskPlan | undefined => {
  if (!existsSync(planPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(planPath, "utf8"));
  } catch {
    return undefined;
  }
  try {
    return parseWorkspaceTaskPlan(parsed, [], {
      allowPlannerWorkspace: true,
    }).plan;
  } catch {
    return undefined;
  }
};

const readWorkspacePlan = (planPath: string): WorkspaceTaskPlan => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    throw new InitError({
      message: `Failed to read workspace plan ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { repositories?: unknown }).repositories)
  ) {
    throw new InitError({
      message: `Workspace plan ${planPath} must contain a repositories array`,
    });
  }

  const repositories = (parsed as { repositories: unknown[] }).repositories.map(
    (entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new InitError({
          message: `Workspace plan repository at index ${index} must be an object`,
        });
      }
      const repo = entry as {
        name?: unknown;
        task?: unknown;
        reason?: unknown;
        issue?: unknown;
      };
      if (typeof repo.name !== "string" || !repo.name.trim()) {
        throw new InitError({
          message: `Workspace plan repository at index ${index} must include a name`,
        });
      }
      if (typeof repo.task !== "string" || !repo.task.trim()) {
        throw new InitError({
          message: `Workspace plan repository "${repo.name}" must include a task`,
        });
      }

      let issue: WorkspaceTaskPlan["repositories"][number]["issue"];
      if (repo.issue !== undefined) {
        if (typeof repo.issue !== "object" || repo.issue === null) {
          throw new InitError({
            message: `Workspace plan repository "${repo.name}" issue must be an object`,
          });
        }
        const candidate = repo.issue as { title?: unknown; body?: unknown };
        if (
          typeof candidate.title !== "string" ||
          typeof candidate.body !== "string"
        ) {
          throw new InitError({
            message: `Workspace plan repository "${repo.name}" issue must include title and body`,
          });
        }
        issue = { title: candidate.title, body: candidate.body };
      }

      return {
        name: repo.name,
        task: repo.task,
        ...(typeof repo.reason === "string" ? { reason: repo.reason } : {}),
        ...(issue ? { issue } : {}),
      };
    },
  );

  const technicalPlan =
    typeof (parsed as { technicalPlan?: unknown }).technicalPlan === "string"
      ? (parsed as { technicalPlan: string }).technicalPlan
      : undefined;
  const alignment =
    typeof (parsed as { alignment?: unknown }).alignment === "object" &&
    (parsed as { alignment?: unknown }).alignment !== null
      ? (parsed as { alignment: WorkspaceTaskPlan["alignment"] }).alignment
      : undefined;
  const workspace = parseWorkspacePlanSnapshot(
    planPath,
    (parsed as { workspace?: unknown }).workspace,
  );

  return {
    ...(alignment ? { alignment } : {}),
    ...(technicalPlan ? { technicalPlan } : {}),
    ...(workspace ? { workspace } : {}),
    repositories,
  };
};

const parseWorkspacePlanSnapshot = (
  planPath: string,
  value: unknown,
): WorkspaceTaskWorkspace | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new InitError({
      message: `Workspace plan ${planPath} workspace must be an object`,
    });
  }
  const snapshot = value as {
    repositories?: unknown;
    branchPrefix?: unknown;
    maxIterations?: unknown;
  };
  if (
    !Array.isArray(snapshot.repositories) ||
    snapshot.repositories.length === 0
  ) {
    throw new InitError({
      message: `Workspace plan ${planPath} workspace must contain a non-empty repositories array`,
    });
  }

  return {
    repositories:
      snapshot.repositories as WorkspaceTaskWorkspace["repositories"],
    ...(typeof snapshot.branchPrefix === "string"
      ? { branchPrefix: snapshot.branchPrefix }
      : {}),
    ...(typeof snapshot.maxIterations === "number"
      ? { maxIterations: snapshot.maxIterations }
      : {}),
  };
};

const workspaceRunCommand = Command.make(
  "run",
  {
    config: workspaceConfigOption,
    prompt: workspacePromptOption,
    promptFile: workspacePromptFileOption,
    prd: workspacePrdOption,
    prdFile: workspacePrdFileOption,
    artifactsDir: workspaceArtifactsDirOption,
    branchPrefix: workspaceBranchPrefixOption,
    agent: workspaceAgentOption,
    model: workspaceModelOption,
    plannerModel: workspacePlannerModelOption,
    sandbox: workspaceSandboxOption,
    maxIterations: workspaceMaxIterationsOption,
    dryRun: workspaceDryRunOption,
  },
  ({
    config,
    prompt,
    promptFile,
    prd,
    prdFile,
    artifactsDir,
    branchPrefix,
    agent,
    model,
    plannerModel,
    sandbox,
    maxIterations,
    dryRun,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configPath = resolve(
        cwd,
        config._tag === "Some" ? config.value : ".sandcastle/workspace.json",
      );
      const workspaceConfig = readWorkspaceConfig(configPath);
      const repositories = normalizeWorkspaceRepositories(
        configPath,
        workspaceConfig,
        cwd,
      );
      const agentEnv = parseEnvFileForCli(resolveWorkspaceEnvFile(cwd));
      const resolvedAgentName = agent._tag === "Some" ? agent.value : "claude";
      const executionAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        model,
        agentEnv,
      );
      const plannerAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        plannerModel._tag === "Some" ? plannerModel : model,
        agentEnv,
      );
      const sandboxProvider = buildWorkspaceSandboxProvider(sandbox, agentEnv);

      const resolvedBranchPrefix =
        branchPrefix._tag === "Some"
          ? branchPrefix.value
          : typeof workspaceConfig.branchPrefix === "string"
            ? workspaceConfig.branchPrefix
            : undefined;

      const resolvedMaxIterations =
        maxIterations._tag === "Some"
          ? maxIterations.value
          : typeof workspaceConfig.maxIterations === "number"
            ? workspaceConfig.maxIterations
            : undefined;

      const inputResolution = resolveWorkspaceInput({
        cwd,
        prompt,
        promptFile,
        prd,
        prdFile,
        configPrdFile: configuredPrdFile(workspaceConfig),
      });
      if (inputResolution._tag === "error") {
        yield* Effect.fail(inputResolution.error);
        return;
      }

      const shouldWriteArtifacts =
        inputResolution.isPrdDriven || artifactsDir._tag === "Some";
      const resolvedArtifactsDir =
        artifactsDir._tag === "Some"
          ? resolve(cwd, artifactsDir.value)
          : defaultWorkspaceArtifactsDir(
              cwd,
              inputResolution.prdArtifactsBasis,
            );

      const result = yield* Effect.promise(() =>
        runWorkspaceTask({
          repositories,
          prompt: inputResolution.prompt,
          promptFile: inputResolution.promptFile,
          agent: executionAgent,
          plannerAgent,
          sandbox: sandboxProvider,
          branchPrefix: resolvedBranchPrefix,
          maxIterations: resolvedMaxIterations,
          logging: { type: "stdout" },
          name: "workspace task",
          dryRun,
        }),
      );

      yield* d.text("Workspace plan:");
      for (const planned of result.plan.repositories) {
        yield* d.text(`  - ${planned.name}: ${planned.task}`);
      }
      if (result.plan.technicalPlan) {
        yield* d.text("Technical plan:");
        yield* d.text(result.plan.technicalPlan);
      }

      if (shouldWriteArtifacts) {
        const artifacts = writeWorkspaceArtifacts(
          resolvedArtifactsDir,
          result.plan,
        );
        yield* d.text(`Generated workspace plan: ${artifacts.planJsonPath}`);
        yield* d.text(`Generated PRD alignment: ${artifacts.alignmentPath}`);
        yield* d.text(
          `Generated technical plan: ${artifacts.technicalPlanPath}`,
        );
        for (const issuePath of artifacts.issuePaths) {
          yield* d.text(`Generated issue: ${issuePath}`);
        }
      }

      if (dryRun) {
        yield* d.text("Dry run complete: execution was skipped.");
        return;
      }

      yield* d.text("Workspace execution results:");
      for (const [name, repo] of Object.entries(result.repositories)) {
        yield* d.text(
          `  - ${name}: ${repo.status} on ${repo.branch} (${repo.commits.length} commit(s))`,
        );
        if (repo.error) {
          yield* d.text(`    error: ${repo.error}`);
        }
        if (repo.preservedWorktreePath) {
          yield* d.text(`    preserved: ${repo.preservedWorktreePath}`);
        }
      }
    }),
);

const workspacePlanCommand = Command.make(
  "plan",
  {
    config: workspaceConfigOption,
    prompt: workspacePromptOption,
    promptFile: workspacePromptFileOption,
    prd: workspacePrdOption,
    prdFile: workspacePrdFileOption,
    artifactsDir: workspaceArtifactsDirOption,
    agent: workspaceAgentOption,
    model: workspaceModelOption,
    plannerModel: workspacePlannerModelOption,
    sandbox: workspaceSandboxOption,
    branchPrefix: workspaceBranchPrefixOption,
    maxIterations: workspaceMaxIterationsOption,
  },
  ({
    config,
    prompt,
    promptFile,
    prd,
    prdFile,
    artifactsDir,
    agent,
    model,
    plannerModel,
    sandbox,
    branchPrefix,
    maxIterations,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configPath = resolve(
        cwd,
        config._tag === "Some" ? config.value : ".sandcastle/workspace.json",
      );
      const workspaceConfig = readWorkspaceConfig(configPath);
      const repositories = normalizeWorkspaceRepositories(
        configPath,
        workspaceConfig,
        cwd,
      );
      const agentEnv = parseEnvFileForCli(resolveWorkspaceEnvFile(cwd));
      const resolvedAgentName = agent._tag === "Some" ? agent.value : "claude";
      const executionAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        model,
        agentEnv,
      );
      const plannerAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        plannerModel._tag === "Some" ? plannerModel : model,
        agentEnv,
      );
      const sandboxProvider = buildWorkspaceSandboxProvider(sandbox, agentEnv);
      const resolvedBranchPrefix =
        branchPrefix._tag === "Some"
          ? branchPrefix.value
          : typeof workspaceConfig.branchPrefix === "string"
            ? workspaceConfig.branchPrefix
            : undefined;
      const resolvedMaxIterations =
        maxIterations._tag === "Some"
          ? maxIterations.value
          : typeof workspaceConfig.maxIterations === "number"
            ? workspaceConfig.maxIterations
            : undefined;

      const inputResolution = resolveWorkspaceInput({
        cwd,
        prompt,
        promptFile,
        prd,
        prdFile,
        configPrdFile: configuredPrdFile(workspaceConfig),
      });
      if (inputResolution._tag === "error") {
        yield* Effect.fail(inputResolution.error);
        return;
      }

      const resolvedArtifactsDir =
        artifactsDir._tag === "Some"
          ? resolve(cwd, artifactsDir.value)
          : defaultWorkspaceArtifactsDir(
              cwd,
              inputResolution.prdArtifactsBasis,
            );

      const { plan: planResult, artifacts } = yield* Effect.promise(() =>
        planWorkspaceToArtifacts({
          repositories,
          prompt: inputResolution.prompt,
          promptFile: inputResolution.promptFile,
          agent: executionAgent,
          plannerAgent,
          sandbox: sandboxProvider,
          branchPrefix: resolvedBranchPrefix,
          maxIterations: resolvedMaxIterations,
          artifactsDir: resolvedArtifactsDir,
          name: "workspace plan",
        }),
      );
      const result = { plan: planResult };
      yield* d.text("Workspace plan:");
      for (const planned of result.plan.repositories) {
        yield* d.text(`  - ${planned.name}: ${planned.task}`);
      }
      if (result.plan.technicalPlan) {
        yield* d.text("Technical plan:");
        yield* d.text(result.plan.technicalPlan);
      }
      yield* d.text(`Generated workspace plan: ${artifacts.planJsonPath}`);
      yield* d.text(`Generated PRD alignment: ${artifacts.alignmentPath}`);
      yield* d.text(`Generated technical plan: ${artifacts.technicalPlanPath}`);
      for (const issuePath of artifacts.issuePaths) {
        yield* d.text(`Generated issue: ${issuePath}`);
      }
    }),
);

const workspaceExecuteCommand = Command.make(
  "execute",
  {
    config: workspaceConfigOption,
    planFile: workspacePlanFileOption,
    artifactsDir: workspaceArtifactsDirOption,
    branchPrefix: workspaceBranchPrefixOption,
    agent: workspaceAgentOption,
    model: workspaceModelOption,
    sandbox: workspaceSandboxOption,
    maxIterations: workspaceMaxIterationsOption,
  },
  ({
    config,
    planFile,
    artifactsDir,
    branchPrefix,
    agent,
    model,
    sandbox,
    maxIterations,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const agentEnv = parseEnvFileForCli(resolveWorkspaceEnvFile(cwd));
      const resolvedAgentName = agent._tag === "Some" ? agent.value : "claude";
      const executionAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        model,
        agentEnv,
      );
      const sandboxProvider = buildWorkspaceSandboxProvider(sandbox, agentEnv);
      const resolvedPlanFile =
        planFile._tag === "Some"
          ? resolve(cwd, planFile.value)
          : resolve(
              artifactsDir._tag === "Some"
                ? resolve(cwd, artifactsDir.value)
                : defaultWorkspaceArtifactsDir(cwd, Option.none()),
              "workspace-plan.json",
            );
      const plan = readWorkspacePlan(resolvedPlanFile);
      const configPath = resolve(
        cwd,
        config._tag === "Some" ? config.value : ".sandcastle/workspace.json",
      );
      const workspaceConfig =
        plan.workspace !== undefined
          ? ({
              repositories: plan.workspace.repositories,
              branchPrefix: plan.workspace.branchPrefix,
              maxIterations: plan.workspace.maxIterations,
            } satisfies WorkspaceCliConfig)
          : readWorkspaceConfig(configPath);
      const workspaceConfigPath =
        plan.workspace !== undefined
          ? `${resolvedPlanFile}#workspace`
          : configPath;
      const repositories = normalizeWorkspaceRepositories(
        workspaceConfigPath,
        workspaceConfig,
        cwd,
      );
      const resolvedBranchPrefix =
        branchPrefix._tag === "Some"
          ? branchPrefix.value
          : typeof workspaceConfig.branchPrefix === "string"
            ? workspaceConfig.branchPrefix
            : undefined;
      const resolvedMaxIterations =
        maxIterations._tag === "Some"
          ? maxIterations.value
          : typeof workspaceConfig.maxIterations === "number"
            ? workspaceConfig.maxIterations
            : undefined;

      const repositoriesResult = yield* Effect.promise(() =>
        executeWorkspaceTaskPlan({
          repositories,
          plan,
          taskPrompt: `Execute approved workspace plan from ${resolvedPlanFile}.`,
          agent: executionAgent,
          sandbox: sandboxProvider,
          branchPrefix: resolvedBranchPrefix,
          maxIterations: resolvedMaxIterations,
          logging: { type: "stdout" },
          name: "workspace execute",
        }),
      );

      yield* d.text("Workspace execution results:");
      for (const [name, repo] of Object.entries(repositoriesResult)) {
        yield* d.text(
          `  - ${name}: ${repo.status} on ${repo.branch} (${repo.commits.length} commit(s))`,
        );
        if (repo.error) {
          yield* d.text(`    error: ${repo.error}`);
        }
        if (repo.preservedWorktreePath) {
          yield* d.text(`    preserved: ${repo.preservedWorktreePath}`);
        }
      }
    }),
);

const workspaceCommand = Command.make("workspace", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status("Use `sandcastle workspace plan --help`.", "info");
  }),
).pipe(
  Command.withSubcommands([
    workspacePlanCommand,
    workspaceExecuteCommand,
    workspaceRunCommand,
  ]),
);

// --- Board command ---

const boardPortOption = Options.integer("port").pipe(
  Options.withDescription("Port for the board server (default: 4318)"),
  Options.optional,
);

const boardDataDirOption = Options.text("data-dir").pipe(
  Options.withDescription(
    "Directory for board run/event/task data (default: .sandcastle/board)",
  ),
  Options.optional,
);

const boardPlanningOnlyOption = Options.boolean("planning-only").pipe(
  Options.withDescription(
    "Export approved Board planning artifacts without starting AFK execution",
  ),
);

const sanitizeBoardBranchSegment = (value: string): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\/+/g, "/");
  return sanitized || "task";
};

export const boardExecutionBranchPrefix = (taskId: string): string =>
  `codex/board/${sanitizeBoardBranchSegment(taskId).slice(0, 8)}`;

const boardEvaluatorBranch = (taskId: string): string =>
  `${boardExecutionBranchPrefix(taskId)}/evaluator`;

export const buildBoardPhasePrompt = (
  task: BoardTaskRecord,
  phase: BoardTaskWorkflowPhase,
  options: {
    readonly workspacePlanFile?: string;
  } = {},
): string => {
  const planningBoundaryInstructions =
    phase === "classifying" ||
    phase === "aligning-prd" ||
    phase === "technical-planning" ||
    phase === "creating-issues"
      ? `
Board role: Planner. Stay inside the Planner responsibility boundary.
This is a planning-only Board phase. You may read CLAUDE.md and AGENTS.md, plus project docs, only to understand required skills/workflows, repository rules, verification expectations, and issue formatting requirements. Do not implement the task. Do not edit source files. Do not run long-lived agents. Do not commit changes. Preserve required skill/workflow instructions inside generated plans and issues so the later execution phase can follow them. If repository docs conflict with this planning-only boundary, this Board phase instruction wins.
`
      : "";
  const issueGenerationInstructions =
    phase === "creating-issues"
      ? `
For this creating-issues phase, produce the final Board issues interactively. Before printing the phase completion marker, include one machine-readable workspace plan block in this exact shape:

<workspace_plan>
{
  "alignment": { "summary": "short summary" },
  "technicalPlan": "technical approach and sequencing",
  "repositories": [
    {
      "name": "repository-name",
      "task": "specific implementation task",
      "reason": "why this repository is affected",
      "issue": {
        "title": "short issue title",
        "body": "Status: ready-for-agent\\n\\n## What to build\\n\\n...\\n\\n## Acceptance criteria\\n\\n- [ ] ...\\n\\n## Verification\\n\\n- [ ] ..."
      }
    }
  ]
}
</workspace_plan>

The Board will import this block directly. The repositories array must contain each repository name at most once. If multiple issues or tasks belong to the same repository, combine them into a single repository entry and put the combined work in that entry's task, issue body, and checklist instead of repeating the repository name.

If the original task prompt includes PRD visual assets, include relevant PRD visual assets in each affected repository issue body. For frontend or UI work, add an explicit checklist item: "Inspect PRD visual assets before implementation." Preserve the asset paths so the execution agent can inspect the images.

If a workspace plan file path is provided below, also write the exact JSON object to that file before printing the completion marker. Write only the JSON object to the file, without XML tags, markdown fences, ANSI styling, or commentary. Create the parent directory if needed. Workspace plan file: ${options.workspacePlanFile ?? "(not provided)"}

Do not print the completion marker until the workspace_plan block and issue content are final.`
      : "";

  return `You are helping with the current Sandcastle Board workflow phase.

Task: ${task.title}
Phase: ${phase}

Original task prompt / PRD:
${task.prompt}
${planningBoundaryInstructions}
${issueGenerationInstructions}

Work interactively with the user for this phase. When this phase is complete, print this exact marker on its own line:
${PHASE_COMPLETION_SIGNAL}

The Board will detect that marker and advance to the next phase. The user can still click "Complete phase / Continue" as a fallback. Do not start multi-repository execution from this terminal.`;
};

const boardCommand = Command.make(
  "board",
  {
    port: boardPortOption,
    dataDir: boardDataDirOption,
    config: workspaceConfigOption,
    artifactsDir: workspaceArtifactsDirOption,
    planFile: workspacePlanFileOption,
    prdFile: workspacePrdFileOption,
    planningOnly: boardPlanningOnlyOption,
    agent: workspaceAgentOption,
    model: workspaceModelOption,
    plannerModel: workspacePlannerModelOption,
    sandbox: workspaceSandboxOption,
    branchPrefix: workspaceBranchPrefixOption,
    maxIterations: workspaceMaxIterationsOption,
  },
  ({
    port,
    dataDir,
    config,
    artifactsDir,
    planFile,
    prdFile,
    planningOnly,
    agent,
    model,
    plannerModel,
    sandbox,
    branchPrefix,
    maxIterations,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const resolvedDataDir =
        dataDir._tag === "Some"
          ? resolve(cwd, dataDir.value)
          : resolve(cwd, ".sandcastle", "board");
      const store = new BoardStore(resolvedDataDir);

      // Resolve the planner context lazily so the board starts without a
      // workspace config. The PRD planner still determines the task workspace;
      // this context is only what the planner can inspect first.
      const configPath = resolve(
        cwd,
        config._tag === "Some" ? config.value : ".sandcastle/workspace.json",
      );
      const agentEnv = parseEnvFileForCli(resolveWorkspaceEnvFile(cwd));
      const resolvedAgentName = agent._tag === "Some" ? agent.value : "claude";
      const executionAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        model,
        agentEnv,
      );
      const plannerAgent = buildWorkspaceCliAgent(
        resolvedAgentName,
        plannerModel._tag === "Some" ? plannerModel : model,
        agentEnv,
      );
      const evaluatorAgent = plannerAgent;
      const sandboxProvider = buildWorkspaceSandboxProvider(sandbox, agentEnv);
      const resolvedBranchPrefix =
        branchPrefix._tag === "Some" ? branchPrefix.value : undefined;
      const resolvedMaxIterations =
        maxIterations._tag === "Some" ? maxIterations.value : undefined;
      const artifactsDirForTask = (taskId: string): string => {
        if (artifactsDir._tag === "Some") {
          return resolve(cwd, artifactsDir.value);
        }
        const task = store.getTask(taskId);
        return defaultWorkspaceArtifactsDir(
          cwd,
          task?.source?.type === "prd-file"
            ? Option.some(task.source.prdFile)
            : Option.none(),
        );
      };

      const resolveExecutionRepositories = (plan: WorkspaceTaskPlan) => {
        const workspaceConfig =
          plan.workspace !== undefined
            ? ({
                repositories: plan.workspace.repositories,
                branchPrefix: plan.workspace.branchPrefix,
                maxIterations: plan.workspace.maxIterations,
              } satisfies WorkspaceCliConfig)
            : resolveBoardPlanningConfig(
                configPath,
                cwd,
                config._tag === "Some",
              ).config;
        const workspaceConfigPath =
          plan.workspace !== undefined
            ? `${resolvedDataDir}/${plan.repositories
                .map((repo) => repo.name)
                .join("-")}#workspace`
            : configPath;
        return normalizeWorkspaceRepositories(
          workspaceConfigPath,
          workspaceConfig,
          cwd,
        );
      };

      let langGraphWorkflow:
        | ReturnType<typeof createLangGraphTaskWorkflow>
        | undefined;
      const phasePlanOverrides = new Map<string, string>();
      const phasePlanOverrideKey = (
        taskId: string,
        phase: BoardTaskWorkflowPhase,
      ) => `${taskId}:${phase}`;
      const phaseWorkspacePlanFile = (taskId: string): string =>
        join(resolvedDataDir, "tasks", `${taskId}.workspace-plan.json`);
      const reportWorkflowPromise = (
        taskId: string,
        promise: Promise<unknown>,
      ): void => {
        void promise.catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          const task = store.getTask(taskId);
          const updatedAt = new Date().toISOString();
          store.updateTask(taskId, {
            status: "failed",
            finishedAt: updatedAt,
            error: message,
            workflow: {
              ...(task?.workflow ?? {
                status: "failed",
                updatedAt,
              }),
              status: "failed",
              error: message,
              updatedAt,
            },
          });
        });
      };
      const terminalManager = new BoardTerminalManager(store, undefined, {
        onPhaseCompleteSignal: ({ taskId, phase }) => {
          if (langGraphWorkflow) {
            reportWorkflowPromise(
              taskId,
              langGraphWorkflow.completePhase(taskId, phase),
            );
          }
        },
      });
      const ensurePhaseSession = (
        taskId: string,
        phase: BoardTaskWorkflowPhase,
      ) => {
        const task = store.getTask(taskId);
        if (!task) return;
        try {
          if (!plannerAgent.buildInteractiveArgs) {
            store.updateTask(task.id, {
              workflow: {
                ...(task.workflow ?? {
                  status: phase,
                  currentPhase: phase,
                  updatedAt: new Date().toISOString(),
                }),
                error: `Agent provider "${plannerAgent.name}" does not support interactive sessions.`,
                updatedAt: new Date().toISOString(),
              },
            });
            return;
          }
          const args = plannerAgent.buildInteractiveArgs({
            prompt: buildBoardPhasePrompt(task, phase, {
              workspacePlanFile:
                phase === "creating-issues"
                  ? phaseWorkspacePlanFile(task.id)
                  : undefined,
            }),
            dangerouslySkipPermissions: true,
          });
          const [command, ...rest] = args;
          if (!command) {
            store.updateTask(task.id, {
              workflow: {
                ...(task.workflow ?? {
                  status: phase,
                  currentPhase: phase,
                  updatedAt: new Date().toISOString(),
                }),
                error: `Agent provider "${plannerAgent.name}" did not produce an interactive command.`,
                updatedAt: new Date().toISOString(),
              },
            });
            return;
          }
          terminalManager.startPhase({
            task,
            phase,
            command,
            args: rest,
            cwd,
            env: { ...agentEnv, ...plannerAgent.env },
          });
        } catch (error) {
          store.updateTask(task.id, {
            workflow: {
              ...(task.workflow ?? {
                status: phase,
                currentPhase: phase,
                updatedAt: new Date().toISOString(),
              }),
              error: error instanceof Error ? error.message : String(error),
              updatedAt: new Date().toISOString(),
            },
          });
        }
      };

      langGraphWorkflow = createLangGraphTaskWorkflow({
        store,
        planningOnly,
        exportApprovedPlan: async ({ taskId, plan }) => {
          exportApprovedBoardPlan({
            store,
            cwd,
            taskId,
            artifactsDir: artifactsDirForTask(taskId),
            plan,
          });
        },
        onPhaseStarted: ({ taskId, phase }) => {
          ensurePhaseSession(taskId, phase);
        },
        requestPhaseRepair: ({ taskId, phase, message }) => {
          terminalManager.writePhase(taskId, phase, `\n${message.trim()}\n`);
        },
        planFromPhase: async ({ taskId, phase }) => {
          if (phase !== "creating-issues") return undefined;
          const overrideKey = phasePlanOverrideKey(taskId, phase);
          const overrideText = phasePlanOverrides.get(overrideKey);
          const overridePlan =
            overrideText !== undefined
              ? parseInteractiveWorkspacePlan(overrideText)
              : undefined;
          if (overridePlan) {
            phasePlanOverrides.delete(overrideKey);
            return { plan: overridePlan, plannerStdout: "interactive phase" };
          }
          const filePlan = readInteractiveWorkspacePlanFile(
            phaseWorkspacePlanFile(taskId),
          );
          if (filePlan) {
            return {
              plan: filePlan,
              plannerStdout: "interactive phase file",
            };
          }
          const terminalPlan = parseInteractiveWorkspacePlan(
            terminalManager.getPhaseOutput(taskId, phase),
          );
          return terminalPlan
            ? { plan: terminalPlan, plannerStdout: "interactive phase" }
            : undefined;
        },
        plan: async () => {
          throw new Error(
            "Board background planner fallback is disabled. Fix the <workspace_plan> block in the creating-issues phase terminal, then complete the phase again.",
          );
        },
        execute: async ({
          taskId,
          prompt,
          title,
          plan,
          onRepoRunEvent,
          signal,
        }) => {
          const task = store.getTask(taskId);
          const executionAssets = task
            ? preparePrdAssetsForExecution({
                task,
                repositories: resolveExecutionRepositories(plan),
              })
            : {
                repositories: resolveExecutionRepositories(plan),
                promptSection: "",
              };
          return executeWorkspaceTaskPlan({
            repositories: executionAssets.repositories,
            plan,
            taskPrompt: `${prompt}${executionAssets.promptSection}`,
            agent: executionAgent,
            sandbox: sandboxProvider,
            branchPrefix:
              resolvedBranchPrefix ??
              plan.workspace?.branchPrefix ??
              boardExecutionBranchPrefix(taskId),
            maxIterations:
              resolvedMaxIterations ?? plan.workspace?.maxIterations,
            name: title,
            idleTimeoutSeconds: DEFAULT_BOARD_TASK_IDLE_TIMEOUT_SECONDS,
            onRepoRunEvent,
            signal,
          });
        },
        evaluate: async (input) => {
          let recorder: ((event: RunEvent) => void) | undefined;
          return runBoardEvaluatorAgent({
            cwd,
            agent: evaluatorAgent,
            sandbox: sandboxProvider,
            branch: boardEvaluatorBranch(input.task.id),
            input,
            signal: input.signal,
            idleTimeoutSeconds: DEFAULT_BOARD_TASK_IDLE_TIMEOUT_SECONDS,
            onRunEvent: (event) => {
              recorder ??= createRunRecorder(store, {
                taskId: input.task.id,
                repo: BOARD_EVALUATOR_REPO,
              });
              recorder(event);
            },
          });
        },
      });

      const launchTask = createTaskLauncher({
        store,
        run: langGraphWorkflow.run,
      });
      const resolveBranchMergeConflict = (
        task: BoardTaskRecord,
        args: { readonly repository: string; readonly targetBranch: string },
      ): void => {
        const runs = store.listRuns().filter((run) => run.taskId === task.id);
        const context = getBoardTaskBranchMergeContext({
          task,
          runs,
          repository: args.repository,
          targetBranch: args.targetBranch,
          defaultRepoDir: cwd,
        });
        const startedAt = new Date().toISOString();
        store.updateTask(task.id, {
          workflow: {
            ...(task.workflow ?? { status: "running", updatedAt: startedAt }),
            message: `Resolving merge conflict from ${context.sourceBranch} into ${context.targetBranch}.`,
            updatedAt: startedAt,
          },
        });
        execFileSync("git", ["checkout", context.targetBranch], {
          cwd: context.cwd,
          stdio: ["ignore", "ignore", "pipe"],
        });

        let recorder: ((event: RunEvent) => void) | undefined;
        const promise = executeWorkspaceTaskPlan({
          repositories: [
            {
              name: context.repository,
              cwd: context.cwd,
              branchStrategy: { type: "merge-to-head" },
            },
          ],
          plan: {
            workspace: {
              repositories: [
                {
                  name: context.repository,
                  cwd: context.cwd,
                  branchStrategy: { type: "merge-to-head" },
                },
              ],
            },
            repositories: [
              {
                name: context.repository,
                task: `Resolve the git merge conflict when merging ${context.sourceBranch} into ${context.targetBranch}.`,
                reason:
                  "The Board branch merge action detected a conflict and needs an agent-assisted resolution.",
                issue: {
                  title: "Resolve Board branch merge conflict",
                  body: `Status: ready-for-agent

## What to build

Resolve the git merge conflict between source branch \`${context.sourceBranch}\` and target branch \`${context.targetBranch}\`.

## Acceptance criteria

- Run \`git merge ${context.sourceBranch}\` from the checked-out target branch worktree.
- Resolve all conflicts without unrelated changes.
- Commit the conflict resolution.
- Leave the repository with a clean working tree.

## Verification

- \`git status --short\` is empty.
- \`git merge-base --is-ancestor ${context.sourceBranch} HEAD\` succeeds.`,
                },
              },
            ],
          },
          taskPrompt: `Resolve the Board branch merge conflict for task "${task.title}". Merge source branch ${context.sourceBranch} into target branch ${context.targetBranch}, resolve conflicts, commit the resolution, and report completion.`,
          agent: executionAgent,
          sandbox: sandboxProvider,
          branchPrefix:
            resolvedBranchPrefix ??
            `${boardExecutionBranchPrefix(task.id)}/merge-conflict`,
          maxIterations: resolvedMaxIterations,
          name: `${task.title} resolve merge`,
          idleTimeoutSeconds: DEFAULT_BOARD_TASK_IDLE_TIMEOUT_SECONDS,
          onRepoRunEvent: (repo, event) => {
            recorder ??= createRunRecorder(store, {
              taskId: task.id,
              repo,
            });
            recorder(event);
          },
        }).then((results) => {
          const result = results[context.repository];
          const updatedAt = new Date().toISOString();
          store.updateTask(task.id, {
            workflow: {
              ...(store.getTask(task.id)?.workflow ?? {
                status: "succeeded",
                updatedAt,
              }),
              message:
                result?.status === "success"
                  ? `Merge conflict resolver completed for ${context.repository}.`
                  : `Merge conflict resolver failed for ${context.repository}.`,
              ...(result?.error ? { error: result.error } : {}),
              updatedAt,
            },
          });
        });
        void promise.catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          const updatedAt = new Date().toISOString();
          store.updateTask(task.id, {
            workflow: {
              ...(store.getTask(task.id)?.workflow ?? {
                status: "failed",
                updatedAt,
              }),
              error: message,
              updatedAt,
            },
          });
        });
      };

      const startupTask = createBoardStartupTask({
        store,
        cwd,
        configPath,
        explicitConfig: config._tag === "Some",
        planFile,
        prdFile,
        planningOnly,
        launchTask,
      });

      if (startupTask?.source?.type === "workspace-plan") {
        yield* d.status(
          planningOnly
            ? `Imported workspace plan into Board task ${startupTask.id}. Open the board and approve it to export planning artifacts.`
            : `Imported workspace plan into Board task ${startupTask.id}. Open the board and approve it to execute.`,
          "success",
        );
      } else if (startupTask?.source?.type === "prd-file") {
        yield* d.status(
          planningOnly
            ? `Created Board task ${startupTask.id} from PRD ${startupTask.source.prdFile}. Open the board to guide planning and approve artifact export.`
            : `Created Board task ${startupTask.id} from PRD ${startupTask.source.prdFile}. Open the board to guide planning.`,
          "success",
        );
      }

      const server = yield* Effect.promise(() =>
        startBoardServer({
          store,
          port: port._tag === "Some" ? port.value : 4318,
          launchTask,
          terminalManager,
          resumeTask: (task, decision) => {
            reportWorkflowPromise(
              task.id,
              langGraphWorkflow.resume(task.id, decision),
            );
          },
          completePhase: (task, phase, options) => {
            if (options?.workspacePlanText) {
              phasePlanOverrides.set(
                phasePlanOverrideKey(task.id, phase),
                options.workspacePlanText,
              );
            }
            reportWorkflowPromise(
              task.id,
              langGraphWorkflow.completePhase(task.id, phase),
            );
          },
          recoverTask: (task) => {
            reportWorkflowPromise(
              task.id,
              langGraphWorkflow.recoverPhase(task.id),
            );
          },
          cancelTask: (task) => {
            terminalManager.killTask(task.id);
            reportWorkflowPromise(task.id, langGraphWorkflow.cancel(task.id));
          },
          resolveBranchMergeConflict,
        }),
      );

      yield* d.status(`Sandcastle board running at ${server.url}`, "success");
      yield* d.status(`Data directory: ${resolvedDataDir}`, "info");
      yield* d.status("Press Ctrl+C to stop.", "info");

      // Keep the server alive until the process is interrupted; close on exit.
      yield* Effect.never.pipe(
        Effect.ensuring(Effect.promise(() => server.close())),
      );
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    dockerCommand,
    podmanCommand,
    localIssueCommand,
    workspaceCommand,
    boardCommand,
  ]),
);

export const normalizeBoardPlanningOnlyHelpArgs = (
  argv: readonly string[],
): string[] => {
  const prefix = argv.slice(0, 2);
  const args = argv.slice(2);
  if (args[0] !== "board") return [...argv];

  const planningOnlyIndex = args.findIndex((arg) =>
    arg.startsWith("--planning-only"),
  );
  const helpIndex = args.findIndex((arg) => arg === "--help" || arg === "-h");
  if (
    planningOnlyIndex === -1 ||
    helpIndex === -1 ||
    helpIndex < planningOnlyIndex
  ) {
    return [...argv];
  }

  return [
    ...prefix,
    "board",
    args[helpIndex]!,
    ...args.slice(1).filter((_, index) => index !== helpIndex - 1),
  ];
};

const runCli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});

export const cli = (argv: readonly string[]) =>
  runCli(normalizeBoardPlanningOnlyHelpArgs(argv));
