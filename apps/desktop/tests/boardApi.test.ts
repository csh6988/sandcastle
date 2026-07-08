import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  markProjectRdVerified,
  saveProjectDocument,
} from "../renderer/boardApi.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Desktop renderer board API", () => {
  it("saves project Markdown documents with the Desktop PUT endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: "checkout-redesign",
          name: "Checkout Redesign",
          summary: "Improve checkout.",
          status: "draft",
          prd: { path: "prd/prd.md", status: "draft" },
          design: { path: "design/design.md", status: "draft" },
          rd: { repositories: [], currentBoardTaskId: null, history: [] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await saveProjectDocument("checkout-redesign", "prd", "# PRD\n");

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "/api/projects/checkout-redesign/documents/prd",
    );
    assert.equal(calls[0]?.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      markdown: "# PRD\n",
    });
  });

  it("marks Project R&D verified through the Desktop project API", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: "checkout-redesign",
          name: "Checkout Redesign",
          summary: "Improve checkout.",
          status: "ready-for-review",
          prd: { path: "prd/prd.md", status: "confirmed" },
          design: { path: "design/design.md", status: "skipped" },
          rd: {
            repositories: ["/repo/app"],
            currentBoardTaskId: null,
            history: ["board-task-1"],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await markProjectRdVerified("checkout-redesign");

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "/api/projects/checkout-redesign/rd/mark-verified",
    );
    assert.equal(calls[0]?.init?.method, "POST");
  });
});
