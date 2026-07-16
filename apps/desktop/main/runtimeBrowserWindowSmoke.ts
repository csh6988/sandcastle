import { once } from "node:events";
import type { BrowserWindow } from "electron";
import {
  DepartmentInspectSchema,
  DepartmentPipelineEditorViewSchema,
  DepartmentRunViewSchema,
  ProjectEditorViewSchema,
  RuntimeHealthSchema,
  SkillConfigurationViewSchema,
  type DepartmentInspect,
  type DepartmentPipelineEditorView,
  type RuntimeHealth,
  type ProjectEditorView,
  type SkillConfigurationView,
} from "../runtime/interface.js";

export interface RuntimeBrowserWindowSmokeReport {
  readonly beforeReload: RuntimeHealth;
  readonly afterReload: RuntimeHealth;
  readonly overviewVisible: boolean;
  readonly projectsPageVisible: boolean;
  readonly projectRuntimeId: string;
  readonly projectRevision: number;
  readonly projectRepositoryReferences: readonly string[];
  readonly projectVersionConflictVisible: boolean;
  readonly projectReloadSharedContext: string;
  readonly archivedProjectVisible: boolean;
  readonly departmentsPageVisible: boolean;
  readonly departmentRuntimeId: string;
  readonly departmentPositionCount: number;
  readonly pipelineVersion: number;
  readonly pipelineDraftRevision: number;
  readonly pipelineNodeIds: readonly string[];
  readonly pipelineValidationVisible: boolean;
  readonly pipelineHistoryVersions: readonly number[];
  readonly legacyBoardNavigationVisible: boolean;
  readonly updatedDepartmentName: string;
  readonly updatedMemberDisplayName: string;
  readonly skillConfigurationRevision: number;
  readonly positionSkillIds: readonly string[];
  readonly createdSkillFlowId: string;
  readonly skillFlowRevision: number;
  readonly skillFlowConflictVisible: boolean;
  readonly skillBlockedArchiveVisible: boolean;
  readonly skillBlockedArchiveMessage: string;
  readonly archivedSkillFlowStatus: string;
  readonly copiedDepartmentId: string;
  readonly archivedDepartmentVisible: boolean;
  readonly unpublishedPipelineVisible: boolean;
  readonly customPublishedPipelineVersion: number;
  readonly reloadPublishedPipelineVersion: number;
  readonly pipelineSkillFlowId: string;
  readonly reloadPipelineSkillFlowId: string;
  readonly pipelineInstructions: string;
  readonly pipelineExecutionProfileId: string;
  readonly positionLifecycleStatus: string;
  readonly configuredExecutionProfileId: string;
  readonly configuredSecretReferenceId: string;
  readonly runRuntimeId: string;
  readonly runStatus: string;
  readonly runSnapshotHash: string;
  readonly runResolvedAgentId: string;
  readonly runAgentSource: string;
  readonly runAttemptCount: number;
  readonly runApprovalCycles: number;
  readonly reloadRunStatus: string;
  readonly interactionSessionStatus: string;
  readonly permissionStatus: string;
  readonly agUiEventCount: number;
  readonly memoryRecordVersion: number;
  readonly backupSchemaVersion: number;
}

const waitForSelector = async (
  window: BrowserWindow,
  selector: string,
): Promise<boolean> =>
  Boolean(
    await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (document.querySelector(${JSON.stringify(selector)})) {
            resolve(true);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(false);
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      })`,
      true,
    ),
  );

const clickUntilSelector = async (
  window: BrowserWindow,
  triggerSelector: string,
  targetSelector: string,
): Promise<boolean> =>
  Boolean(
    await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (document.querySelector(${JSON.stringify(targetSelector)})) {
            resolve(true);
            return;
          }
          document.querySelector(${JSON.stringify(triggerSelector)})?.click();
          if (Date.now() >= deadline) {
            resolve(false);
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      })`,
      true,
    ),
  );

export const runRuntimeBrowserWindowSmoke = async (
  window: BrowserWindow,
): Promise<RuntimeBrowserWindowSmokeReport> => {
  await once(window.webContents, "did-finish-load");
  const beforeReload = RuntimeHealthSchema.parse(
    await window.webContents.executeJavaScript(
      "window.sandcastle.runtime.health()",
      true,
    ),
  );
  const reloaded = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await reloaded;
  const afterReload = RuntimeHealthSchema.parse(
    await window.webContents.executeJavaScript(
      "window.sandcastle.runtime.health()",
      true,
    ),
  );
  const overviewVisible = Boolean(
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-page=company-overview]') !== null",
      true,
    ),
  );
  if (!overviewVisible) {
    throw new Error("Company Overview was not the packaged app entry page.");
  }
  const legacyBoardNavigationVisible = Boolean(
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-nav=runs]') !== null",
      true,
    ),
  );
  if (legacyBoardNavigationVisible) {
    throw new Error("Legacy Runs / Board navigation is still visible.");
  }
  const projectsPageVisible = Boolean(
    await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        document.querySelector('[data-nav=projects]')?.click();
        requestAnimationFrame(() =>
          resolve(document.querySelector('[data-page=projects]') !== null),
        );
      })`,
      true,
    ),
  );
  if (!projectsPageVisible) {
    throw new Error("Runtime-backed Projects page was not reachable.");
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const form = document.querySelector('[data-page=projects] .create-panel form');
      const name = document.querySelector('#company-project-name');
      const goal = document.querySelector('#company-project-goal');
      if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLInputElement) || !(goal instanceof HTMLTextAreaElement)) return false;
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(name, 'Checkout');
      setValue(goal, 'Ship the checkout redesign');
      form.requestSubmit();
      return true;
    })()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-page=project-detail]"))) {
    throw new Error("Created Project configuration did not open.");
  }
  const projectRuntimeId = String(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-page=project-detail]')?.getAttribute('data-runtime-project-id')`,
      true,
    ),
  );
  const initialProject = ProjectEditorViewSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.inspectProject(${JSON.stringify(projectRuntimeId)})`,
      true,
    ),
  );
  await window.webContents.executeJavaScript(
    `(() => {
      const name = document.querySelector('#project-detail-name');
      const goal = document.querySelector('#project-detail-goal');
      const context = document.querySelector('#project-shared-context');
      if (!(name instanceof HTMLInputElement) || !(goal instanceof HTMLTextAreaElement) || !(context instanceof HTMLTextAreaElement)) return false;
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(name, 'Checkout Platform');
      setValue(goal, 'Ship a resilient checkout platform');
      setValue(context, 'Preserve the payment-provider contract.');
      return true;
    })()`,
    true,
  );
  for (const reference of ["/work/checkout-web", "/work/checkout-api"]) {
    await window.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('#project-repository-reference');
        const button = document.querySelector('.project-repository-add button');
        if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(reference)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => button.click(), 0);
        return true;
      })()`,
      true,
    );
    if (
      !(await waitForSelector(
        window,
        `[data-project-repository=${JSON.stringify(reference)}]`,
      ))
    ) {
      throw new Error(
        `Project repository reference ${reference} was not added.`,
      );
    }
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-project-repository="/work/checkout-web"] button')?.click()`,
    true,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-project-settings]')?.requestSubmit()`,
    true,
  );
  const savedProject = await waitForRuntimeProject(
    window,
    projectRuntimeId,
    (project) =>
      project.revision === 1 &&
      project.name === "Checkout Platform" &&
      project.repositoryReferences.length === 1 &&
      project.repositoryReferences[0] === "/work/checkout-api",
  );
  const externallyUpdatedProject = ProjectEditorViewSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.updateProject({
        projectId: ${JSON.stringify(projectRuntimeId)},
        expectedRevision: 1,
        name: 'Checkout Platform',
        goal: 'Ship a resilient checkout platform',
        sharedContext: 'Reloaded from the authoritative Runtime.',
        repositoryReferences: ['/work/checkout-api']
      })`,
      true,
    ),
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-project-settings]')?.requestSubmit()`,
    true,
  );
  const projectVersionConflictVisible = await waitForSelector(
    window,
    "[data-project-error-code=VERSION_CONFLICT]",
  );
  if (!projectVersionConflictVisible) {
    throw new Error("Stale Project save did not display VERSION_CONFLICT.");
  }
  const projectReload = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await projectReload;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=projects]')?.click()`,
    true,
  );
  const projectSelector = `[data-project-id="${projectRuntimeId}"]`;
  if (!(await waitForSelector(window, projectSelector))) {
    throw new Error("Saved Project was not loaded after Renderer reload.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(projectSelector)})?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      `[data-page=project-detail][data-project-revision="${externallyUpdatedProject.revision}"]`,
    ))
  ) {
    throw new Error("Reloaded Project did not use the Runtime revision.");
  }
  const projectReloadSharedContext = String(
    await window.webContents.executeJavaScript(
      `(document.querySelector('#project-shared-context') instanceof HTMLTextAreaElement ? document.querySelector('#project-shared-context').value : '')`,
      true,
    ),
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-project-archive]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-page=projects]"))) {
    throw new Error("Archived Project did not return to the active list.");
  }
  const archivedProjectVisible = Boolean(
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(projectSelector)}) !== null`,
      true,
    ),
  );
  const archivedProject = await waitForRuntimeProject(
    window,
    projectRuntimeId,
    (project) => project.status === "archived" && project.revision === 3,
  );
  if (
    archivedProject.repositoryReferences[0] !== "/work/checkout-api" ||
    initialProject.revision !== 0
  ) {
    throw new Error("Archived Project did not retain configuration history.");
  }
  const departmentsPageVisible = Boolean(
    await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        document.querySelector('[data-nav=departments]')?.click();
        requestAnimationFrame(() =>
          resolve(document.querySelector('[data-page=departments]') !== null),
        );
      })`,
      true,
    ),
  );
  if (!departmentsPageVisible) {
    throw new Error("Runtime-backed Departments page was not reachable.");
  }
  if (!(await waitForSelector(window, "[data-department-id=software-rnd]"))) {
    throw new Error("Software R&D Department was not loaded from the Runtime.");
  }
  const runtimeDepartment = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.inspectDepartment("software-rnd")`,
      true,
    ),
  );
  if (!runtimeDepartment.pipeline) {
    throw new Error("Software R&D Department has no published Pipeline.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-id=software-rnd]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-page=department-detail]"))) {
    throw new Error("Software R&D Department detail did not open.");
  }
  const departmentRuntimeId = String(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-page=department-detail]')?.getAttribute('data-runtime-department-id')`,
      true,
    ),
  );
  if (departmentRuntimeId !== runtimeDepartment.id) {
    throw new Error("Department detail did not match the Runtime read model.");
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=settings]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-department-settings]"))) {
    throw new Error("Department Settings panel was not reachable.");
  }

  await window.webContents.executeJavaScript(
    `(() => {
      const form = document.querySelector('[data-department-settings]');
      const name = document.querySelector('#department-detail-name');
      const description = document.querySelector('#department-detail-description');
      if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLInputElement) || !(description instanceof HTMLTextAreaElement)) return false;
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(name, 'Product Engineering');
      setValue(description, 'Builds and verifies product changes.');
      form.requestSubmit();
      return true;
    })()`,
    true,
  );
  const updatedDepartment = await waitForRuntimeDepartment(
    window,
    "software-rnd",
    (department) => department.name === "Product Engineering",
  );
  const departmentWithSecret = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.createSecretReference({
        departmentId: 'software-rnd',
        name: 'Browser smoke reference',
        providerScope: 'openai'
      })`,
      true,
    ),
  );
  const configuredSecretReference = departmentWithSecret.secretReferences.find(
    (reference) => reference.name === "Browser smoke reference",
  );
  if (!configuredSecretReference) {
    throw new Error("BrowserWindow smoke did not create a Secret Reference.");
  }
  const departmentWithProfile = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.saveExecutionProfile({
        departmentId: 'software-rnd',
        expectedRevision: 0,
        name: 'Browser smoke profile',
        providerRef: 'openai',
        model: 'gpt-5',
        sandboxRef: 'docker',
        branchStrategy: 'merge-to-head',
        timeoutSeconds: 900,
        maxIterations: 8,
        maxTokens: 100000,
        retryMaxAttempts: 2,
        permissionPolicy: 'ask',
        secretReferenceIds: [${JSON.stringify(configuredSecretReference.id)}]
      })`,
      true,
    ),
  );
  const configuredExecutionProfile =
    departmentWithProfile.executionProfiles.find(
      (profile) => profile.name === "Browser smoke profile",
    );
  if (!configuredExecutionProfile) {
    throw new Error("BrowserWindow smoke did not create an Execution Profile.");
  }
  await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.updateDepartment({
      departmentId: 'software-rnd',
      expectedRevision: 1,
      name: 'Product Engineering',
      description: 'Builds and verifies product changes.',
      inputArtifactContracts: [{
        id: 'task-input',
        name: 'Task input',
        artifactType: 'application/vnd.sandcastle.task+json',
        schemaVersion: '1',
        required: true
      }],
      outputArtifactContracts: [{
        id: 'verified-delivery',
        name: 'Verified delivery',
        artifactType: 'application/vnd.sandcastle.delivery+json',
        schemaVersion: '1',
        required: false
      }],
      defaultExecutionProfileId: ${JSON.stringify(configuredExecutionProfile.id)}
    })`,
    true,
  );

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=positions]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-department-panel=positions]"))) {
    throw new Error("Department Positions panel was not reachable.");
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const form = document.querySelector('[data-position-editor=software-engineer] form');
      const responsibility = document.querySelector('#position-responsibility-software-engineer');
      const displayName = document.querySelector('#position-member-name-software-engineer');
      const status = document.querySelector('#position-member-status-software-engineer');
      if (!(form instanceof HTMLFormElement) || !(responsibility instanceof HTMLTextAreaElement) || !(displayName instanceof HTMLInputElement) || !(status instanceof HTMLSelectElement)) return false;
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(responsibility, 'Ships tested vertical slices.');
      setValue(displayName, 'Delivery Engineer');
      setValue(status, 'inactive');
      form.requestSubmit();
      return true;
    })()`,
    true,
  );
  const configuredDepartment = await waitForRuntimeDepartment(
    window,
    "software-rnd",
    (department) =>
      department.positions.some(
        (position) =>
          position.id === "software-engineer" &&
          position.aiMember.displayName === "Delivery Engineer" &&
          position.aiMember.status === "inactive",
      ),
  );

  if (!(await waitForSelector(window, "[data-skill-configuration]"))) {
    throw new Error("Runtime-backed Skill Configuration was not rendered.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-archive-skill="tdd"]')?.click()`,
    true,
  );
  const skillBlockedArchiveVisible = await waitForSelector(
    window,
    "[data-skill-error-code=SKILL_IN_USE]",
  );
  const skillBlockedArchiveMessage = String(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-skill-error-code=SKILL_IN_USE]')?.textContent ?? ''`,
      true,
    ),
  );
  if (
    !skillBlockedArchiveVisible ||
    (!skillBlockedArchiveMessage.includes("cannot be archived") &&
      !skillBlockedArchiveMessage.includes("无法归档"))
  ) {
    throw new Error(
      "Blocked Skill archive did not show a structured, explanatory error.",
    );
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const checkbox = document.querySelector('[data-position-skill="software-engineer:code-review"]');
      const save = document.querySelector('[data-save-position-skills="software-engineer"]');
      if (!(checkbox instanceof HTMLInputElement) || !(save instanceof HTMLButtonElement)) return false;
      checkbox.click();
      save.click();
      return true;
    })()`,
    true,
  );
  await waitForRuntimeSkillConfiguration(
    window,
    "software-rnd",
    (configuration) =>
      configuration.revision === 1 &&
      configuration.positions
        .find((position) => position.id === "software-engineer")
        ?.skillIds.includes("code-review") === true,
  );

  await window.webContents.executeJavaScript(
    `(() => {
      const flow = document.querySelector('[data-skill-flow-editor="implementation-flow"]');
      const instructions = document.querySelector('[data-skill-flow-instructions="implementation-flow"]');
      const diagnosing = document.querySelector('[data-skill-flow-skill="implementation-flow:diagnosing-bugs"]');
      if (!(flow instanceof HTMLFormElement) || !(instructions instanceof HTMLTextAreaElement) || !(diagnosing instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(instructions.constructor.prototype, 'value')?.set;
      setter?.call(instructions, 'Ship one tested BrowserWindow vertical slice.');
      instructions.dispatchEvent(new Event('input', { bubbles: true }));
      if (diagnosing.checked) diagnosing.click();
      flow.requestSubmit();
      return true;
    })()`,
    true,
  );
  const editedSkillFlow = await waitForRuntimeSkillConfiguration(
    window,
    "software-rnd",
    (configuration) =>
      configuration.skillFlows.some(
        (flow) =>
          flow.id === "implementation-flow" &&
          flow.revision === 1 &&
          flow.instructions ===
            "Ship one tested BrowserWindow vertical slice." &&
          flow.skillIds.length === 1 &&
          flow.skillIds[0] === "tdd",
      ),
  );

  await waitForSelector(window, '[data-skill-configuration-revision="2"]');
  await window.webContents.executeJavaScript(
    `(() => {
      const checkbox = document.querySelector('[data-position-skill="software-engineer:diagnosing-bugs"]');
      const save = document.querySelector('[data-save-position-skills="software-engineer"]');
      if (!(checkbox instanceof HTMLInputElement) || !(save instanceof HTMLButtonElement)) return false;
      if (checkbox.checked) checkbox.click();
      save.click();
      return true;
    })()`,
    true,
  );
  const reboundSkills = await waitForRuntimeSkillConfiguration(
    window,
    "software-rnd",
    (configuration) =>
      configuration.revision === 3 &&
      JSON.stringify(
        configuration.positions.find(
          (position) => position.id === "software-engineer",
        )?.skillIds,
      ) === JSON.stringify(["code-review", "tdd"]),
  );

  await window.webContents.executeJavaScript(
    `(() => {
      const form = document.querySelector('[data-new-skill-flow="software-engineer"]');
      const name = document.querySelector('#new-skill-flow-name-software-engineer');
      const instructions = document.querySelector('#new-skill-flow-instructions-software-engineer');
      const tdd = document.querySelector('[data-skill-flow-skill="new:software-engineer:tdd"]');
      const review = document.querySelector('[data-skill-flow-skill="new:software-engineer:code-review"]');
      if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLInputElement) || !(instructions instanceof HTMLTextAreaElement) || !(tdd instanceof HTMLInputElement) || !(review instanceof HTMLInputElement)) return false;
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(name, 'Browser delivery');
      setValue(instructions, 'Deliver and review the BrowserWindow slice.');
      if (!tdd.checked) tdd.click();
      if (!review.checked) review.click();
      form.requestSubmit();
      return true;
    })()`,
    true,
  );
  const createdSkillConfiguration = await waitForRuntimeSkillConfiguration(
    window,
    "software-rnd",
    (configuration) =>
      configuration.revision === 4 &&
      configuration.skillFlows.some(
        (flow) => flow.name === "Browser delivery" && flow.revision === 0,
      ),
  );
  const createdSkillFlow = createdSkillConfiguration.skillFlows.find(
    (flow) => flow.name === "Browser delivery",
  );
  if (!createdSkillFlow) {
    throw new Error("BrowserWindow smoke did not create a Skill Flow.");
  }
  await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.saveSkillFlow({
      departmentId: 'software-rnd',
      skillFlowId: ${JSON.stringify(createdSkillFlow.id)},
      positionId: 'software-engineer',
      expectedRevision: 0,
      name: 'External browser flow',
      instructions: 'Updated outside the current Renderer read model.',
      skillIds: ['tdd']
    })`,
    true,
  );
  await window.webContents.executeJavaScript(
    `(() => {
      const form = document.querySelector('[data-skill-flow-editor=${JSON.stringify(createdSkillFlow.id)}]');
      const name = document.querySelector('[data-skill-flow-name=${JSON.stringify(createdSkillFlow.id)}]');
      if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(name.constructor.prototype, 'value')?.set;
      setter?.call(name, 'Stale Browser flow');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      return true;
    })()`,
    true,
  );
  const skillFlowConflictVisible = await waitForSelector(
    window,
    "[data-skill-error-code=VERSION_CONFLICT]",
  );
  if (!skillFlowConflictVisible) {
    throw new Error("Stale Skill Flow save did not display VERSION_CONFLICT.");
  }

  const skillReload = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await skillReload;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=departments]')?.click()`,
    true,
  );
  await waitForSelector(window, "[data-department-id=software-rnd]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-id=software-rnd]')?.click()`,
    true,
  );
  await waitForSelector(window, "[data-page=department-detail]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=positions]')?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      `[data-archive-skill-flow=${JSON.stringify(createdSkillFlow.id)}]`,
    ))
  ) {
    throw new Error("Reloaded Skill Flow was not rendered from the Runtime.");
  }
  const reloadedSkills = await waitForRuntimeSkillConfiguration(
    window,
    "software-rnd",
    (configuration) =>
      configuration.skillFlows.some(
        (flow) =>
          flow.id === createdSkillFlow.id &&
          flow.name === "External browser flow" &&
          flow.revision === 1,
      ),
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-archive-skill-flow=${JSON.stringify(createdSkillFlow.id)}]')?.click()`,
    true,
  );
  const archivedSkills = await waitForRuntimeSkillConfiguration(
    window,
    "software-rnd",
    (configuration) =>
      configuration.skillFlows.some(
        (flow) => flow.id === createdSkillFlow.id && flow.status === "archived",
      ),
  );
  if (
    !(await waitForSelector(
      window,
      `[data-skill-flow-history=${JSON.stringify(createdSkillFlow.id)}]`,
    ))
  ) {
    throw new Error("Archived Skill Flow history was not rendered.");
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=pipeline]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-department-panel=pipeline]"))) {
    throw new Error("Department Pipeline panel was not reachable.");
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const type = document.querySelector('#pipeline-node-type-start');
      if (!(type instanceof HTMLSelectElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(type.constructor.prototype, 'value')?.set;
      setter?.call(type, 'ai-task');
      type.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    true,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-pipeline-validate]')?.click()`,
    true,
  );
  const invalidPipelineVisible = await waitForSelector(
    window,
    "[data-pipeline-validation=invalid] [data-validation-code=START_COUNT_INVALID]",
  );
  await window.webContents.executeJavaScript(
    `(() => {
      const type = document.querySelector('#pipeline-node-type-start');
      const name = document.querySelector('#pipeline-node-name-review');
      const skillFlow = document.querySelector('#pipeline-node-skill-flow-implementation');
      const instructions = document.querySelector('#pipeline-node-instructions-implementation');
      const profile = document.querySelector('#pipeline-node-profile-implementation');
      const inputContracts = document.querySelector('#pipeline-node-input-contracts-implementation');
      const outputContracts = document.querySelector('#pipeline-node-output-contracts-implementation');
      const timeout = document.querySelector('#pipeline-node-timeout-implementation');
      const retry = document.querySelector('#pipeline-node-retry-implementation');
      const maxIterations = document.querySelector('#pipeline-node-max-iterations-implementation');
      const maxTokens = document.querySelector('#pipeline-node-max-tokens-implementation');
      if (!(type instanceof HTMLSelectElement) || !(name instanceof HTMLInputElement) || !(skillFlow instanceof HTMLSelectElement) || !(instructions instanceof HTMLTextAreaElement) || !(profile instanceof HTMLSelectElement) || !(inputContracts instanceof HTMLInputElement) || !(outputContracts instanceof HTMLInputElement) || !(timeout instanceof HTMLInputElement) || !(retry instanceof HTMLInputElement) || !(maxIterations instanceof HTMLInputElement) || !(maxTokens instanceof HTMLInputElement)) return false;
      const typeSetter = Object.getOwnPropertyDescriptor(type.constructor.prototype, 'value')?.set;
      typeSetter?.call(type, 'start');
      type.dispatchEvent(new Event('change', { bubbles: true }));
      const nameSetter = Object.getOwnPropertyDescriptor(name.constructor.prototype, 'value')?.set;
      nameSetter?.call(name, 'Release review');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const flowSetter = Object.getOwnPropertyDescriptor(skillFlow.constructor.prototype, 'value')?.set;
      flowSetter?.call(skillFlow, 'implementation-flow');
      skillFlow.dispatchEvent(new Event('change', { bubbles: true }));
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(instructions, 'Implement the BrowserWindow vertical slice.');
      setValue(profile, ${JSON.stringify(configuredExecutionProfile.id)});
      setValue(inputContracts, 'task-input');
      setValue(outputContracts, 'verified-delivery');
      setValue(timeout, '900');
      setValue(retry, '2');
      setValue(maxIterations, '8');
      setValue(maxTokens, '100000');
      return true;
    })()`,
    true,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-pipeline-validate]')?.click()`,
    true,
  );
  const validPipelineVisible = await waitForSelector(
    window,
    "[data-pipeline-validation=valid]",
  );
  const pipelineValidationVisible =
    invalidPipelineVisible && validPipelineVisible;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-pipeline-save]')?.click()`,
    true,
  );
  const savedPipeline = await waitForRuntimePipeline(
    window,
    "software-rnd",
    (editor) =>
      editor.draft.revision === 1 &&
      editor.draft.graph.nodes.some(
        (node) => node.id === "review" && node.name === "Release review",
      ) &&
      editor.draft.graph.nodes.some(
        (node) =>
          node.id === "implementation" &&
          node.skillFlowId === "implementation-flow" &&
          node.instructions === "Implement the BrowserWindow vertical slice." &&
          node.executionProfileId === configuredExecutionProfile.id &&
          node.inputContractRefs?.[0] === "task-input" &&
          node.outputContractRefs?.[0] === "verified-delivery" &&
          node.timeoutSeconds === 900 &&
          node.retryMaxAttempts === 2 &&
          node.maxIterations === 8 &&
          node.maxTokens === 100_000,
      ),
  );
  if (!(await waitForSelector(window, '[data-pipeline-draft-revision="1"]'))) {
    throw new Error("Saved Pipeline Draft revision was not rendered.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-pipeline-publish]')?.click()`,
    true,
  );
  const publishedPipeline = await waitForRuntimePipeline(
    window,
    "software-rnd",
    (editor) => editor.published?.version === 3 && editor.history.length === 3,
  );
  if (
    !(await waitForSelector(window, '[data-pipeline-published-version="3"]'))
  ) {
    throw new Error("Published Pipeline Version v3 was not rendered.");
  }
  const pipelineVersion = Number(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-department-panel=pipeline]')?.getAttribute('data-pipeline-published-version')`,
      true,
    ),
  );
  const pipelineDraftRevision = Number(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-department-panel=pipeline]')?.getAttribute('data-pipeline-draft-revision')`,
      true,
    ),
  );
  const pipelineNodeIds = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[data-pipeline-node-editor]')).map((element) => element.getAttribute('data-pipeline-node-editor'))`,
    true,
  )) as string[];
  const pipelineHistoryVersions = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[data-pipeline-history-version]')).map((element) => Number(element.getAttribute('data-pipeline-history-version')))`,
    true,
  )) as number[];
  const pipelineSkillFlowId = String(
    await window.webContents.executeJavaScript(
      `(document.querySelector('#pipeline-node-skill-flow-implementation') instanceof HTMLSelectElement ? document.querySelector('#pipeline-node-skill-flow-implementation').value : '')`,
      true,
    ),
  );
  const pipelineInstructions = String(
    await window.webContents.executeJavaScript(
      `(document.querySelector('#pipeline-node-instructions-implementation') instanceof HTMLTextAreaElement ? document.querySelector('#pipeline-node-instructions-implementation').value : '')`,
      true,
    ),
  );
  const pipelineExecutionProfileId = String(
    await window.webContents.executeJavaScript(
      `(document.querySelector('#pipeline-node-profile-implementation') instanceof HTMLSelectElement ? document.querySelector('#pipeline-node-profile-implementation').value : '')`,
      true,
    ),
  );
  if (
    !publishedPipeline.published ||
    pipelineVersion !== publishedPipeline.published.version ||
    JSON.stringify(pipelineNodeIds) !==
      JSON.stringify(
        publishedPipeline.draft.graph.nodes.map((node) => node.id),
      ) ||
    JSON.stringify(pipelineHistoryVersions) !== JSON.stringify([3, 2, 1])
  ) {
    throw new Error(
      "Department Pipeline did not match the Runtime read model.",
    );
  }

  const pipelineReload = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await pipelineReload;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=departments]')?.click()`,
    true,
  );
  await waitForSelector(window, "[data-department-id=software-rnd]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-id=software-rnd]')?.click()`,
    true,
  );
  await waitForSelector(window, "[data-page=department-detail]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=pipeline]')?.click()`,
    true,
  );
  if (
    !(await waitForSelector(window, '[data-pipeline-published-version="3"]'))
  ) {
    throw new Error("Published Pipeline did not reload from the Runtime.");
  }
  const reloadPipelineSkillFlowId = String(
    await window.webContents.executeJavaScript(
      `(document.querySelector('#pipeline-node-skill-flow-implementation') instanceof HTMLSelectElement ? document.querySelector('#pipeline-node-skill-flow-implementation').value : '')`,
      true,
    ),
  );
  if (reloadPipelineSkillFlowId !== "implementation-flow") {
    throw new Error(
      "Pipeline Skill Flow selection did not persist after reload.",
    );
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=settings]')?.click()`,
    true,
  );
  await waitForSelector(window, "[data-department-panel=settings]");
  await window.webContents.executeJavaScript(
    `(() => {
      const form = document.querySelector('[data-department-copy-form]');
      const name = document.querySelector('#department-copy-name');
      if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(name.constructor.prototype, 'value')?.set;
      setter?.call(name, 'Product Delivery');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      return true;
    })()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-page=department-detail]"))) {
    throw new Error("Copied Department detail did not remain open.");
  }
  const copiedDepartment = await waitForRuntimeDepartmentByName(
    window,
    "Product Delivery",
  );
  if (
    !(await waitForSelector(
      window,
      `[data-runtime-department-id=${JSON.stringify(copiedDepartment.id)}][aria-busy="false"]`,
    ))
  ) {
    throw new Error("Copied Department detail did not become current.");
  }
  if (copiedDepartment.id === "software-rnd") {
    throw new Error("Department copy did not create a new Runtime record.");
  }
  const copiedPipeline = await waitForRuntimeDepartment(
    window,
    copiedDepartment.id,
    (department) => department.pipeline !== null,
  );
  if (
    !copiedPipeline.pipeline ||
    copiedPipeline.pipeline.id === configuredDepartment.pipeline?.id
  ) {
    throw new Error("Department copy did not create a new Pipeline ID.");
  }
  const copiedDepartmentId = copiedDepartment.id;

  if (
    !(await clickUntilSelector(
      window,
      "[data-department-tab=settings]",
      "[data-department-panel=settings]",
    ))
  ) {
    throw new Error("Copied Department Settings did not open.");
  }

  if (
    !(await waitForSelector(window, "[data-department-archive]:not(:disabled)"))
  ) {
    const archiveDiagnostics = await window.webContents.executeJavaScript(
      `JSON.stringify({
        settingsTab: Boolean(document.querySelector('[data-department-tab=settings]')),
        settingsPanel: Boolean(document.querySelector('[data-department-panel=settings]')),
        archive: document.querySelector('[data-department-archive]')?.outerHTML ?? null,
        busy: document.querySelector('[data-department-archive]')?.hasAttribute('disabled') ?? null,
      })`,
      true,
    );
    throw new Error(
      `Copied Department archive action did not become ready: ${archiveDiagnostics}`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-archive]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-page=departments]"))) {
    throw new Error("Archived Department did not return to the list.");
  }
  const archivedDepartmentVisible = Boolean(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-department-id=${JSON.stringify(copiedDepartmentId)}]') !== null`,
      true,
    ),
  );

  const customDepartment = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.createDepartment({ name: 'Design' })`,
    true,
  )) as { id: string };
  const customPosition = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.createPosition({
        departmentId: ${JSON.stringify(customDepartment.id)},
        name: 'Design Lead',
        responsibility: 'Owns the design system.',
        aiMemberDisplayName: 'Design Lead',
        aiMemberProfile: 'A careful design lead.',
        aiMemberResponsibilityMetadata: { discipline: 'design' }
      })`,
      true,
    ),
  );
  const createdCustomPosition = customPosition.positions[0];
  if (!createdCustomPosition) {
    throw new Error("BrowserWindow smoke did not create a Position.");
  }
  const updatedCustomPosition = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.updatePosition({
        departmentId: ${JSON.stringify(customDepartment.id)},
        positionId: ${JSON.stringify(createdCustomPosition.id)},
        expectedRevision: 0,
        name: 'Senior Design Lead',
        responsibility: 'Owns the design system and reviews changes.',
        aiMemberDisplayName: 'Senior Design Lead',
        aiMemberProfile: 'A careful senior design lead.',
        aiMemberResponsibilityMetadata: { discipline: 'design' },
        aiMemberStatus: 'active'
      })`,
      true,
    ),
  );
  if (updatedCustomPosition.positions[0]?.revision !== 1) {
    throw new Error(
      "BrowserWindow smoke did not update the Position revision.",
    );
  }
  const archivedCustomPosition = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.archivePosition({
        departmentId: ${JSON.stringify(customDepartment.id)},
        positionId: ${JSON.stringify(createdCustomPosition.id)},
        expectedRevision: 1
      })`,
      true,
    ),
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=projects]')?.click()`,
    true,
  );
  await waitForSelector(window, "[data-page=projects]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=departments]')?.click()`,
    true,
  );
  const customSelector = `[data-department-id="${customDepartment.id}"]`;
  if (!(await waitForSelector(window, customSelector))) {
    throw new Error("Custom Department was not loaded from the Runtime.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(customSelector)})?.click()`,
    true,
  );
  await waitForSelector(window, "[data-page=department-detail]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=pipeline]')?.click()`,
    true,
  );
  const unpublishedPipelineVisible = await waitForSelector(
    window,
    "[data-pipeline-state=draft-only]",
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-pipeline-save]')?.click()`,
    true,
  );
  const customSaved = await waitForRuntimePipeline(
    window,
    customDepartment.id,
    (editor) => editor.draft.revision === 1,
  );
  await waitForSelector(window, '[data-pipeline-draft-revision="1"]');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-pipeline-publish]')?.click()`,
    true,
  );
  const customPublished = await waitForRuntimePipeline(
    window,
    customDepartment.id,
    (editor) => editor.published?.version === 1,
  );
  const persistedReload = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await persistedReload;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=departments]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, customSelector))) {
    throw new Error(
      "Custom Department did not persist across Renderer reload.",
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(customSelector)})?.click()`,
    true,
  );
  await waitForSelector(window, "[data-page=department-detail]");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-department-tab=pipeline]')?.click()`,
    true,
  );
  if (
    !(await waitForSelector(window, '[data-pipeline-published-version="1"]'))
  ) {
    throw new Error("Published custom Pipeline did not reload from Runtime.");
  }
  const reloadPublishedPipelineVersion = Number(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-pipeline-published-version]')?.getAttribute('data-pipeline-published-version')`,
      true,
    ),
  );
  const runDepartment = DepartmentInspectSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.inspectDepartment('software-rnd')`,
      true,
    ),
  );
  const runEngineer = runDepartment.positions.find(
    (position) => position.id === "software-engineer",
  );
  if (!runEngineer) {
    throw new Error("Software Engineer was not available for the Run smoke.");
  }
  if (runEngineer.aiMember.status !== "active") {
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.updatePosition({
        departmentId: 'software-rnd',
        positionId: 'software-engineer',
        expectedRevision: ${runEngineer.revision},
        name: ${JSON.stringify(runEngineer.name)},
        responsibility: ${JSON.stringify(runEngineer.responsibility)},
        aiMemberDisplayName: ${JSON.stringify(runEngineer.aiMember.displayName)},
        aiMemberProfile: ${JSON.stringify(runEngineer.aiMember.profile)},
        aiMemberResponsibilityMetadata: ${JSON.stringify(runEngineer.aiMember.responsibilityMetadata)},
        aiMemberStatus: 'active'
      })`,
      true,
    );
  }
  const runPipelineEditor = DepartmentPipelineEditorViewSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.inspectPipeline('software-rnd')`,
      true,
    ),
  );
  const runGraph = {
    nodes: [
      { id: "start", type: "start", name: "Start" },
      {
        id: "scripted-task",
        type: "ai-task",
        name: "Scripted task",
        positionId: runEngineer.id,
      },
      {
        id: "approval",
        type: "human-approval",
        name: "Approval",
        positionId: runEngineer.id,
      },
      {
        id: "condition",
        type: "condition",
        name: "Condition",
        condition: {
          leftReference: "snapshot.project.goal",
          operator: "equals",
          value: "Verify the packaged Department Run path.",
          branches: [
            { id: "ship", label: "Ship", kind: "match" },
            { id: "hold", label: "Hold", kind: "no-match" },
            { id: "fallback", label: "Fallback", kind: "default" },
          ],
        },
      },
      { id: "parallel", type: "parallel", name: "Parallel" },
      {
        id: "branch-a",
        type: "ai-task",
        name: "Branch A",
        positionId: runEngineer.id,
      },
      {
        id: "branch-b",
        type: "ai-task",
        name: "Branch B",
        positionId: runEngineer.id,
      },
      {
        id: "hold-task",
        type: "ai-task",
        name: "Hold task",
        positionId: runEngineer.id,
      },
      { id: "join", type: "join", name: "Join" },
      { id: "complete", type: "complete", name: "Complete" },
    ],
    edges: [
      { from: "start", to: "scripted-task" },
      { from: "scripted-task", to: "approval" },
      { from: "approval", to: "condition" },
      { from: "condition", to: "parallel", branchId: "ship" },
      { from: "condition", to: "hold-task", branchId: "hold" },
      { from: "parallel", to: "branch-a" },
      { from: "parallel", to: "branch-b" },
      { from: "branch-a", to: "join" },
      { from: "branch-b", to: "join" },
      { from: "hold-task", to: "join" },
      { from: "join", to: "complete" },
    ],
  } as const;
  const savedRunPipeline = DepartmentPipelineEditorViewSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.savePipelineDraft({
        departmentId: 'software-rnd',
        expectedRevision: ${runPipelineEditor.draft.revision},
        graph: ${JSON.stringify(runGraph)}
      })`,
      true,
    ),
  );
  await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.publishPipeline({
      departmentId: 'software-rnd',
      expectedRevision: ${savedRunPipeline.draft.revision}
    })`,
    true,
  );
  const runProject = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.createProject({
      name: 'Runtime delivery',
      goal: 'Verify the packaged Department Run path.'
    })`,
    true,
  )) as { readonly id: string };
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=projects]')?.click()`,
    true,
  );
  const runProjectSelector = `[data-project-id="${runProject.id}"]`;
  if (!(await waitForSelector(window, runProjectSelector))) {
    throw new Error("Run smoke Project was not rendered.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(runProjectSelector)})?.click()`,
    true,
  );
  if (!(await waitForSelector(window, "[data-page=project-detail]"))) {
    throw new Error("Run smoke Project detail did not open.");
  }
  if (
    !(await waitForSelector(
      window,
      "[data-start-department-run]:not(:disabled)",
    ))
  ) {
    throw new Error("Run start action did not become available.");
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const select = document.querySelector('#project-run-agent-override');
      if (!(select instanceof HTMLSelectElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, 'claude-code');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    true,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-start-department-run]')?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      '[data-run-detail][data-run-status="waiting-approval"]',
    ))
  ) {
    throw new Error("Department Run did not reach waiting-approval.");
  }
  const runRuntimeId = String(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-run-detail]')?.getAttribute('data-run-detail')`,
      true,
    ),
  );
  await window.webContents.executeJavaScript(
    `(() => {
      const feedback = document.querySelector('[data-run-approval-feedback]');
      if (!(feedback instanceof HTMLTextAreaElement)) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(feedback, 'Add recovery evidence before approval.');
      feedback.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      "[data-run-approval-decision=request-changes]:not(:disabled)",
    ))
  ) {
    throw new Error("Request Changes did not accept Node feedback.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-run-approval-decision=request-changes]')?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      '[data-node-attempt="2"][data-node-attempt-status="succeeded"]',
    )) ||
    !(await waitForSelector(
      window,
      '[data-run-detail][data-run-status="waiting-approval"] [data-run-approval-cycle="2"]',
    ))
  ) {
    throw new Error(
      "Request Changes did not create a second persisted Node Attempt and Approval.",
    );
  }

  const recoveryReload = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await recoveryReload;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=projects]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, runProjectSelector))) {
    throw new Error("Request Changes Project did not reload from Runtime.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(runProjectSelector)})?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      `[data-run-detail=${JSON.stringify(runRuntimeId)}][data-run-status="waiting-approval"]`,
    )) ||
    !(await waitForSelector(window, '[data-run-approval-cycle="2"]'))
  ) {
    throw new Error("Second Approval did not recover after reload.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-run-approval-decision=approve]')?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      '[data-run-detail][data-run-status="completed"]',
    ))
  ) {
    const stalled = DepartmentRunViewSchema.parse(
      await window.webContents.executeJavaScript(
        `window.sandcastle.runtime.inspectRun(${JSON.stringify(runRuntimeId)})`,
        true,
      ),
    );
    throw new Error(
      `Department Run did not complete after second approval: ${JSON.stringify({
        run: stalled.run,
        nodes: stalled.nodes.map((node) => ({
          pipelineNodeId: node.pipelineNodeId,
          status: node.status,
          failure: node.failure,
        })),
      })}`,
    );
  }
  const runView = DepartmentRunViewSchema.parse(
    await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.inspectRun(${JSON.stringify(runRuntimeId)})`,
      true,
    ),
  );
  if (
    runView.nodes.find((node) => node.pipelineNodeId === "approval")?.result ===
      null ||
    runView.nodes.find((node) => node.pipelineNodeId === "scripted-task")
      ?.attempts.length !== 2 ||
    runView.nodes.find((node) => node.pipelineNodeId === "approval")?.approvals
      .length !== 2 ||
    runView.nodes.find((node) => node.pipelineNodeId === "condition")
      ?.status !== "succeeded" ||
    runView.nodes.find((node) => node.pipelineNodeId === "hold-task")
      ?.status !== "skipped" ||
    runView.nodes.find((node) => node.pipelineNodeId === "branch-a")?.status !==
      "succeeded" ||
    runView.nodes.find((node) => node.pipelineNodeId === "branch-b")?.status !==
      "succeeded" ||
    runView.nodes.find((node) => node.pipelineNodeId === "join")?.status !==
      "succeeded" ||
    runView.nodes.find((node) => node.pipelineNodeId === "complete")?.status !==
      "succeeded"
  ) {
    throw new Error(
      "Department Run did not persist the complete tracer state.",
    );
  }
  const interaction = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.createInteractionSession({
      projectId: ${JSON.stringify(runProject.id)},
      mode: 'run-collaboration',
      runId: ${JSON.stringify(runRuntimeId)},
      nodeRunId: ${JSON.stringify(
        runView.nodes.find((node) => node.pipelineNodeId === "scripted-task")
          ?.id,
      )}
    })`,
    true,
  )) as { readonly id: string };
  const participant = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.addInteractionParticipant({
      sessionId: ${JSON.stringify(interaction.id)},
      participantType: 'human',
      participantRef: 'packaged-smoke-user',
      role: 'requester'
    })`,
    true,
  )) as { readonly id: string };
  await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.addInteractionMessage({
      sessionId: ${JSON.stringify(interaction.id)},
      participantId: ${JSON.stringify(participant.id)},
      kind: 'text',
      content: 'Record the packaged Runtime evidence.'
    })`,
    true,
  );
  const permission = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.requestPermission({
      sessionId: ${JSON.stringify(interaction.id)},
      scope: 'repository.read'
    })`,
    true,
  )) as { readonly id: string };
  const decidedPermission = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.decidePermission({
      permissionId: ${JSON.stringify(permission.id)},
      expectedStatus: 'pending',
      decision: 'approved'
    })`,
    true,
  )) as { readonly status: string };
  const agUiReplay = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.agUiEvents({ afterSequence: 0, limit: 1000 })`,
    true,
  )) as { readonly events: readonly unknown[] };
  const memoryCandidate = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.createMemoryCandidate({
      projectId: ${JSON.stringify(runProject.id)},
      scope: 'project',
      sourceSessionId: ${JSON.stringify(interaction.id)},
      sourceRunId: ${JSON.stringify(runRuntimeId)},
      summary: 'The packaged Runtime tracer completed with reviewed evidence.'
    })`,
    true,
  )) as { readonly id: string };
  const reviewedMemory = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.reviewMemoryCandidate({
      candidateId: ${JSON.stringify(memoryCandidate.id)},
      expectedStatus: 'pending',
      decision: 'approved'
    })`,
    true,
  )) as { readonly record: { readonly version: number } | null };
  const closedInteraction = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.closeInteractionSession(${JSON.stringify(interaction.id)})`,
    true,
  )) as { readonly status: string };
  const backup = (await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.backupRuntime()`,
    true,
  )) as { readonly schemaVersion: number };
  const runReload = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await runReload;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav=projects]')?.click()`,
    true,
  );
  if (!(await waitForSelector(window, runProjectSelector))) {
    throw new Error("Run smoke Project did not reload from Runtime.");
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(runProjectSelector)})?.click()`,
    true,
  );
  if (
    !(await waitForSelector(
      window,
      `[data-run-detail=${JSON.stringify(runRuntimeId)}]`,
    ))
  ) {
    throw new Error("Department Run detail did not reload from Runtime.");
  }
  const reloadRunStatus = String(
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-run-detail]')?.getAttribute('data-run-status')`,
      true,
    ),
  );
  return {
    beforeReload,
    afterReload,
    overviewVisible,
    projectsPageVisible,
    projectRuntimeId,
    projectRevision: savedProject.revision,
    projectRepositoryReferences: savedProject.repositoryReferences,
    projectVersionConflictVisible,
    projectReloadSharedContext,
    archivedProjectVisible,
    departmentsPageVisible,
    departmentRuntimeId,
    departmentPositionCount: runtimeDepartment.positions.length,
    pipelineVersion,
    pipelineDraftRevision,
    pipelineNodeIds,
    pipelineValidationVisible,
    pipelineHistoryVersions,
    legacyBoardNavigationVisible,
    updatedDepartmentName: updatedDepartment.name,
    updatedMemberDisplayName:
      configuredDepartment.positions.find(
        (position) => position.id === "software-engineer",
      )?.aiMember.displayName ?? "",
    skillConfigurationRevision: archivedSkills.revision,
    positionSkillIds:
      reboundSkills.positions.find(
        (position) => position.id === "software-engineer",
      )?.skillIds ?? [],
    createdSkillFlowId: createdSkillFlow.id,
    skillFlowRevision:
      reloadedSkills.skillFlows.find((flow) => flow.id === createdSkillFlow.id)
        ?.revision ?? 0,
    skillFlowConflictVisible,
    skillBlockedArchiveVisible,
    skillBlockedArchiveMessage,
    archivedSkillFlowStatus:
      archivedSkills.skillFlows.find((flow) => flow.id === createdSkillFlow.id)
        ?.status ?? "",
    copiedDepartmentId,
    archivedDepartmentVisible,
    unpublishedPipelineVisible,
    customPublishedPipelineVersion: customPublished.published?.version ?? 0,
    reloadPublishedPipelineVersion,
    pipelineSkillFlowId,
    reloadPipelineSkillFlowId,
    pipelineInstructions,
    pipelineExecutionProfileId,
    positionLifecycleStatus:
      archivedCustomPosition.positions.find(
        (position) => position.id === createdCustomPosition.id,
      )?.status ?? "",
    configuredExecutionProfileId: configuredExecutionProfile.id,
    configuredSecretReferenceId: configuredSecretReference.id,
    runRuntimeId,
    runStatus: runView.run.status,
    runSnapshotHash: runView.snapshot.hash,
    runResolvedAgentId:
      runView.snapshot.payload.positions[0]?.resolvedAgentId ?? "",
    runAgentSource: runView.snapshot.payload.positions[0]?.agentSource ?? "",
    runAttemptCount:
      runView.nodes.find((node) => node.pipelineNodeId === "scripted-task")
        ?.attempts.length ?? 0,
    runApprovalCycles:
      runView.nodes.find((node) => node.pipelineNodeId === "approval")
        ?.approvals.length ?? 0,
    reloadRunStatus,
    interactionSessionStatus: closedInteraction.status,
    permissionStatus: decidedPermission.status,
    agUiEventCount: agUiReplay.events.length,
    memoryRecordVersion: reviewedMemory.record?.version ?? 0,
    backupSchemaVersion: backup.schemaVersion,
  };
};

const waitForRuntimeProject = async (
  window: BrowserWindow,
  projectId: string,
  predicate: (project: ProjectEditorView) => boolean,
): Promise<ProjectEditorView> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const project = ProjectEditorViewSchema.parse(
      await window.webContents.executeJavaScript(
        `window.sandcastle.runtime.inspectProject(${JSON.stringify(projectId)})`,
        true,
      ),
    );
    if (predicate(project)) return project;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Runtime Project ${projectId} did not reach the expected state.`,
  );
};

const waitForRuntimeSkillConfiguration = async (
  window: BrowserWindow,
  departmentId: string,
  predicate: (configuration: SkillConfigurationView) => boolean,
): Promise<SkillConfigurationView> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const configuration = SkillConfigurationViewSchema.parse(
      await window.webContents.executeJavaScript(
        `window.sandcastle.runtime.inspectSkillConfiguration(${JSON.stringify(departmentId)})`,
        true,
      ),
    );
    if (predicate(configuration)) return configuration;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Runtime Skill Configuration for Department ${departmentId} did not reach the expected state.`,
  );
};

const waitForRuntimePipeline = async (
  window: BrowserWindow,
  departmentId: string,
  predicate: (editor: DepartmentPipelineEditorView) => boolean,
): Promise<DepartmentPipelineEditorView> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const editor = DepartmentPipelineEditorViewSchema.parse(
      await window.webContents.executeJavaScript(
        `window.sandcastle.runtime.inspectPipeline(${JSON.stringify(departmentId)})`,
        true,
      ),
    );
    if (predicate(editor)) return editor;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Runtime Pipeline for Department ${departmentId} did not reach the expected state.`,
  );
};

const waitForRuntimeDepartment = async (
  window: BrowserWindow,
  departmentId: string,
  predicate: (department: DepartmentInspect) => boolean,
): Promise<DepartmentInspect> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const department = DepartmentInspectSchema.parse(
      await window.webContents.executeJavaScript(
        `window.sandcastle.runtime.inspectDepartment(${JSON.stringify(departmentId)})`,
        true,
      ),
    );
    if (predicate(department)) return department;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Runtime Department ${departmentId} did not reach the expected state.`,
  );
};

const waitForRuntimeDepartmentByName = async (
  window: BrowserWindow,
  name: string,
): Promise<{ readonly id: string }> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const department = (await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.departments().then((departments) => departments.find((department) => department.name === ${JSON.stringify(name)}))`,
      true,
    )) as { readonly id: string } | undefined;
    if (department) return department;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Runtime Department ${name} was not listed.`);
};
