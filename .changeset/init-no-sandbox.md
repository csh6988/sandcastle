---
"@ai-hero/sandcastle": minor
---

Allow `sandcastle init` to scaffold runners with the `no-sandbox` provider. Selecting no-sandbox rewrites generated templates to import and call `noSandbox()`, skips Dockerfile/Containerfile generation, and skips image-build prompts because the agent runs directly on the host.
