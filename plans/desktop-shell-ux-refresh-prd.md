# Sandcastle Desktop v1 MVP PRD

## Status

Draft for approval. This document is design-only and should be approved before
implementation starts.

## Product Positioning

Sandcastle Desktop v1 is a local AI company workbench. It helps a user manage
projects from PRD through design, R&D execution, review, and final artifacts.

It is not a new orchestration core, not a Copilot chat product, and not a
replacement for the existing workflow board semantics. The R&D execution stage
uses the existing board task workflow as its pipeline instance.

The top-level product object is the local AI company. A project is a complete
delivery object that moves through product stages. Repositories are external R&D
resources associated with a project; they are not the top-level navigation
object.

## Goals

- Make Desktop project-first instead of repository-first.
- Provide a light, professional, high-density R&D control-plane UI.
- Support English and Chinese app-owned UI text.
- Let users create and manage projects in a local AI company directory.
- Provide one clear project workflow:
  PRD -> Design -> R&D execution -> Review -> Artifacts.
- Provide a built-in Markdown editor for PRD, design, review decisions, and
  feedback.
- Define a robust project state machine, including stale detection for confirmed
  files that change later.
- Let departments expose AI members and let users bind skill flows to those AI
  members.
- Keep R&D execution mapped to the existing board task pipeline without
  breaking existing board task API semantics.
- Remove Copilot from Desktop v1 so opening, browsing, editing, confirming, and
  reviewing do not create extra LLM token cost.

## Non-Goals

- No Copilot sidebar, assistant entry point, or CopilotKit runtime in Desktop
  v1.
- No default LLM token consumption from opening or using the Desktop workbench.
- No AI-generated PRD, AI-generated design, or AI review checks in v1. Those are
  v2 topics and must be explicit, user-triggered, cost-visible actions.
- No skill installation or remote skill import in v1.
- No rich-text collaborative editor, version comparison, or complex block
  editor.
- No new orchestration semantics.
- No breaking changes to existing board task endpoints.
- No Electron or CopilotKit dependency leakage into root `src/`.
- No change to root `package.json#files`; the package must still publish only
  `["dist"]`.

## Target Users

- Developers and maintainers using Sandcastle to run agent workflows.
- Users who want a local project workbench for PRD, design, R&D execution,
  review, and artifacts.
- Teams that need English and Chinese app-owned UI.
- Users debugging and tuning AI members through skill-flow binding.

## Key Decisions

### Desktop v1 is project-first

The left navigation should start from Projects. A project is a product delivery
object, not a code repository. Repositories are linked only as R&D resources.

### Desktop v1 has no Copilot module

CopilotKit was useful for the shell spike, but Desktop v1 should not include a
default chat assistant. The reasons are product focus, UI simplicity, and token
cost control. The main workbench should be deterministic UI. Any future AI help
must be explicit, optional, and cost-visible.

### Board task is an R&D pipeline instance

A board task is not a small issue list item at the project level. It is the R&D
execution pipeline instance that turns PRD/design input into a plan, issues,
human approval, execution loops, verification, and recovery.

### AI members are role-like, not personified chat agents

AI members belong to departments. They represent role responsibilities and
skill-flow bindings, such as Planner, Designer, Generator, and Evaluator. They
are not always-on chat personas.

## Information Architecture

```text
Local AI Company
├─ Projects
│  └─ Project Workbench
│     ├─ PRD
│     ├─ Design
│     ├─ R&D Execution
│     ├─ Review
│     └─ Artifacts
├─ Departments
│  └─ Department Detail
│     ├─ AI Members
│     └─ Skill Flow Bindings
└─ Settings
   ├─ Language
   ├─ Local company directory
   ├─ Board/store diagnostics
   └─ Skill registry diagnostics
```

Left navigation for v1:

```text
Projects
Departments
Settings
```

AI Members must not be a separate top-level navigation item. They live inside
department details.

## Startup Model

Desktop first launch should ask the user to select or create a local AI company
directory.

```text
First launch
-> Select or create local AI company directory
-> Ensure required company structure exists
-> Open Projects list
```

Subsequent launches:

```text
If a last-opened project exists
-> Open that project workbench

Otherwise
-> Open Projects list
```

Electron `userData` is for personal preferences only, such as language, last
opened project, and window state. Company/project data and skill-flow
configuration belong under the local AI company directory.

## Directory Model

Default company layout:

```text
company-root/
├─ projects/
│  └─ <project-name>/
│     ├─ prd/
│     │  ├─ prd.md
│     │  └─ assets/
│     ├─ design/
│     │  ├─ design.md
│     │  └─ assets/
│     ├─ review/
│     │  ├─ verification.md
│     │  ├─ decision.md
│     │  └─ feedback.md
│     ├─ artifacts/
│     │  ├─ manifest.json
│     │  ├─ delivery.md
│     │  ├─ screenshots/
│     │  └─ files/
│     └─ project.json
└─ .sandcastle/
   ├─ board/
   ├─ skill-flows.json
   ├─ role-profiles.json
   └─ project-index.json
```

The user-visible project directory should contain project artifacts and stage
documents. `.sandcastle/` contains system metadata, board state, indexes, and
configuration.

Project directories default to `company-root/projects/<project-name>/`. An
advanced option may allow an external project directory, but the MVP path should
prefer the company `projects/` directory.

Repositories must not be copied into the project directory by default. They are
linked as external paths in project metadata and used by the R&D execution
stage.

Example project metadata shape:

```json
{
  "id": "project-id",
  "name": "Project name",
  "summary": "Project goal",
  "status": "draft",
  "prd": {
    "path": "prd/prd.md",
    "status": "draft"
  },
  "design": {
    "path": "design/design.md",
    "status": "draft"
  },
  "rd": {
    "repositories": ["/path/to/repo"],
    "currentBoardTaskId": null,
    "history": []
  }
}
```

## Project Creation

MVP project creation fields:

- Project name.
- Project summary / goal.
- Linked code repositories, optional.

PRD, design, R&D plan, review, and artifacts are created or populated after the
project exists.

## Project Workflow

The fixed v1 project workflow is:

```text
PRD -> Design -> R&D Execution -> Review -> Artifacts
```

### PRD Stage

The PRD stage contains `prd/prd.md` and `prd/assets/`.

MVP actions:

- Edit.
- Save.
- Preview.
- Import file.
- Open folder.
- Confirm PRD.

Confirming PRD is a human action in v1. AI PRD generation or checking is a v2
topic.

### Design Stage

The Design stage contains `design/design.md` and `design/assets/`.

MVP actions:

- Edit.
- Save.
- Preview.
- Import file.
- Open folder.
- Confirm Design.
- Skip Design with a required reason.

Design must be confirmed or explicitly skipped before R&D execution can start.

### R&D Execution Stage

R&D is an execution view, not a required project content directory.

The current R&D execution input is:

```text
confirmed PRD
+ confirmed Design, or skipped Design with reason
+ linked repositories
+ optional R&D execution notes
```

R&D creates or resumes the current board task pipeline instance:

```text
Project
└─ R&D Execution
   ├─ currentBoardTaskId
   └─ history[]
```

MVP allows one current board task per project. History is retained for prior R&D
pipeline instances. Future versions may support richer multi-iteration
management.

The UI should show the existing board task workflow as a product pipeline:

```text
Planning -> Approval -> Running -> Verifying -> Done
```

Board-generated issues are internal details of the R&D pipeline and should be
shown as pipeline details, not as top-level projects.

### Review Stage

The Review stage focuses on R&D delivery review.

Review files:

```text
review/
├─ verification.md
├─ decision.md
└─ feedback.md
```

MVP review actions:

- View verification report.
- Edit decision.
- Edit feedback.
- Accept delivery.
- Request changes.
- Reject delivery.

PRD and Design may have their own confirmation states, but v1 Review is for R&D
delivery.

### Artifacts Stage

The Artifacts stage contains final delivery artifacts and delivery metadata.
It should not copy every process document into one folder.

```text
artifacts/
├─ manifest.json
├─ delivery.md
├─ screenshots/
└─ files/
```

Process documents are still visible through the UI but remain in their own
stage directories:

- `prd/prd.md`
- `design/design.md`
- `review/verification.md`
- `review/decision.md`
- `review/feedback.md`

## Project State Machine

Project state and stage confirmation state must be distinct. The main project
state is the delivery flow state; each stage can also track confirmation,
skipped, or stale status.

### Main Project States

```text
draft
  Project exists, PRD is not confirmed.

prd-confirmed
  PRD is confirmed and the project may move into Design.

design-ready
  Design is confirmed, or Design was skipped by a human with a recorded reason.
  R&D execution may start.

in-rd
  The current board task pipeline is planning, awaiting approval, running,
  recovering, or verifying.

ready-for-review
  R&D pipeline completed and a verification report exists.

accepted
  Human review accepted the delivery.

changes-requested
  Human review requested changes. The project can return to PRD, Design, or R&D
  for another R&D pipeline instance.

rejected
  Human review rejected the delivery. History and artifacts are retained.
```

### Transitions

```text
create project
-> draft

confirm PRD
draft -> prd-confirmed

confirm Design
prd-confirmed -> design-ready

skip Design with reason
prd-confirmed -> design-ready

start R&D pipeline
design-ready -> in-rd
changes-requested -> in-rd

R&D verified
in-rd -> ready-for-review

review accept
ready-for-review -> accepted

review request changes
ready-for-review -> changes-requested

review reject
ready-for-review -> rejected
```

### Guards

R&D cannot start when:

- PRD is not confirmed.
- Design is neither confirmed nor skipped with a reason.
- Another current board task is still active.

Review cannot start when:

- The current R&D pipeline has not completed verification.
- `review/verification.md` is missing.

Accepted cannot be reached when:

- There is no human review decision.

### Changes Requested

When review requests changes, the user must choose the change scope:

```text
Modify PRD
Modify Design
Rerun R&D only
```

The selected scope decides which stage becomes active and which inputs feed the
next R&D pipeline.

### Stale Detection

When a file is confirmed, Desktop should record enough metadata to detect later
external edits, such as file hash and updated timestamp.

If a confirmed file changes:

- The corresponding stage becomes stale.
- The UI displays "changed after confirmation; reconfirm required".
- The project returns to the nearest safe state.

Examples:

- Confirmed PRD changes -> PRD must be reconfirmed before R&D can start.
- Confirmed Design changes -> Design must be reconfirmed or skipped again.
- Review files changing externally should show a warning, but should not
  automatically delete an accepted state.

## Metadata Diagnostics

When file-system project data and `.sandcastle` metadata disagree, Desktop
should diagnose and ask the user before repair.

Examples:

- `project-index.json` references a missing project.
- A project directory exists but is not indexed.
- `currentBoardTaskId` references a missing board task.

MVP diagnostics should support:

- Re-indexing project directories.
- Clearing missing `currentBoardTaskId` references.
- Marking R&D state as requiring human attention.

MVP must not automatically delete directories, overwrite project files, or
silently discard metadata.

## Departments, AI Members, and Skill Flows

Departments represent execution capabilities inside the local AI company.

AI members live inside departments. They are role-like execution members, not
personified chat agents.

Example Software R&D department:

```text
Software R&D
├─ Planner
├─ Designer
├─ Generator
└─ Evaluator
```

AI members expose:

- Responsibility boundary.
- Allowed actions.
- Forbidden actions.
- Bound skill flows.
- Model preference, if configured.
- Agent preference, if configured.

### Skill Flow Binding

Skill flow binding is MVP-critical because it supports debugging and tuning the
AI members.

MVP binding model:

- Bind by skill flow, not individual skill.
- Enable or disable a flow for an AI member.
- Reorder bound flows.
- Expand a flow to inspect included skills.
- Save bindings to company/project Sandcastle configuration.

Skill flow sources:

- Built-in Sandcastle flows.
- Existing local company configuration.
- Desktop-created custom flows.

MVP custom flow support:

- Read existing flows.
- Create a flow.
- Name a flow.
- Select available skills that compose the flow.
- Bind flow to an AI member.
- Persist configuration.

Custom skill flows should be saved under the local AI company `.sandcastle/`
configuration, for example:

```text
.sandcastle/skill-flows.json
.sandcastle/role-profiles.json
```

Skill installation and remote import are v2 topics. V1 should show missing
skills as diagnostics but should not install them.

## Settings

Settings is for global, low-frequency configuration and diagnostics.

MVP Settings:

- Language: English / Chinese.
- Local AI company directory.
- Board/store status.
- Project index diagnostics.
- Skill registry diagnostics.
- Desktop version.

Department member configuration and skill-flow binding belong in department
details, not in global Settings.

## Bilingual UI

App-owned UI text must support English and Chinese.

Translate:

- Navigation labels.
- Status labels.
- Stage labels.
- Empty states.
- Buttons.
- Forms.
- Validation messages.
- Settings and diagnostics labels.
- Department/member/skill-flow management UI.

Do not translate:

- Board-provided task titles.
- User-authored PRD content.
- User-authored design content.
- Artifact paths.
- Verification markdown generated by the board.
- External repository paths.

Default language policy:

- First launch follows system language when possible.
- Fallback is English.
- Manual selection persists in Electron `userData`.

## Visual Direction

Desktop v1 should use a light, professional, productized R&D-console visual
style.

Suggested palette:

```text
app background: #f6f8fb or #f8fafc
panel:          #ffffff
border:         #d8dee8
text:           #172033
muted:          #667085
primary:        #2563eb
success:        #16a34a
warning:        #d97706
danger:         #dc2626
```

Avoid:

- Black or dark base theme.
- Decorative gradients.
- Marketing hero pages.
- Large decorative cards.
- Chat-first layout.
- UI text that explains obvious UI mechanics.

## Layout Wireframes

### Projects List

```text
┌─────────────────┬──────────────────────────────────────────────────┐
│ Sandcastle      │ Local AI Company                     Language     │
│                 ├──────────────────────────────────────────────────┤
│ Projects        │ Projects                                         │
│ Departments     │ [New Project]                                    │
│ Settings        │                                                  │
│                 │ ┌──────────────────────────────────────────────┐ │
│                 │ │ Project name    status    updated            │ │
│                 │ │ Summary                                      │ │
│                 │ └──────────────────────────────────────────────┘ │
└─────────────────┴──────────────────────────────────────────────────┘
```

### Project Workbench

```text
┌─────────────────┬──────────────────────────────────────────────────┐
│ Projects        │ Project: Checkout redesign          status        │
│ Departments     ├──────────────────────────────────────────────────┤
│ Settings        │ PRD | Design | R&D Execution | Review | Artifacts │
│                 ├──────────────────────────────────────────────────┤
│                 │ Stage summary / guard status                     │
│                 │                                                  │
│                 │ Main stage content                               │
│                 │                                                  │
│                 │ Stage actions                                    │
└─────────────────┴──────────────────────────────────────────────────┘
```

### R&D Execution

```text
┌────────────────────────────────────────────────────────────────────┐
│ R&D Execution                                                      │
│ Inputs: confirmed PRD, confirmed/skipped Design, repositories      │
├────────────────────────────────────────────────────────────────────┤
│ Pipeline: Planning -> Approval -> Running -> Verifying -> Done     │
├────────────────────────────────────────────────────────────────────┤
│ Current board task                                                │
│ - Plan summary                                                    │
│ - Generated issues                                                │
│ - Approval status                                                 │
│ - Run status                                                      │
│ - Verification status                                             │
└────────────────────────────────────────────────────────────────────┘
```

### Department Detail

```text
┌────────────────────────────────────────────────────────────────────┐
│ Department: Software R&D                                           │
├──────────────────────┬─────────────────────────────────────────────┤
│ AI Members           │ Selected member: Planner                    │
│ - Planner            │ Responsibility                              │
│ - Designer           │ Skill flows                                 │
│ - Generator          │ [x] planning-flow      [move up/down]       │
│ - Evaluator          │ [ ] review-flow                            │
│                      │ Available flows / create flow               │
└──────────────────────┴─────────────────────────────────────────────┘
```

### Markdown Editor

```text
┌────────────────────────────────────────────────────────────────────┐
│ PRD                                      [Import] [Save] [Confirm] │
├──────────────────────────────┬─────────────────────────────────────┤
│ Markdown editor              │ Preview                             │
│                              │                                     │
│                              │                                     │
└──────────────────────────────┴─────────────────────────────────────┘
```

## Built-In Markdown Editor

MVP needs a built-in Markdown editor for:

- PRD.
- Design.
- Review decision.
- Feedback.

Required editor actions:

- Edit.
- Save.
- Preview.
- Confirm.
- Import file.
- Open containing directory.

Recommended technical direction:

- CodeMirror 6 for editing.
- Lightweight Markdown preview.

Reasons:

- Open source.
- Markdown-first.
- Good fit for developer-oriented documents.
- Strong control over file saving, stale detection, and future asset handling.
- Lower product complexity than rich-text editors.

Alternative:

- `@uiw/react-md-editor` if implementation speed is more important than custom
  control.

## API Direction

Implementation may add project, department, and skill-flow APIs as long as
existing board task APIs remain compatible.

Allowed new API surface examples:

```text
GET  /api/projects
POST /api/projects
GET  /api/projects/:id
PUT  /api/projects/:id
GET  /api/skill-flows
POST /api/skill-flows
PUT  /api/departments/:id/members/:memberId/skill-flows
```

Existing board task endpoints must keep their current semantics:

```text
/api/tasks
/api/tasks/:id/resume
/api/tasks/:id/cancel
/api/tasks/:id/recover
/api/tasks/:id/artifacts
```

## Implementation Phases

1. Planning artifacts.
   - Approve this PRD.
   - Update or add an ADR for the shift from Copilot shell to project
     workbench shell.
   - Update `CONTEXT.md` terms for Project, local AI company directory, AI
     member, and skill flow if needed.

2. Remove Copilot from Desktop v1 product surface.
   - Remove Copilot UI/runtime from the desktop shell implementation.
   - Remove Copilot model/key requirements from Desktop docs.
   - Keep all changes scoped to `apps/desktop`.

3. Local AI company directory.
   - First-run choose/create company directory.
   - Ensure `projects/` and `.sandcastle/` structure.
   - Persist personal preferences in Electron `userData`.

4. Project model and state machine.
   - Project create/list/detail.
   - Project directory creation.
   - `project.json`.
   - State transitions and guards.
   - Stale detection.

5. Project workbench.
   - Project tabs: PRD, Design, R&D Execution, Review, Artifacts.
   - Light theme and app frame.
   - English/Chinese i18n foundation.

6. Markdown editor.
   - PRD editor.
   - Design editor.
   - Review decision and feedback editor.
   - Import/save/preview/confirm.

7. R&D execution integration.
   - Start current board task from confirmed PRD/design inputs.
   - Show pipeline status.
   - Show generated issues and verification status as pipeline details.
   - Preserve existing board task API semantics.

8. Departments and skill flows.
   - Department list/detail.
   - AI member list/detail.
   - Skill-flow creation.
   - Skill-flow binding to AI members.
   - Missing skill diagnostics.

9. Review and artifacts.
   - Verification report view.
   - Review decision actions.
   - Artifacts manifest and delivery view.

10. Verification and QA.
    - Desktop typecheck/build.
    - Root typecheck/format.
    - Browser/Electron screenshots for key flows.
    - Ensure root package publish surface remains `["dist"]`.

## Acceptance Criteria

- Desktop first launch selects or creates a local AI company directory, not a
  repository.
- Desktop default screen is Projects list or the last opened project workbench.
- A user can create a project with name, summary/goal, and optional repository
  links.
- Project workbench shows PRD, Design, R&D Execution, Review, and Artifacts.
- PRD and Design can be edited, saved, previewed, and confirmed.
- Design can be skipped only with a reason.
- R&D cannot start until PRD is confirmed and Design is confirmed or skipped.
- R&D uses the existing board task workflow as the current pipeline instance.
- Project Review decides accepted, changes-requested, or rejected.
- Confirmed file edits are detected and displayed as stale.
- Departments show AI members.
- AI members can bind skill flows.
- Users can create custom skill flows from available skills.
- Skill installation/import is not included in v1.
- Copilot is not present in Desktop v1 UI or required configuration.
- Opening, browsing, editing, confirming, reviewing, and binding skill flows do
  not consume LLM tokens.
- App-owned UI supports English and Chinese.
- No Electron/CopilotKit dependency leaks into root `src/`.
- Root package publish files remain `["dist"]`.

## Open Implementation Risks

- Current desktop implementation is repository-first and starts the board with
  the selected repository as cwd. The MVP changes the product model to a local
  AI company directory, with repositories linked as R&D resources.
- Existing `CONTEXT.md` and ADR 0027 describe a CopilotKit desktop shell. They
  need a follow-up ADR/CONTEXT update before implementation.
- Existing company API currently treats projects as workspace repositories. The
  MVP needs a clearer distinction between Project and Repository.
- Project data and board task data must be connected without making board task
  the top-level product object.
- Skill-flow editing must be useful for debugging while staying scoped to
  configuration, not skill installation or agent-provider changes.

## V2 Placeholder

V2 should be designed separately. Known v2 candidates:

- AI-generated PRD.
- AI-assisted design generation.
- AI checks for PRD and Design.
- Explicit cost/model prompts before AI actions.
- Skill installation/import.
- Richer multi-iteration project management.
- Version history and document comparison.
