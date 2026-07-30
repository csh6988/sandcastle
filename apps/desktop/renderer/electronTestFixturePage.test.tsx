import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it } from "node:test";
import type { SandcastleBridge } from "../preload/bridge.js";
import {
  ElectronTestFixturePage,
  encodeElectronTestFixtureRoute,
  readElectronTestFixtureRoute,
} from "./electronTestFixturePage.js";
import type { ElectronTestFixtureRoute } from "./electronTestFixturePage.js";

const fixtureRoute: ElectronTestFixtureRoute = {
  schemaVersion: 1 as const,
  restoreOnLoad: false,
  testRunId: "test:run-1:test-node-1",
  caseCommandId: "fixture-case-register",
  caseCommand: {
    type: "test.case-revision.register" as const,
    testCaseId: "fixture-case-1",
    revisionId: "fixture-case-1-r1",
    projectId: "project-1",
    manifest: {
      schemaVersion: 1 as const,
      ownerPositionId: "position-test-engineer",
      requirementIds: ["acceptance-19"],
      workPackageVersions: [],
      preconditions: ["exact PASS Integration Generation is available"],
      uiActions: [{ id: "click-run", kind: "click", target: "run-test" }],
      assertions: [
        {
          id: "paired-assertion",
          operationId: "electron-operation",
          ui: { kind: "text", expected: "Test ready" },
          runtime: { kind: "query", expected: "reconciling" },
        },
      ],
      fixture: { id: "fixture-1", scriptHashes: ["a".repeat(64)] },
      executionOperations: [
        {
          id: "electron-operation",
          kind: "electron" as const,
          adapterId: "scripted-execution",
          input: { commandId: "fixture-test-run-create" },
          inputHash: "b".repeat(64),
        },
        {
          id: "cleanup-operation",
          kind: "cleanup" as const,
          adapterId: "scripted-execution",
          input: {
            fixtureId: "fixture-1",
            rootFingerprint: "3".repeat(64),
          },
          inputHash: "4".repeat(64),
        },
      ],
      evidencePolicy: {
        retentionClass: "durable" as const,
        redactionProfile: "fixture-redacted",
        requiredKinds: ["ui", "runtime", "cleanup"],
      },
      cleanup: {
        policy: "always",
        required: true,
        operationId: "cleanup-operation",
        rootFingerprint: "3".repeat(64),
        targets: [
          { kind: "repository" as const, pathFingerprint: "5".repeat(64) },
          { kind: "worktree" as const, pathFingerprint: "6".repeat(64) },
        ],
      },
    },
  },
  runCommandId: "fixture-test-run-create",
  runCommand: {
    type: "test.run.create" as const,
    input: {
      testRunId: "test:run-1:test-node-1",
      requestId: "fixture-run-request",
      projectId: "project-1",
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      nodeRunId: "test-node-1",
      nodeAttemptId: "test-attempt-1",
      sessionId: "test-session-1",
      testCaseRevisions: [{ id: "fixture-case-1-r1", hash: "c".repeat(64) }],
      integrationAuthority: {
        generationId: "generation-1",
        manifestHash: "d".repeat(64),
        passAuthorityHash: "e".repeat(64),
        repositoryCommits: [
          { repositoryReference: "repository-1", commit: "1".repeat(40) },
        ],
      },
      build: {
        artifactVersionId: "build-1",
        digest: "f".repeat(64),
      },
      executionProfile: { id: "profile-1", hash: "1".repeat(64) },
      companyDirectoryFingerprint: "2".repeat(64),
      fixture: { id: "fixture-1", scriptHashes: ["a".repeat(64)] },
      executionOperations: [
        {
          id: "electron-operation",
          kind: "electron" as const,
          adapterId: "scripted-execution",
          input: { commandId: "fixture-test-run-create" },
          inputHash: "b".repeat(64),
        },
        {
          id: "cleanup-operation",
          kind: "cleanup" as const,
          adapterId: "scripted-execution",
          input: {
            fixtureId: "fixture-1",
            rootFingerprint: "3".repeat(64),
          },
          inputHash: "4".repeat(64),
        },
      ],
      clock: { instant: "2026-07-29T00:00:00.000Z", seed: "fixture-seed" },
      environment: { platform: "darwin", architecture: "arm64" },
      capabilities: ["electron", "runtime-query"],
      risk: {
        schemaVersion: 1 as const,
        policy: {
          revisionId: "fixture-risk-r1",
          rules: [
            {
              factorId: "electron-runtime",
              minimumTier: "high" as const,
            },
          ],
          hash: "7".repeat(64),
        },
        factors: [
          {
            id: "electron-runtime",
            present: true,
            evidenceRefs: ["test-case:fixture-case-1-r1"],
          },
        ],
        computedTier: "high" as const,
        evidenceRefs: ["test-case:fixture-case-1-r1"],
        inputHash: "8".repeat(64),
      },
    },
  },
};

describe("Electron Test fixture renderer page", () => {
  it("round-trips only inert Command input through the product renderer route", () => {
    const url = new URL(encodeElectronTestFixtureRoute(fixtureRoute));
    assert.deepEqual(readElectronTestFixtureRoute(url), fixtureRoute);
  });

  it("routes a real fixture gesture through an exact Interaction Prompt", async (context) => {
    const interactionRoute: ElectronTestFixtureRoute = {
      ...fixtureRoute,
      interactionPrompt: {
        commandId: "fixture-interaction-prompt",
        sessionId: "interaction-session-1",
        participantId: "interaction-human-1",
        content: "Exercise the renderer gesture.",
        expectedResponse: "fixture interaction passed",
      },
    };
    const commands: unknown[] = [];
    const bridge = {
      execute: async (input: { readonly command: unknown }) => {
        commands.push(input.command);
        return {
          status: "succeeded" as const,
          value: { id: "interaction-turn-1" },
          effectIds: [],
        };
      },
      query: async () => ({
        view: {
          turns: [
            {
              id: "interaction-turn-1",
              status: "completed",
              outputMessageId: "interaction-output-1",
            },
          ],
          messages: [
            {
              id: "interaction-output-1",
              content: "fixture interaction passed",
            },
          ],
        },
        asOfSequence: 1,
        viewSyncToken: null,
      }),
    } as unknown as Pick<SandcastleBridge, "query" | "execute">;
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://127.0.0.1/",
    });
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const previousDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    const previousHTMLElement = Object.getOwnPropertyDescriptor(
      globalThis,
      "HTMLElement",
    );
    const previousNode = Object.getOwnPropertyDescriptor(globalThis, "Node");
    const previousAct = Object.getOwnPropertyDescriptor(
      globalThis,
      "IS_REACT_ACT_ENVIRONMENT",
    );
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      Node: { configurable: true, value: dom.window.Node },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    });
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    context.after(async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of [
        ["window", previousWindow],
        ["document", previousDocument],
        ["HTMLElement", previousHTMLElement],
        ["Node", previousNode],
        ["IS_REACT_ACT_ENVIRONMENT", previousAct],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });

    await act(async () => {
      root.render(
        <ElectronTestFixturePage route={interactionRoute} bridge={bridge} />,
      );
    });
    const button = container.querySelector("button");
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(button.textContent, "Interaction Observed");
    assert.equal(button.disabled, true);
    assert.equal(
      dom.window.document.title,
      "Sandcastle T17 Fixture — observed",
    );
    assert.deepEqual(commands, [
      {
        type: "interaction.prompt",
        sessionId: "interaction-session-1",
        participantId: "interaction-human-1",
        content: "Exercise the renderer gesture.",
      },
    ]);
  });

  it("uses accessible real button actions to create, acknowledge, reconcile, and reload authoritative Test state", async (context) => {
    const executions: Array<{
      readonly commandId: string;
      readonly type: string;
    }> = [];
    let queryCount = 0;
    const bridge = {
      query: async () => {
        queryCount += 1;
        const passed = queryCount >= 3;
        return {
          view: {
            id: fixtureRoute.testRunId,
            state: passed ? "passed" : "reconciling",
            manifestHash: "c".repeat(64),
            passAuthorityHash: passed ? "d".repeat(64) : null,
          },
          asOfSequence: queryCount,
          viewSyncToken: `view-token-${queryCount}`,
        };
      },
      execute: async (input: {
        readonly commandId: string;
        readonly command: { readonly type: string };
      }) => {
        executions.push({
          commandId: input.commandId,
          type: input.command.type,
        });
        return {
          status: "succeeded" as const,
          value:
            input.command.type === "ack-runtime-events"
              ? {
                  acknowledged: true,
                  subscriptionGeneration: 1,
                  barrierSequence: queryCount,
                  auditId: `audit-${queryCount}`,
                }
              : {},
          effectIds: [],
        };
      },
    } as unknown as Pick<SandcastleBridge, "query" | "execute">;
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://127.0.0.1/",
    });
    Object.defineProperty(dom.window, "sandcastle", {
      configurable: true,
      value: bridge,
    });
    const domGlobals = {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    } as const;
    const previousGlobals = new Map(
      Object.keys(domGlobals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(domGlobals)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    context.after(async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });

    await act(async () => {
      root.render(
        <ElectronTestFixturePage route={fixtureRoute} bridge={bridge} />,
      );
    });
    await act(async () => undefined);
    assert.equal(queryCount, 0);
    const button = container.querySelector("button");
    assert.ok(button);
    assert.equal(button.textContent, "Run Test");

    await act(async () => button.click());
    assert.equal(button.textContent, "Complete Test Run");
    assert.equal(dom.window.document.title, "Sandcastle T17 Fixture — ready");

    await act(async () => button.click());
    assert.equal(button.textContent, "Complete Test Run");
    assert.equal(dom.window.document.title, "Sandcastle T17 Fixture — ready");

    await act(async () => button.click());
    assert.equal(button.textContent, "PASS");
    assert.equal(button.disabled, true);
    assert.equal(dom.window.document.title, "Sandcastle T17 Fixture — pass");
    assert.deepEqual(
      executions.map((entry) => entry.type),
      [
        "test.case-revision.register",
        "test.run.create",
        "ack-runtime-events",
        "test.run.create",
        "ack-runtime-events",
        "test.run.create",
        "ack-runtime-events",
      ],
    );
  });
});
