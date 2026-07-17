import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  scriptedSoftwareRndDepartment,
  scriptedSoftwareRndPipelineEditor,
} from "../runtime/testing/departmentInspectContract.js";
import {
  ArtifactLineagePanel,
  DepartmentDetailView,
  DepartmentRunDetail,
  AgentsPage,
  SkillCatalogResults,
  SkillsPage,
  PositionDrawerEditor,
  ProjectDetailView,
  RuntimeDiagnosticsPanel,
  isAgentTestDisabled,
} from "./companyPages.js";
import { messages } from "./i18n.js";
import type { DepartmentRunView } from "../runtime/interface.js";
import type {
  AgentCatalogView,
  SkillCatalogView,
} from "../runtime/interface.js";
import { scriptedSkillConfiguration } from "../runtime/testing/skillConfigurationContract.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";

describe("Artifact lineage", () => {
  it("renders exact producer and input Artifact Version identities", () => {
    const markup = renderToStaticMarkup(
      <ArtifactLineagePanel
        lineage={{
          version: {
            id: "artifact-version-2",
            artifactId: "artifact-1",
            projectId: "project-1",
            type: "verification-report",
            schemaVersion: "1",
            logicalName: "checkout-verification",
            version: 2,
            contentRef: ".sandcastle/artifacts/artifact-version-2.json",
            contentHash: "a".repeat(64),
            byteSize: 128,
            status: "accepted",
            producer: {
              runId: "run-2",
              nodeRunId: "node-verification",
              nodeAttemptId: "attempt-3",
              snapshotRevisionId: "snapshot-r2",
              aiMemberId: "evaluator-member",
            },
            createdAt: "2026-07-15T00:00:00.000Z",
          },
          inputs: [{ versionId: "artifact-version-1", relation: "input" }],
        }}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-artifact-lineage="artifact-version-2"/);
    assert.match(markup, /run-2/);
    assert.match(markup, /attempt-3/);
    assert.match(markup, /snapshot-r2/);
    assert.match(markup, /evaluator-member/);
    assert.match(markup, /artifact-version-1/);
  });
});

describe("Company Agent and Skill catalog pages", () => {
  it("locks only the Agent card currently being tested", () => {
    assert.equal(isAgentTestDisabled(new Set(), "codex", "installed"), false);
    assert.equal(
      isAgentTestDisabled(new Set(["codex"]), "codex", "installed"),
      true,
    );
    assert.equal(
      isAgentTestDisabled(new Set(["codex"]), "hermes", "installed"),
      false,
    );
    const concurrentTests = new Set(["codex", "hermes"]);
    assert.equal(
      isAgentTestDisabled(concurrentTests, "codex", "installed"),
      true,
    );
    assert.equal(
      isAgentTestDisabled(concurrentTests, "hermes", "installed"),
      true,
    );
    assert.equal(
      isAgentTestDisabled(new Set(), "codem", "not-installed"),
      true,
    );
  });

  it("renders detected Agents with stable IDs and a non-destructive test action", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        t={messages.en}
        initialCatalog={
          {
            agents: [
              {
                id: "codex",
                name: "Codex",
                status: "installed",
                version: "1.2.3",
                executablePath: "/opt/bin/codex",
                lastDetectedAt: "2026-07-16T08:00:00.000Z",
                capabilities: ["non-interactive"],
                errorCode: null,
              },
            ],
          } satisfies AgentCatalogView
        }
      />,
    );
    assert.match(markup, /data-page="agents"/);
    assert.match(markup, /data-agent-id="codex"/);
    assert.match(markup, /Codex/);
    assert.match(markup, /1\.2\.3/);
    assert.match(markup, /class="catalog-path"/);
    assert.match(markup, /class="catalog-meta-block"/);
    assert.match(markup, /data-agent-capabilities/);
    assert.match(markup, /data-detect-agents/);
    assert.match(markup, /class="agent-test-button"/);
    assert.match(markup, /data-test-agent="codex"/);
  });

  it("renders independent Skills search, source references, and lifecycle actions", () => {
    const markup = renderToStaticMarkup(
      <SkillsPage
        t={messages.en}
        initialCatalog={
          {
            directories: ["/Users/test/.codex/skills"],
            skills: [
              {
                id: "local-review",
                name: "Local Review",
                description: "Reviews changes.",
                sourceDirectory: "/Users/test/.codex/skills",
                version: "sha256:abc",
                locationReference:
                  "/Users/test/.codex/skills/local-review/SKILL.md",
                requiredCapabilities: ["structured-output"],
                status: "discovered",
              },
            ],
          } satisfies SkillCatalogView
        }
      />,
    );
    assert.match(markup, /data-page="skills"/);
    assert.match(markup, /placeholder="Search Skills"/);
    assert.match(markup, /Local Review/);
    assert.match(markup, /SKILL\.md/);
    assert.match(markup, /data-enable-skill="local-review"/);
    assert.match(markup, /data-skill-directory/);
    assert.match(markup, /class="refresh-skills-button"/);
    assert.match(markup, /class="create-panel skill-directory-panel"/);
    assert.match(markup, /Add Skill Directory/);
    assert.match(markup, /data-view-skill-source="local-review"/);
    assert.match(markup, /Requires Agent capabilities.*structured-output/);
    assert.match(markup, /data-skill-catalog-list/);
    assert.match(markup, /class="skill-catalog-item"/);
    assert.match(markup, /class="skill-enable-button"/);
  });

  it("filters the rendered Skill catalog with ordered fuzzy characters", () => {
    const markup = renderToStaticMarkup(
      <SkillCatalogResults
        onArchive={() => undefined}
        onEnable={() => undefined}
        search="lrv"
        skills={[
          {
            id: "local-review",
            name: "Local Review",
            description: "Reviews changes.",
            sourceDirectory: "/skills",
            version: "sha256:abc",
            locationReference: "/skills/local-review/SKILL.md",
            status: "enabled",
          },
          {
            id: "release-notes",
            name: "Release Notes",
            description: "Writes release notes.",
            sourceDirectory: "/skills",
            version: "sha256:def",
            locationReference: "/skills/release-notes/SKILL.md",
            status: "enabled",
          },
        ]}
        t={messages.en}
      />,
    );
    assert.match(markup, /Local Review/);
    assert.doesNotMatch(markup, /Release Notes/);
  });

  it("prefers direct Skill name matches over description-only matches", () => {
    const markup = renderToStaticMarkup(
      <SkillCatalogResults
        onArchive={() => undefined}
        onEnable={() => undefined}
        search="ask"
        skills={[
          {
            id: "ask-matt",
            name: "ask-matt",
            description: "Ask which skill fits.",
            sourceDirectory: "/skills",
            version: "sha256:ask",
            locationReference: "/skills/ask-matt/SKILL.md",
            status: "discovered",
          },
          {
            id: "code-review",
            name: "code-review",
            description: "Review changes and asks for context.",
            sourceDirectory: "/skills",
            version: "sha256:review",
            locationReference: "/skills/code-review/SKILL.md",
            status: "discovered",
          },
        ]}
        t={messages.en}
      />,
    );
    assert.match(markup, /data-skill-catalog-id="ask-matt"/);
    assert.doesNotMatch(markup, /data-skill-catalog-id="code-review"/);
  });
});

describe("Position drawer", () => {
  it("edits basic identity, default Agent, and fuzzy-searchable Skills in one save", () => {
    const position = scriptedSoftwareRndDepartment.positions.find(
      (candidate) => candidate.id === "software-engineer",
    );
    assert.ok(position);
    const markup = renderToStaticMarkup(
      <PositionDrawerEditor
        agentCatalog={{
          agents: [
            {
              id: "codex",
              name: "Codex",
              status: "installed",
              version: "1.2.3",
              executablePath: "/opt/codex",
              lastDetectedAt: "2026-07-16T08:00:00.000Z",
              capabilities: ["non-interactive"],
              errorCode: null,
            },
          ],
        }}
        busy={false}
        configuration={scriptedSkillConfiguration}
        departmentId="software-rnd"
        onArchive={async () => undefined}
        onClose={() => undefined}
        onSave={async () => undefined}
        position={position}
        t={messages.en}
      />,
    );
    assert.match(markup, /data-position-drawer="software-engineer"/);
    assert.match(markup, /Default Agent/);
    assert.match(markup, /value="codex"/);
    assert.match(markup, /placeholder="Search Skills"/);
    assert.match(markup, /1 selected/);
    assert.match(markup, /data-save-position-configuration/);
    assert.match(markup, /data-position-danger-zone/);
  });
});

describe("Runtime diagnostics", () => {
  it("renders storage, lease, outbox, audit, and cursor diagnostics", () => {
    const markup = renderToStaticMarkup(
      <RuntimeDiagnosticsPanel
        busy={false}
        diagnostics={{
          schemaVersion: 20,
          sqliteIntegrity: "ok",
          databaseBytes: 4096,
          runtimeEventCount: 100,
          pendingRuntimeEventCount: 4,
          auditRecordCount: 80,
          activeLeaseCount: 2,
          cursorCount: 3,
        }}
        lastBackup={null}
        onBackup={async () => undefined}
        onCompact={async () => undefined}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-runtime-diagnostics/);
    assert.match(markup, /Schema v20/);
    assert.match(markup, /SQLite integrity.*ok/);
    assert.match(markup, /Active leases.*2/);
    assert.match(markup, /Pending Runtime events.*4/);
    assert.match(markup, /Audit records.*80/);
    assert.match(markup, /Durable cursors.*3/);
    assert.match(markup, /Compact acknowledged events/);
    assert.match(markup, /Create database backup/);
  });
});

describe("Department detail", () => {
  const pipelineProps = {
    pipelineEditor: scriptedSoftwareRndPipelineEditor,
    onSavePipelineDraft: async () => scriptedSoftwareRndPipelineEditor,
    onValidatePipeline: async () =>
      scriptedSoftwareRndPipelineEditor.validation,
    onPublishPipeline: async () => scriptedSoftwareRndPipelineEditor,
  };
  const skillProps = {
    skillConfiguration: scriptedSkillConfiguration,
    onSaveSkill: async () => scriptedSkillConfiguration,
    onArchiveSkill: async () => scriptedSkillConfiguration,
    onSetPositionSkills: async () => scriptedSkillConfiguration,
    onSaveSkillFlow: async () => scriptedSkillConfiguration,
    onArchiveSkillFlow: async () => scriptedSkillConfiguration,
    onCreatePosition: async () => undefined,
    onArchivePosition: async () => undefined,
    onCreateSecretReference: async () => undefined,
    onArchiveSecretReference: async () => undefined,
    onSaveExecutionProfile: async () => undefined,
    onArchiveExecutionProfile: async () => undefined,
  };

  it("renders Runtime-backed Overview, Positions, and editable Pipeline panels", () => {
    const overview = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="overview"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(overview, /data-page="department-detail"/);
    assert.match(overview, /Software R&amp;D/);
    assert.match(overview, /Built-in department/);
    assert.match(overview, /Published Pipeline v2/);
    assert.match(overview, /5 positions/);
    assert.match(positions, /Product Planner/);
    assert.match(positions, /Software Architect/);
    assert.match(positions, /Software Engineer/);
    assert.match(positions, /Reviewer/);
    assert.match(positions, /Evaluator/);
    assert.match(pipeline, /data-pipeline-draft-revision="0"/);
    assert.match(pipeline, /data-pipeline-published-version="2"/);
    assert.match(pipeline, /Product alignment/);
    assert.match(pipeline, /Technical plan/);
    assert.match(pipeline, /Human acceptance/);
    assert.match(pipeline, /Save Draft/);
    assert.match(pipeline, /Full-screen editor/);
    assert.match(pipeline, /Validate/);
    assert.match(pipeline, /Publish/);
    assert.match(pipeline, /data-pipeline-canvas/);
    assert.match(pipeline, /data-pipeline-node-library/);
    assert.match(pipeline, /data-pipeline-canvas-node="technical-plan"/);
    assert.match(pipeline, /data-pipeline-inspector/);
    assert.match(pipeline, /Accessible list editor/);
    assert.match(pipeline, /data-pipeline-node-editor="technical-plan"/);
    assert.match(
      pipeline,
      /data-pipeline-edge-editor="start:product-alignment"/,
    );
    assert.match(pipeline, /data-pipeline-history-version="1"/);
  });

  it("renders the complete AI Task configuration in the visual Inspector", () => {
    const aiTask = scriptedSoftwareRndPipelineEditor.draft.graph.nodes.find(
      (node) => node.id === "implementation",
    );
    assert.ok(aiTask);
    const inspectorEditor = {
      ...scriptedSoftwareRndPipelineEditor,
      draft: {
        ...scriptedSoftwareRndPipelineEditor.draft,
        graph: {
          ...scriptedSoftwareRndPipelineEditor.draft.graph,
          nodes: [
            {
              ...aiTask,
              instructions: "Implement the approved plan.",
              executionProfileId: "default",
              inputContractRefs: ["technical-plan"],
              outputContractRefs: ["implementation"],
              timeoutSeconds: 900,
              retryMaxAttempts: 2,
              maxIterations: 6,
              maxTokens: 32_000,
            },
            ...scriptedSoftwareRndPipelineEditor.draft.graph.nodes.filter(
              (node) => node.id !== aiTask.id,
            ),
          ],
        },
      },
    };
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
        pipelineEditor={inspectorEditor}
      />,
    );

    assert.match(pipeline, /Draft based on.*v2/);
    assert.match(pipeline, /data-pipeline-inspector-field="instructions"/);
    assert.match(pipeline, /data-pipeline-inspector-field="execution-profile"/);
    assert.match(pipeline, /data-pipeline-inspector-field="input-contracts"/);
    assert.match(pipeline, /data-pipeline-inspector-field="output-contracts"/);
    assert.match(pipeline, /data-pipeline-inspector-field="timeout"/);
    assert.match(pipeline, /data-pipeline-inspector-field="retry"/);
    assert.match(pipeline, /data-pipeline-inspector-field="max-iterations"/);
    assert.match(pipeline, /data-pipeline-inspector-field="max-tokens"/);
  });

  it("renders Department and Position edit controls from the deep Runtime read model", () => {
    const detail = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="overview"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(detail, /data-department-settings/);
    assert.match(detail, /Save department/);
    assert.match(detail, /Archive department/);
    assert.match(detail, /Copy department/);
    assert.match(positions, /data-position-editor="software-engineer"/);
    assert.match(positions, /AI Member display name/);
    assert.match(positions, /Save position/);
  });

  it("separates the read-only Department overview from layered Settings", () => {
    const props = {
      department: scriptedSoftwareRndDepartment,
      t: messages.en,
      onBack: () => undefined,
      onTabChange: () => undefined,
      onUpdateDepartment: async () => undefined,
      onArchiveDepartment: async () => undefined,
      onCopyDepartment: async () => undefined,
      onUpdatePosition: async () => undefined,
      onConfigurePosition: async () => undefined,
      agentCatalog: {
        agents: [
          {
            id: "codex",
            name: "Codex",
            status: "installed" as const,
            version: "1.2.3",
            executablePath: "/opt/codex",
            lastDetectedAt: "2026-07-16T08:00:00.000Z",
            capabilities: ["non-interactive" as const],
            errorCode: null,
          },
        ],
      },
      ...pipelineProps,
      ...skillProps,
    };
    const overview = renderToStaticMarkup(
      <DepartmentDetailView {...props} activeTab="overview" />,
    );
    const settings = renderToStaticMarkup(
      <DepartmentDetailView {...props} activeTab="settings" />,
    );
    assert.match(overview, /data-department-panel="overview"/);
    assert.match(overview, /Department summary/);
    assert.doesNotMatch(overview, /data-department-settings/);
    assert.match(settings, /data-department-settings/);
    assert.match(settings, /data-artifact-contract-settings/);
    assert.match(settings, /data-department-advanced-settings/);
    assert.match(settings, /data-run-environment-toggle/);
    assert.match(settings, /Edit advanced run environment/);
    assert.match(settings, /data-save-department-settings/);
    assert.match(settings, /Run environments/);
    assert.match(settings, /Agent provider/);
    assert.match(settings, /Sandbox environment/);
    assert.doesNotMatch(settings, /Save Execution Profile/);
    assert.doesNotMatch(settings, /Create Secret Reference/);
    assert.doesNotMatch(settings, /Provider reference/);
    assert.doesNotMatch(settings, /Sandbox reference/);
  });

  it("renders a stable unpublished Pipeline state for a custom Department", () => {
    const customDepartment = {
      ...scriptedSoftwareRndDepartment,
      id: "custom-department",
      name: "Design",
      builtIn: false,
      positions: [],
      pipeline: null,
    };
    const customPipelineEditor = {
      ...scriptedSoftwareRndPipelineEditor,
      department: { id: "custom-department", name: "Design" },
      positions: [],
      draft: {
        revision: 0,
        updatedAt: null,
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [{ from: "start", to: "complete" }],
        },
      },
      validation: { valid: true, issues: [] },
      published: null,
      history: [],
    };
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={customDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        pipelineEditor={customPipelineEditor}
        onSavePipelineDraft={async () => customPipelineEditor}
        onValidatePipeline={async () => customPipelineEditor.validation}
        onPublishPipeline={async () => customPipelineEditor}
        {...skillProps}
      />,
    );

    assert.match(pipeline, /data-pipeline-state="draft-only"/);
    assert.match(pipeline, /No Pipeline has been published yet/);
    assert.match(pipeline, /Save Draft/);
  });

  it("localizes stable Runtime validation codes in the Pipeline editor", () => {
    const invalidEditor = {
      ...scriptedSoftwareRndPipelineEditor,
      validation: {
        valid: false,
        issues: [
          {
            code: "START_COUNT_INVALID",
            messageKey: "pipeline.validation.startCount",
          },
        ],
      },
    };
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        pipelineEditor={invalidEditor}
        onSavePipelineDraft={async () => invalidEditor}
        onValidatePipeline={async () => invalidEditor.validation}
        onPublishPipeline={async () => invalidEditor}
        {...skillProps}
      />,
    );

    assert.match(pipeline, /data-pipeline-validation="invalid"/);
    assert.match(pipeline, /data-validation-code="START_COUNT_INVALID"/);
    assert.match(
      pipeline,
      /The Pipeline must contain exactly one Start node\./,
    );
  });

  it("renders Runtime-backed Skill bindings, Skill Flows, and AI Task Flow selection", () => {
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const pipeline = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="pipeline"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(positions, /data-skill-configuration/);
    assert.match(positions, /data-skill-catalog/);
    assert.match(positions, /Test-Driven Development/);
    assert.match(positions, /data-position-skill-binding="software-engineer"/);
    assert.match(positions, /data-skill-flow-editor="implementation-flow"/);
    assert.match(positions, /Implement one tested vertical slice at a time./);
    assert.match(positions, /Archive Skill Flow/);
    assert.match(pipeline, /data-pipeline-node-skill-flow="implementation"/);
    assert.match(pipeline, /Implementation/);
  });

  it("renders stable Skill Configuration error codes for conflict guidance", () => {
    const markup = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        error="Skill Flow revision is stale. Reload and try again."
        skillErrorCode="VERSION_CONFLICT"
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(markup, /data-skill-error-code="VERSION_CONFLICT"/);
    assert.match(markup, /configuration changed in another view/);
  });

  it("explains blocked Skill and Skill Flow archive errors in English and Chinese", () => {
    const english = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        error="fallback"
        skillErrorCode="SKILL_FLOW_IN_USE"
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const chinese = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.zh}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        error="fallback"
        skillErrorCode="SKILL_IN_USE"
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(english, /current Pipeline Draft or active Pipeline Version/);
    assert.match(chinese, /仍有 Position 或活跃 Skill Flow 正在使用它/);
  });

  it("renders Department contracts, Execution Profiles, Secret References, and Position lifecycle controls", () => {
    const overview = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="overview"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );
    const positions = renderToStaticMarkup(
      <DepartmentDetailView
        department={scriptedSoftwareRndDepartment}
        t={messages.en}
        activeTab="positions"
        onBack={() => undefined}
        onTabChange={() => undefined}
        onUpdateDepartment={async () => undefined}
        onArchiveDepartment={async () => undefined}
        onCopyDepartment={async () => undefined}
        onUpdatePosition={async () => undefined}
        {...pipelineProps}
        {...skillProps}
      />,
    );

    assert.match(overview, /data-artifact-contracts="input"/);
    assert.match(overview, /data-artifact-contracts="output"/);
    assert.match(
      overview,
      /Formal inputs required before this Department Run can start\./,
    );
    assert.match(overview, /No input artifacts are required\./);
    assert.match(overview, /No output artifacts are required\./);
    assert.match(overview, /data-execution-profiles/);
    assert.match(
      overview,
      /data-execution-profile-editor="software-rnd-default"/,
    );
    assert.match(overview, /data-secret-references/);
    assert.match(overview, /no secret value is saved/);
    assert.match(positions, /data-new-position/);
    assert.match(positions, /data-archive-position="software-engineer"/);
    assert.match(positions, /data-archive-skill="tdd"/);
  });
});

describe("Project detail", () => {
  it("renders Approve and Reject actions for a waiting Human Approval", () => {
    const waitingRun = {
      ...scriptedDepartmentRun,
      run: {
        ...scriptedDepartmentRun.run,
        status: "waiting-approval" as const,
        revision: 2,
      },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          pipelineVersion: {
            ...scriptedDepartmentRun.snapshot.payload.pipelineVersion,
            graph: {
              nodes: [
                { id: "start", type: "start" as const, name: "Start" },
                {
                  id: "approval",
                  type: "human-approval" as const,
                  name: "Approval",
                },
                { id: "complete", type: "complete" as const, name: "Complete" },
              ],
              edges: [
                { from: "start", to: "approval" },
                { from: "approval", to: "complete" },
              ],
            },
          },
        },
      },
      nodes: [
        { ...scriptedDepartmentRun.nodes[0]!, status: "succeeded" as const },
        {
          id: "node-run-approval",
          runId: "run-1",
          pipelineNodeId: "approval",
          nodeType: "human-approval" as const,
          status: "waiting-approval" as const,
          attemptCount: 0,
          attempts: [],
          approvals: [
            {
              id: "approval-cycle-1",
              cycle: 1,
              status: "pending" as const,
              decision: null,
              createdAt: "2026-07-15T00:00:00.000Z",
              decidedAt: null,
            },
          ],
          requiredDependencyIds: ["start"],
          result: null,
          failure: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
        {
          ...scriptedDepartmentRun.nodes[1]!,
          requiredDependencyIds: ["approval"],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onDecision={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onFork={() => undefined}
        run={waitingRun}
        t={messages.en}
      />,
    );

    assert.match(markup, /data-run-approval-decision="approve"/);
    assert.match(markup, /data-run-approval-decision="request-changes"/);
    assert.match(markup, /data-run-approval-decision="reject"/);
    assert.match(markup, /data-run-approval-feedback/);
    assert.match(markup, /data-run-approval-cycle="1"/);
    assert.match(markup, /data-run-control="pause"/);
    assert.match(markup, /data-run-control="cancel"/);
    assert.match(markup, /data-run-fork-node=/);
    assert.match(markup, />Approve</);
    assert.match(markup, />Request changes</);
    assert.match(markup, />Reject</);
  });

  it("renders failed AI Task recovery and persisted Continue Run actions", () => {
    const failedRun: DepartmentRunView = {
      ...scriptedDepartmentRun,
      run: {
        ...scriptedDepartmentRun.run,
        status: "failed",
        revision: 2,
      },
      snapshot: {
        ...scriptedDepartmentRun.snapshot,
        payload: {
          ...scriptedDepartmentRun.snapshot.payload,
          pipelineVersion: {
            ...scriptedDepartmentRun.snapshot.payload.pipelineVersion,
            graph: {
              nodes: [
                { id: "start", type: "start", name: "Start" },
                {
                  id: "implement",
                  type: "ai-task",
                  name: "Implement",
                  positionId: "engineer",
                },
                { id: "complete", type: "complete", name: "Complete" },
              ],
              edges: [
                { from: "start", to: "implement" },
                { from: "implement", to: "complete" },
              ],
            },
          },
          executionProfiles:
            scriptedDepartmentRun.snapshot.payload.executionProfiles.map(
              (profile) => ({
                ...profile,
                retryPolicy: { maxAttempts: 1 },
              }),
            ),
        },
      },
      nodes: [
        { ...scriptedDepartmentRun.nodes[0]!, status: "succeeded" },
        {
          id: "node-run-implement",
          runId: "run-1",
          pipelineNodeId: "implement",
          nodeType: "ai-task",
          status: "failed",
          attemptCount: 1,
          attempts: [
            {
              id: "attempt-1",
              attemptNumber: 1,
              snapshotRevisionId: "snapshot-1",
              reason: "initial",
              recoverable: false,
              status: "failed",
              result: null,
              failure: {
                code: "SCRIPTED_AGENT_FAILED",
                message: "The first attempt failed.",
              },
              feedback: [],
              createdAt: "2026-07-15T00:00:00.000Z",
              startedAt: "2026-07-15T00:00:00.000Z",
              completedAt: "2026-07-15T00:01:00.000Z",
            },
          ],
          approvals: [],
          requiredDependencyIds: ["start"],
          result: null,
          failure: {
            code: "SCRIPTED_AGENT_FAILED",
            message: "The first attempt failed.",
          },
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:01:00.000Z",
        },
        {
          ...scriptedDepartmentRun.nodes[1]!,
          requiredDependencyIds: ["implement"],
        },
      ],
    };
    const failedMarkup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onDecision={() => undefined}
        onRetry={() => undefined}
        run={failedRun}
        t={messages.en}
      />,
    );
    assert.match(failedMarkup, /data-run-node-retry="node-run-implement"/);
    assert.match(failedMarkup, /data-run-retry-feedback/);
    assert.match(failedMarkup, /Retries remaining: 1/);
    assert.match(failedMarkup, /SCRIPTED_AGENT_FAILED/);
    assert.match(failedMarkup, /data-run-recovery/);
    assert.match(failedMarkup, /data-run-recovery-provider/);
    assert.match(failedMarkup, /data-run-recovery-model/);
    assert.match(failedMarkup, /data-run-recover/);

    const readyAttempt = {
      ...failedRun.nodes[1]!.attempts[0]!,
      id: "attempt-2",
      attemptNumber: 2,
      reason: "retry" as const,
      status: "ready" as const,
      failure: null,
      startedAt: null,
      completedAt: null,
    };
    const recoveringRun: DepartmentRunView = {
      ...failedRun,
      run: { ...failedRun.run, status: "recovering", revision: 3 },
      nodes: failedRun.nodes.map((node) =>
        node.id === "node-run-implement"
          ? {
              ...node,
              status: "ready",
              attemptCount: 2,
              attempts: [...node.attempts, readyAttempt],
              failure: null,
            }
          : node,
      ),
    };
    const recoveringMarkup = renderToStaticMarkup(
      <DepartmentRunDetail
        busy={false}
        onContinue={() => undefined}
        onControl={() => undefined}
        onRecover={() => undefined}
        onDecision={() => undefined}
        onRetry={() => undefined}
        run={recoveringRun}
        t={messages.en}
      />,
    );
    assert.match(recoveringMarkup, /data-run-continue/);
    assert.match(recoveringMarkup, /data-run-control="pause"/);
    assert.match(recoveringMarkup, /data-run-control="cancel"/);
    assert.match(recoveringMarkup, />Continue run</);
  });

  it("renders the Runtime-backed Project configuration editor", () => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 1,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web", "/work/checkout-api"],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <ProjectDetailView
        project={project}
        t={messages.en}
        onBack={() => undefined}
        onSave={async () => project}
        onArchive={async () => project}
      />,
    );

    assert.match(markup, /data-page="project-detail"/);
    assert.match(markup, /data-runtime-project-id="project-1"/);
    assert.match(markup, /Project revision 1/);
    assert.match(markup, /Preserve the payment-provider contract\./);
    assert.match(markup, /data-project-repository="\/work\/checkout-web"/);
    assert.match(markup, /data-project-repository="\/work\/checkout-api"/);
    assert.match(markup, /Add repository reference/);
    assert.match(markup, /Save project/);
    assert.match(markup, /Archive project/);
    assert.match(markup, /data-project-runs/);
    assert.match(markup, /data-start-department-run/);
    assert.match(markup, /Start Department Run/);
  });
});
