---
"@ai-hero/sandcastle": patch
---

Fix `sandcastle init` ignoring the selected sandbox provider in the generated main file. Choosing Podman now rewrites the `docker` import and `docker()` call sites to `podman`, instead of always scaffolding `docker`.
