---
"@chenshaohui6988/sandcastle": minor
---

Add the v1 company control plane shell to the board (ADR 0026): a company-level left navigation (Departments / Projects / Artifacts / Reviews / Settings) that defaults into the Software R&D department, backed by new `GET /api/company`, `GET /api/artifacts`, `GET /api/reviews`, and `GET /api/role-profiles` endpoints. Non-software departments are inert placeholders.
