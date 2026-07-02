import { describe, expect, it } from "vitest";
import { updateLocalIssueStatusMarkdown } from "./localIssueMarkdown.js";

describe("local issue markdown status", () => {
  it("updates an existing status line deterministically", () => {
    const markdown = `# Add API

Status: ready-for-agent

## What to build

Do it.
`;

    expect(updateLocalIssueStatusMarkdown(markdown, "in-progress"))
      .toBe(`# Add API

status: in-progress

## What to build

Do it.
`);
  });

  it("inserts a missing status line after a markdown title", () => {
    expect(
      updateLocalIssueStatusMarkdown(
        `# Add API

Implement the endpoint.
`,
        "needs-recovery",
      ),
    ).toBe(`# Add API

status: needs-recovery

Implement the endpoint.
`);
  });
});
