import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownPreviewBlocks } from "../renderer/markdownPreview.js";

describe("markdownPreviewBlocks", () => {
  it("parses Desktop Markdown preview blocks without external LLM or editor services", () => {
    assert.deepEqual(
      markdownPreviewBlocks(`# PRD

Goal line
wraps here.

- Preview updates
- Save persists

\`\`\`ts
const saved = true;
\`\`\`
`),
      [
        { type: "heading", level: 1, text: "PRD" },
        { type: "paragraph", text: "Goal line wraps here." },
        { type: "list", items: ["Preview updates", "Save persists"] },
        { type: "code", code: "const saved = true;" },
      ],
    );
  });
});
