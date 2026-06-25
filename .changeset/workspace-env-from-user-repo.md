---
"@chenshaohui6988/sandcastle": patch
---

Fix `sandcastle workspace plan/run/execute` reading the wrong `.env`. They resolved the env file relative to the installed package (`<package>/.sandcastle/.env`), which only exists when the package *is* the repo (dogfooding); for `npm install`ed users it pointed inside `node_modules` and silently loaded no credentials. These commands (and `init --plan`) now read the user's repo at `<cwd>/.sandcastle/.env` — where `sandcastle init` writes it — while still honoring the `SANDCASTLE_ENV_FILE` override. The host-side `local-issue` command keeps its existing package-relative behavior.
