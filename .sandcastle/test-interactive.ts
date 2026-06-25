import * as sandcastle from "@chenshaohui6988/sandcastle";
import { noSandbox } from "@chenshaohui6988/sandcastle/sandboxes/no-sandbox";

// /matt-pococks-projects/sandcastle
const { commits, branch } = await sandcastle.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorktree: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
