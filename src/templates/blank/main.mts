import { run, claudeCode } from "@chenshaohui6988/sandcastle";
import { docker } from "@chenshaohui6988/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: "./.sandcastle/prompt.md",
});
