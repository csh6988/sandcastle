import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AcceptedDeliveryCandidateAuthorityView,
  DeliveryCandidateView,
  ReleaseOperationEnvelopeCommand,
  ReleaseOperationView,
} from "../runtime/interface.js";
import { ReleaseOperationPanel } from "./releaseOperationPanel.js";

const authority = {
  id: "accepted-authority-1",
  candidateId: "candidate-1",
  candidateHash: "a".repeat(64),
  releaseDecisionId: "decision-1",
  releaseDecisionHash: "b".repeat(64),
  candidateInputId: "input-1",
  candidateInputHash: "c".repeat(64),
  gateAuthorityId: "gate-1",
  gateAuthorityHash: "d".repeat(64),
  integrationGenerationId: "generation-1",
  integrationAuthorityHash: "e".repeat(64),
  repositoryCommits: [
    { repositoryReference: "repo-api", commit: "f".repeat(40) },
    { repositoryReference: "repo-web", commit: "1".repeat(40) },
  ],
  artifactVersionIds: ["artifact-a", "artifact-b"],
  runId: "run-1",
  snapshotRevisionId: "snapshot-1",
  authorityHash: "2".repeat(64),
  createdAt: "2026-08-03T00:00:00.000Z",
} satisfies AcceptedDeliveryCandidateAuthorityView;

const candidate = {
  id: "candidate-1",
  requestId: "request-1",
  manifest: {},
  manifestHash: authority.candidateHash,
  projection: "accepted",
  decision: null,
  recoveryActivation: null,
  supersededByCandidateId: null,
  createdAt: "2026-08-03T00:00:00.000Z",
} satisfies DeliveryCandidateView;

const operation = (
  state: ReleaseOperationView["aggregateState"],
): ReleaseOperationView =>
  ({
    id: "release-operation-1",
    request: {
      operationId: "release-operation-1",
      candidateId: "candidate-1",
      expectedAcceptedAuthorityHash: authority.authorityHash,
      kind: "merge",
      authorization: {
        actor: {
          type: "human",
          id: "runtime-only",
          authenticatedBy: "local-session",
        },
        reason: "Release after review.",
        evidenceRefs: ["evidence-1"],
      },
      items: [],
    },
    acceptedAuthority: authority,
    canonicalRequestHash: "3".repeat(64),
    nextActions:
      state === "blocked" ? ["reconcile", "create-new-operation"] : [],
    aggregateState: state,
    counts: {
      pending: 0,
      running: 0,
      reconciling: 0,
      succeeded: 1,
      failed: 0,
      destinationConflict: 1,
      unknown: 1,
    },
    items: [
      {
        id: "merge:0",
        state: "succeeded",
        receipt: {
          kind: "merge",
          disposition: "no-op",
          resultingTargetTip: "4".repeat(40),
          observedAt: "2026-08-03T00:00:00.000Z",
        },
        evidence: [],
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "merge:1",
        state: "destination-conflict",
        receipt: null,
        evidence: [],
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "merge:2",
        state: "unknown",
        receipt: null,
        evidence: ["adapter could not verify"],
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  }) as ReleaseOperationView;

const renderPanel = async (input: {
  readonly onCommand?: (
    command: ReleaseOperationEnvelopeCommand,
  ) => void | Promise<void>;
  readonly operations?: readonly ReleaseOperationView[];
}) => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
  );
  const previousGlobals = new Map(
    [
      "window",
      "document",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
      "Event",
      "InputEvent",
      "EventTarget",
      "Node",
      "MutationObserver",
      "IS_REACT_ACT_ENVIRONMENT",
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    EventTarget: dom.window.EventTarget,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.querySelector("#app")!);
  await act(async () => {
    root.render(
      <ReleaseOperationPanel
        candidate={candidate}
        authority={authority}
        operations={input.operations ?? []}
        onCommand={input.onCommand ?? (() => undefined)}
        createOperationId={() => "operation-stable"}
      />,
    );
  });
  return {
    document: dom.window.document,
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

const change = async (
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value",
    )?.set?.call(node, value);
    node.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    node.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
};

describe("ReleaseOperationPanel", () => {
  it("renders only for an accepted Candidate with its accepted authority and summarizes exact hashes", () => {
    assert.equal(
      renderToStaticMarkup(
        <ReleaseOperationPanel
          candidate={{ ...candidate, projection: "awaiting-decision" }}
          authority={authority}
          operations={[]}
          onCommand={() => undefined}
        />,
      ),
      "",
    );
    const markup = renderToStaticMarkup(
      <ReleaseOperationPanel
        candidate={candidate}
        authority={authority}
        operations={[]}
        onCommand={() => undefined}
      />,
    );
    assert.match(markup, /data-release-operation-panel/);
    assert.match(markup, new RegExp(authority.candidateHash.slice(0, 12)));
    assert.match(markup, new RegExp(authority.authorityHash.slice(0, 12)));
    assert.match(markup, /repo-api/);
  });

  it("creates typed merge and export commands with explicit confirmation but never an actor", async () => {
    const commands: ReleaseOperationEnvelopeCommand[] = [];
    const rendered = await renderPanel({
      onCommand: (command) => {
        commands.push(command);
      },
    });
    try {
      const document = rendered.document;
      const submit = document.querySelector<HTMLButtonElement>(
        "[data-release-create]",
      )!;
      assert.equal(submit.disabled, true);
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-merge-target='repo-api']",
        )!,
        "main",
      );
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-merge-tip='repo-api']",
        )!,
        "5".repeat(40),
      );
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-merge-target='repo-web']",
        )!,
        "main",
      );
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-merge-tip='repo-web']",
        )!,
        "6".repeat(40),
      );
      await change(
        document.querySelector<HTMLTextAreaElement>("[data-release-reason]")!,
        "Evidence reviewed.",
      );
      await change(
        document.querySelector<HTMLInputElement>("[data-release-evidence]")!,
        "review:1\ncheck:2",
      );
      await act(async () =>
        document
          .querySelector<HTMLInputElement>("[data-release-confirm]")!
          .click(),
      );
      assert.equal(submit.disabled, false);
      await act(async () => submit.click());
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      assert.equal(command.type, "delivery.release-operation.create");
      if (command.type === "delivery.release-operation.create") {
        assert.equal(command.operation.kind, "merge");
        assert.equal(command.operation.items.length, 2);
        assert.equal("actor" in command.operation.authorization, false);
      }

      await act(async () =>
        document
          .querySelector<HTMLInputElement>("[data-release-kind='export']")!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLInputElement>(
            "[data-export-artifact='artifact-a']",
          )!
          .click(),
      );
      await change(
        document.querySelector<HTMLInputElement>("[data-export-root]")!,
        "/Users/release",
      );
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-export-path='artifact-a']",
        )!,
        "dist/app.zip",
      );
      assert.match(document.body.innerHTML, /create-only/);
    } finally {
      await rendered.cleanup();
    }
  });

  it("creates a typed export for a non-empty authorized Artifact subset", async () => {
    const commands: ReleaseOperationEnvelopeCommand[] = [];
    const rendered = await renderPanel({
      onCommand: (command) => {
        commands.push(command);
      },
    });
    try {
      const document = rendered.document;
      await act(async () =>
        document
          .querySelector<HTMLInputElement>("[data-release-kind='export']")!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLInputElement>(
            "[data-export-artifact='artifact-a']",
          )!
          .click(),
      );
      await change(
        document.querySelector<HTMLInputElement>("[data-export-root]")!,
        "/Users/release",
      );
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-export-path='artifact-a']",
        )!,
        "dist/app.zip",
      );
      await change(
        document.querySelector<HTMLTextAreaElement>("[data-release-reason]")!,
        "Export evidence reviewed.",
      );
      await change(
        document.querySelector<HTMLInputElement>("[data-release-evidence]")!,
        "review:1",
      );
      await act(async () =>
        document
          .querySelector<HTMLInputElement>("[data-release-confirm]")!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>("[data-release-create]")!
          .click(),
      );
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      assert.equal(command.type, "delivery.release-operation.create");
      if (command.type === "delivery.release-operation.create") {
        assert.equal(command.operation.kind, "export");
        assert.deepEqual(command.operation.items, [
          {
            id: "export:artifact-a",
            artifactVersionId: "artifact-a",
            destination: {
              canonicalRoot: "/Users/release",
              expectedRootState: "preexisting-local-filesystem-root",
              relativePath: "dist/app.zip",
              overwrite: { kind: "create-only" },
            },
          },
        ]);
      }
    } finally {
      await rendered.cleanup();
    }
  });

  it("shows progress, no-op, conflicts, unknown-only reconciliation, and drift guidance", async () => {
    const commands: ReleaseOperationEnvelopeCommand[] = [];
    const rendered = await renderPanel({
      operations: [operation("blocked")],
      onCommand: (command) => {
        commands.push(command);
      },
    });
    try {
      const document = rendered.document;
      assert.match(document.body.innerHTML, /partially|blocked/i);
      assert.match(document.body.innerHTML, /no-op/);
      assert.match(
        document.body.innerHTML,
        /Destination drift requires a new operation/,
      );
      assert.equal(
        document.querySelectorAll("[data-release-reconcile]").length,
        1,
      );
      await change(
        document.querySelector<HTMLInputElement>(
          "[data-release-reconcile-evidence='release-operation-1']",
        )!,
        "inspection:1",
      );
      assert.equal(
        document.querySelector<HTMLButtonElement>("[data-release-reconcile]")!
          .disabled,
        false,
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>("[data-release-reconcile]")!
          .click(),
      );
      assert.deepEqual(commands[0], {
        type: "delivery.release-operation.reconcile",
        operationId: "release-operation-1",
        itemId: "merge:2",
        expectedOperationHash: "3".repeat(64),
        evidenceRefs: ["inspection:1"],
      });
    } finally {
      await rendered.cleanup();
    }
  });

  it("keeps one stable operation ID while a create gesture is in flight", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    const commands: ReleaseOperationEnvelopeCommand[] = [];
    const rendered = await renderPanel({
      onCommand: async (command) => {
        commands.push(command);
        await pending;
      },
    });
    try {
      const document = rendered.document;
      for (const repository of ["repo-api", "repo-web"]) {
        await change(
          document.querySelector<HTMLInputElement>(
            `[data-merge-target='${repository}']`,
          )!,
          "main",
        );
        await change(
          document.querySelector<HTMLInputElement>(
            `[data-merge-tip='${repository}']`,
          )!,
          repository === "repo-api" ? "5".repeat(40) : "6".repeat(40),
        );
      }
      await change(
        document.querySelector<HTMLTextAreaElement>("[data-release-reason]")!,
        "Evidence reviewed.",
      );
      await change(
        document.querySelector<HTMLInputElement>("[data-release-evidence]")!,
        "review:1",
      );
      await act(async () =>
        document
          .querySelector<HTMLInputElement>("[data-release-confirm]")!
          .click(),
      );
      const submit = document.querySelector<HTMLButtonElement>(
        "[data-release-create]",
      )!;
      assert.equal(submit.disabled, false);
      await act(async () => submit.click());
      await act(async () => submit.click());
      assert.equal(commands.length, 1);
      resolve();
    } finally {
      await rendered.cleanup();
    }
  });
});
