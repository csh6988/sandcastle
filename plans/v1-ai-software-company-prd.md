# Sandcastle v1.0 AI 软件公司 PRD

## 文档状态

- 状态：端到端 AI 软件交付生产线 Draft 3
- 版本：v1.0 Draft 3
- 语言：本文以中文为主；产品必须完整支持简体中文和英文
- 技术方案：`plans/v1-ai-software-company-technical-design.md` Draft 3；本 PRD 是产品行为边界
- 领域词汇：以根目录 `CONTEXT.md` 为唯一术语来源

## 1. 产品定义

Sandcastle v1.0 是一个本地优先、可监督自治的 **AI 软件公司**。

用户创建一个 Project 后，先直接与 **Product manager** 对话，澄清目标、用户、范围、验收标准和约束。用户确认需求边界后，**Delivery coordinator** 接管后续编排，组织产品评审、技术设计、技术评审、任务拆分、Worktree 并行开发、独立 Code Review、集成、交互测试、安全与可运维检查，最终组装不可变的 **Delivery candidate**，交给人进行发布决策。

用户不需要逐个手工驱动 Agent，但任何自动推进都必须可观察、可暂停、可检查、可回放和可审计。每个 Agent 的身份、输入、Session、Tool Call、权限请求、产物、Diff、用量、决策理由、状态转换和失败证据都属于正式 Run Record。

Sandcastle 不是聊天机器人集合，也不是把现有 Board 套上“公司”导航；它是一条有明确输入、输出、标准、质量门和改进闭环的 AI 软件交付生产线。现有 Board、Agent、Sandbox、Worktree 和 Runtime Event 能力应成为内置 Software R&D Department 的执行基础，而不是新的产品事实来源。

### 一句话价值

让用户只需确认目标和最终交付，就能在一条可监督、可恢复、可追踪、可持续优化的多角色 AI 软件生产线上完成真实项目。

## 2. 当前问题

当前 Desktop 和旧 Board 能力与工业化 AI 交付仍存在以下缺口：

1. 用户需要手工在产品、技术、开发和测试角色之间传递上下文，信息在阶段之间衰减。
2. 产品评审、技术评审、独立 CR、交互测试和安全检查不是正式的一等流程对象。
3. 任务拆分和多开发者并行缺少 Work Package、依赖、Worktree、分支和集成边界。
4. Coordinator、Product manager、Architect、Developer、Reviewer、Tester 的职责和权限未形成明确的交接链。
5. “自主执行”如果只有状态按钮，没有逐 Agent 的权威证据，会让人工无法监控风险。
6. 失败通常只产生一段日志，不能自动形成 Defect、Rework、复测和根因分析闭环。
7. 复杂项目可能包含多个代码仓库和应用，但 Project-level 目标、跨应用契约和 per-application Spec 尚未形成统一模型。
8. 交付完成容易被误认为“Agent 运行成功”，缺少 Delivery candidate 和人工发布门。
9. 执行日志、返工、成本和讨论轮次没有反馈到 Harness、Spec、模板和 Skill Flow 的持续改进。

## 3. 产品目标

### 3.1 v1.0 目标

- 提供一个本地优先的 AI 软件交付控制面和 Software R&D Department 模板。
- 用户首先直接与 Product manager 对话；需求边界确认后，由 Delivery coordinator 接管生产线。
- 支持 Project 关联多个 Repository / Application，并维护共享 Project Spec、跨应用契约和 per-application Spec。
- 以明确的产品评审和技术评审 Topic 处理多角色独立审查、冲突讨论、方案修订和独立复核。
- 技术方案通过后自动生成版本化 Work Package，声明目标、验收、依赖、单一 Application/Repository 范围、权限、assignment/isolation requirements 和集成条件。
- 允许无依赖 Work Package 并行执行；每个 Attempt-owned Workspace Allocation 拥有独立 branch、Worktree、Sandbox、Interaction Session、Node Run 和 Artifact lineage。
- 由独立 Reviewer 在新 Session 和独立上下文中执行 Code Review；原开发者不能批准自己的实现。
- 通过 Integration branch 按依赖顺序集成；冲突和跨包失败形成 Integration defect 并回到责任 Work Package。
- 通过真实 Electron renderer、preload 和 Company Runtime 执行用户可见交互测试，并保存完整 Test run 证据。
- 每个 Delivery candidate 都拥有安全和可运维检查结果；高风险变更执行深度审查。
- 运行在审批点之间采用 Supervised autonomy：自动推进，但逐 Agent 可见、可暂停、可咨询、可介入、可回放。
- 生成不可变 Delivery candidate，最终发布由人工 Human release decision 决定；v1 不默认自动部署生产环境。
- 从 Run Record、Review、Test defect、成本、耗时和干预统计生成 Improvement proposal，并通过人工审核后改进 Harness、Spec、模板和 Skill Flow。
- 保留既有 Agent Provider、Sandbox Provider、Worktree、Runtime Event、AG-UI、ACP 和 Company Runtime 的可替换边界。
- 默认不需要账号或云服务，完整支持简体中文和英文。

### 3.2 非目标

- v1 不让一个全能 Agent 同时承担产品决策、架构实现、审查和发布批准。
- v1 不允许 Agent 静默改写产品基线、Project Spec、Pipeline、Work Package 合同、Snapshot 或审批结果。
- v1 不暴露模型原始私有思维链；可观察对象是结构化活动、证据、决策理由和可回放事件。
- v1 不允许多个开发 Agent 共享同一个可写 Worktree。
- v1 不提供无限轮次、无预算、无停止条件的自主群聊。
- v1 不把 Discussion、咨询或原始日志自动登记为正式 Artifact 或 Memory。
- v1 不允许安全、测试或 Review Agent 绕过 Company Runtime 权限和 Snapshot 边界。
- v1 不默认自动部署生产环境；部署通过单独授权的未来 Deployment Adapter 执行。
- v1 不自动修改 Harness、规则、模板或 Skill Flow；统计系统只生成 Improvement proposal。
- v1 不提供账号、云同步、企业租户、人力资源、薪资或组织汇报线系统。

## 4. 目标用户

### 4.1 产品负责人 / 独立开发者

希望直接描述目标并观察软件从需求到交付的全过程，只在需求边界、异常风险和最终发布处做关键决策。

### 4.2 小型软件团队负责人

希望把团队规范、仓库契约、测试标准和质量门固化成可重复的 AI 生产线，而不是依赖个人手工传话。

### 4.3 流程与 Agent 设计者

希望定义 Department、Position、Harness、Skill Flow、Review Topic 和 Pipeline 模板，并根据运行数据持续优化交付质量。

## 5. 产品原则

1. **产品入口清晰**：需求发现阶段只有 Product manager 直接承接用户；确认后由 Delivery coordinator 接管。
2. **职责分离**：提出方案、实现、审查、测试、安全检查和发布决策必须有独立责任边界。
3. **标准先于模型**：Harness、Spec、Artifact Contract 和验收标准定义生产方式，模型只是可替换执行器。
4. **审批少而明确**：需求确认和最终发布是硬门；中间阶段自动推进，异常和高风险才升级。
5. **自治必须可监督**：每个 Agent 过程实时可见、可暂停、可取消、可咨询、可介入、可回放。
6. **版本冻结**：每个 Snapshot Revision 冻结当时已纳入的 Pipeline、Spec、Harness、Skill/Memory、权限和输入 Artifact refs；后续 accepted inputs 只通过新 revision 生效。
7. **隔离并行**：并行开发只能在独立 Worktree、branch、Sandbox 和 Session 中进行。
8. **独立质量**：Review、Test、Security 和 Operability 使用独立 Session，不能依赖实现 Agent 的自我陈述。
9. **证据优先**：UI 文案、Agent 宣称或按钮存在都不能替代 Runtime payload、Diff、日志、测试和截图证据。
10. **失败可回到责任点**：缺陷、冲突、审批拒绝和测试失败必须带证据回到对应阶段，不覆盖原记录。
11. **交付有明确终点**：全部质量门通过只生成 Delivery candidate；发布需要 Human release decision。
12. **记忆和改进受控**：原始日志不自动变成记忆，流程规则不根据单次失败自动变化。
13. **项目支持多应用**：Project 是交付对象，Repository 是资源；跨应用契约是显式输入和质量门。
14. **本地优先**：默认不登录、不公开监听、不上传公司数据、不依赖远程控制面。

## 6. 核心领域模型

```text
Company
├─ Projects
│  ├─ Product Baselines
│  ├─ Project Specs
│  ├─ Repository / Application References
│  ├─ Department Runs
│  │  ├─ Run Configuration Snapshot
│  │  ├─ Pipeline Node Runs / Work Packages
│  │  ├─ Review Topics / Approvals
│  │  ├─ Test Runs / Defects
│  │  ├─ Run Records / Runtime Events
│  │  ├─ Delivery Candidates
│  │  └─ Artifacts / Lineage
│  └─ Project Memory / Improvement Proposals
├─ Departments
│  ├─ Positions
│  │  └─ AI Members (1:1 in v1)
│  │     ├─ Skills / Skill Flows
│  │     ├─ Harness bindings
│  │     ├─ Memory
│  │     └─ Work History
│  └─ Department Pipeline Versions
└─ Company Agent Adapters / Local Settings
```

### 6.1 Company

本地产品边界，拥有 Projects、Departments、Artifacts、Harness 引用、Agent Catalog 和公司级配置。v1 一次打开一个 Company Directory。

### 6.2 Project

Project 是业务交付对象，拥有目标、共享上下文、Product Baseline、Project Spec、多个 Repository / Application reference、Department Runs、Artifacts、Memory 和改进记录。Project 不等于某一个仓库，也不被固定成单一阶段状态机。

### 6.3 Product manager 与 Product Baseline

Product manager 是需求发现阶段直接面对用户的 Position / AI Member，负责澄清目标、用户、范围、非目标、验收标准、风险和约束。用户明确确认后形成 Product Baseline；Product manager 不能自动把未经确认的内容变成正式开发输入。

### 6.4 Delivery coordinator

Delivery coordinator 在 Product Baseline 确认后接管编排，负责推进 Department Pipeline、创建 Review Topic、协调角色 Session、拆分 Work Package、处理依赖、触发质量门、升级异常并组装 Delivery candidate。Coordinator 不是 Company Runtime，也不能批准自己产生的实现。

### 6.5 Project Spec 与 Application Spec

- Project Spec：记录共享 outcome、Project acceptance criteria、应用边界、跨应用 API / data contract、交付约束和各 Application Spec 的关系。
- Application Spec：为单个 Application 细化设计、验收标准、Work Package 约束和集成义务，不得脱离 Project Spec 重新定义目标；一个 Repository 可以包含多个 Application。
- Product Baseline、Project Spec、Application Spec 均版本化；Baseline confirmation 或 explicit Fork 都原子创建 Run/r1，后续 Specs 只通过 PASS gate promotion 进入新的 Snapshot Revision。

### 6.6 Department、Position 与 AI Member

Department 是可编辑、可发布、可恢复的工作执行单元。Position 定义职责、允许动作、Harness、Skill Flow、输入和产物。v1 一个 Position 对应一个长期 AI Member；AI Member 身份独立于 Provider、模型、Sandbox 和一次 Agent Session。

内置 Software R&D Department 至少包含：Product manager、Delivery coordinator、Product reviewer、Software architect、Developer、Code reviewer、Test engineer、Security reviewer、Operability reviewer。需要并行 Developer 时创建多个同职责 Developer Positions；每个 Position 仍恰由一个长期 AI Member 占用，每个 Work Package Attempt 只有一个明确 assignment。

### 6.7 Department Pipeline

Pipeline 是显式、可视化、可版本化、可恢复的 DAG。顶层节点类型闭集为 Start、AI Task、Human Approval、Condition、Parallel、Join 和 Complete；内置 Software R&D Department 通过 `name@version` 的 Node Handler Kind 与冻结 schema hash 表达 Review、Work Package Fan-out、Integration、Test、Security、Operability 和 Candidate。用户不能写任意代码节点，也不能让当前同名 Handler 重解释历史 Run。

### 6.8 Department Run 与 Supervised autonomy

Department Run 是确认 Product Baseline 时与 Snapshot `r1` 原子创建的正式生产执行；Start 只调度后续 Node Run。Run 在硬门之间自动推进，但每个 Agent、Interaction Turn 及其 Session 的过程都通过 Runtime Event 和 Run Record 可见。用户可以观察、暂停、取消指定 Turn/Attempt、发起旁路咨询或执行 Governed intervention；实质性变更必须暂停当前 Node Run，并以新的 Snapshot Revision 或 Node Attempt 继续。

### 6.9 Work Package、Worktree 与 Integration branch

Work Package 是 promoted Technical Baseline 产出的正式实现合同；每个版本恰属一个 Application/Repository，跨仓目标拆成有依赖的多个包。Version 声明目标、验收、依赖、模块范围、权限、assignment/branch/isolation requirements、预期 Artifact 和集成条件；每个 Node Attempt 再拥有自己的 assignment 与 Workspace Allocation（branch、Worktree、Sandbox、Interaction Session）。新 Attempt 不复用旧 Attempt 的可写资源。通过 exact-commit 独立 CR PASS 后，变更按依赖顺序进入 generation-scoped Integration branch。

### 6.10 Review topic

Review topic 是有范围、预算、最大轮次、owner participant、eligible reviewer participants、moderator、输入 Artifact、验收标准和停止条件的 Discussion topic。只有 eligible reviewers 先独立提交 findings 并计入 quorum/Gate vote，再只围绕重大冲突讨论；方案负责人修订后由 eligible independent reviewers 复核。结论为 `PASS`、`CONDITIONAL_PASS` 或 `FAIL`，不能由方案负责人自己批准。

### 6.11 Test run、Security review 与 Operability review

- Test run 执行版本化 Test case 并保存 UI 操作、Runtime payload、截图、日志、环境和状态。
- 用户可见交互必须启动真实 Electron renderer + preload + Company Runtime；优先使用 `ScriptedExecutionAdapter` / `ScriptedInteractionExecutionAdapter` 和临时 Company Directory，不调用本机真实 Agent。`ScriptedRuntimeTransport` 只用于绕过真实 Runtime 的 client contract tests。
- Security review 和 Operability review 贯穿交付流程；低风险执行轻量检查，高风险执行深度检查。
- 所有质量结果必须关联 Run、Snapshot、Node Run、Work Package、Artifact 和证据。

### 6.12 Delivery candidate 与 Human release decision

开发、集成和 required Test 完成后，Runtime 先冻结 Delivery Candidate Input；Security/Operability 等最终 Gate 绑定其 exact hash。全部 required Gate `PASS` 后才组装不可变 Delivery candidate。Candidate 等待人工发布决策；v1 不默认自动部署生产环境。

### 6.13 Harness 与 Improvement proposal

Harness 由原则、Project / Department constitution、规则和正反例组成，规定“按照什么标准做”。Spec 规定“这个需求怎么生产”。Run 冻结 Harness 和 Spec 引用。统计系统从 Run Record、缺陷、成本、耗时、评审轮次和人工介入生成 Improvement proposal；只有人工批准后，改进才会进入后续 Harness、Spec、模板或 Skill Flow。

## 7. 端到端主流程

```text
创建 Project / 关联多个 Repository
→ Product manager 需求澄清
→ 用户确认 Product Baseline + 原子创建 Department Run / Snapshot r1（硬门）
→ Project Spec draft
→ 产品 Review topic：独立审查 → 有界讨论 → Project Spec 修订 → 独立复核
→ Gate promotion：accepted Project Spec
→ Repository readiness 与跨应用契约预检
→ Gate promotion：accepted readiness evidence
→ Software architect 技术设计 + Application Spec drafts / Technical Baseline Proposal
→ 技术 Review topic：独立审查 → 有界讨论 → Application Spec / Proposal 修订 → 独立复核
→ Gate promotion：accepted Application Specs / Technical Baseline
→ Delivery coordinator 拆分并版本化 Work Package
→ 多个 Developer 在独立 Worktree / Sandbox 并行执行
→ Developer self-check
→ 独立 Code Review
→ Integration Generation / per-repository branch 按依赖顺序集成
→ Integration Test / 跨应用契约验证
→ 真实 Electron 交互 Test run
→ 冻结 Delivery Candidate Input
→ Security review / Operability review（绑定 exact input）
→ 组装 Delivery candidate
→ Human release decision
→ 合并、导出或未来授权部署
→ 统计、根因分析和 Improvement proposal
```

### 7.1 硬门与自动推进

- 硬门一：用户确认 Product Baseline 的同一 Command 原子创建正式 Department Run 与 Snapshot `r1`；后续 Start 只调度 Node Run，不能再次 formalize。
- 中间阶段：Review、设计、拆分、开发、集成、测试和安全检查只在前置 `PASS` Quality Gate Result 允许时自动推进。`CONDITIONAL_PASS` 只启动修订/验证 obligation，完成 fresh re-review 前不能 promotion、Integration 或组装 Candidate。
- 异常升级：范围变化、跨应用契约冲突、危险权限、预算超限、重复失败、质量门 `FAIL` 或多次 `CONDITIONAL_PASS` 时暂停并升级。
- 硬门二：只有人工 Human release decision 才能把 Delivery candidate 变成已接受交付。

### 7.2 产品评审

产品 Review topic 以 Product Baseline + Project Spec draft 为固定输入，Product manager 作为方案 owner/topic participant 回答问题、处理 finding 并修订 Project Spec，但不提交 independent finding、不投 Gate vote。Domain / Product reviewer、Software architect、Test engineer 和 Security / Operability reviewer 各自在独立 Session 中检查目标、范围、用户价值、验收标准、Application 边界、风险和可验证性；Coordinator 汇总冲突并主持有界讨论，修订后由 eligible independent reviewers 复核。若 finding 要改变已确认的目标、范围、非目标或用户验收，必须形成新 Product proposal、重新确认并 Fork 新 Run，不能覆盖 Product Baseline。

### 7.3 技术设计与评审

技术设计以 promoted Project Spec 和 readiness evidence 为输入，生成每个 Application Spec draft 和一个 immutable Technical Baseline Proposal revision。Software architect 负责架构、模块边界、API / data contract、数据迁移、部署与回滚约束。技术 Review Gate 绑定 exact proposal hash；fresh re-review `PASS` 后，唯一 gate-promotion Unit of Work 才物化 accepted Technical Baseline 并把它固定进 Snapshot，Gate Result 与 accepted manifest 不形成自引用。

### 7.4 多 Worktree 开发

Coordinator 根据依赖图创建 Work Package。无依赖包并行，存在依赖的包等待前置 Artifact / commit / contract。每个开发 Node Attempt 使用独立 Workspace Allocation（branch、Worktree、Sandbox、Interaction Session）和 Snapshot；只有同一 non-terminal Attempt 的 reattach 可复用其 allocation。正式 Work Package 的 Agent 只能写 isolated execution tree，不能访问共享 Git common directory；Company Runtime-owned importer 校验结果后只能推进该 allocation 的 source branch。

### 7.5 独立审查、返工与集成

Developer self-check 只代表实现者的初步证据。Code reviewer 在新 Session、独立 Workspace 和无实现上下文下，输入限定为 Diff、Spec、Harness、测试和知识。发现问题时生成 Code Review finding / Test defect，退回责任 Work Package；修复会产生新的 Attempt / Revision，旧证据保留。通过后进入 Integration branch，冲突或聚合失败生成 Integration defect。

### 7.6 测试与交互验证

Test engineer 从 Product Baseline、Spec、Work Package 和 Review findings 生成 Test case。每个 Test run 要记录构建版本、临时 Company Directory、Runtime fixture、UI 操作、Runtime payload、截图、日志、时间和结论。所有用户可见交互都必须在真实 Electron renderer + preload + Company Runtime 中执行；缺少必要前置条件时只能报告 BLOCKED，不能用按钮存在代替 PASS。

### 7.7 安全与可运维

Security review 检查权限、密钥、数据边界、Provider / Sandbox 能力、依赖和供应链。Operability review 检查日志、监控、恢复、超时、资源、部署、回滚和跨应用运行契约。两者绑定 immutable Delivery Candidate Input；全部 PASS 后才物化最终 Candidate，高风险 Work Package 强制深度结果。

### 7.8 观察与介入

Run 页面必须按角色、Agent Session、Work Package 和 Node Run 展示实时活动。用户可以只读观察或发起旁路咨询；需要改变目标、约束、权限或任务时，必须暂停并创建 Governed intervention。Renderer 不能直接写 Run 状态或覆盖 Snapshot。

### 7.9 失败与恢复

失败不得跳过节点、重复有效副作用或自动修改目标。页面展示失败类别、责任角色、Run Record、有效 Artifact、Worktree、Session、revision、下一步建议和可恢复性。重试同一 Node Run 产生新 Node Attempt；需求或约束变化产生新的 Snapshot Revision；冲突和测试失败回到对应 Work Package。

### 7.10 统计与改进

每个阶段保存结果 Artifact、过程 Artifact 和 Session / Runtime log。统计 Coordinator 识别重复失败、返工次数、等待时间、Token、成本、讨论轮次、人工介入和质量门通过率，生成带根因、建议改动、验证计划和回滚路径的 Improvement proposal。未经人工批准不得更新 Harness 或 Skill Flow。

## 8. 信息架构

一级导航：

| ID            | 中文     | English          | 职责                                                                     |
| ------------- | -------- | ---------------- | ------------------------------------------------------------------------ |
| `overview`    | 公司总览 | Company Overview | 运行状态、阻塞、质量门、成本和近期产物                                   |
| `projects`    | 项目     | Projects         | Product Baseline、Spec、仓库、Runs、Work Packages 和 Delivery candidates |
| `departments` | 部门     | Departments      | 部门、职位、员工、Harness、Skill Flow 和 Pipeline                        |
| `artifacts`   | 产物     | Artifacts        | 跨 Project / Department 的 Artifact 和 Lineage 查询                      |
| `settings`    | 设置     | Settings         | Company Directory、本地 Provider、语言、安全和诊断                       |

不设置独立的旧 Board 一级导航。Run、Review topic、Work Package、Test run 和 Delivery candidate 从 Company Overview、Project 或 Department 进入。

## 9. 核心用户流程

### 9.1 首次启动

```text
启动应用
→ 选择或创建 Company Directory
→ 初始化公司数据
→ 安装内置 Software R&D Department 模板
→ 检测 Company Agent Adapter 和本地能力
→ 进入 Company Overview
```

首次启动不得自动调用模型或消耗 Token。

### 9.2 创建 Project 与需求澄清

```text
创建 Project
→ 关联一个或多个 Repository / Application
→ 输入目标、背景、用户和约束
→ 进入 Product manager Interaction Workspace
→ 需求澄清、提问、补充证据
→ Product manager 生成 Product proposal 和质量报告
→ 用户确认或退回修改
→ 原子生成 Product Baseline + Department Run / Snapshot r1
```

Product Baseline 未确认前，不得创建正式 Work Package、修改代码或启动开发 Agent。

### 9.3 产品评审与方案优化

```text
Product Baseline + formal Department Run / Snapshot r1
→ Start formal Pipeline
→ Project Spec draft
→ 独立 Product Review sessions
→ 有界 Review topic 讨论冲突
→ Product manager 修订 Project Spec
→ 独立复核
→ PASS / CONDITIONAL_PASS / FAIL
→ PASS：gate promotion 固定 accepted Project Spec
```

`CONDITIONAL_PASS` 只进入修订/验证 obligation；只有 `PASS` promotion 后才能进入 readiness。涉及 Product Baseline 边界的范围变化必须暂停、重新确认并 Fork 新 Run。

### 9.4 技术方案、就绪检查与技术评审

```text
Promoted Project Spec
→ Repository readiness checks
→ 跨应用契约预检
→ PASS：gate promotion 固定 readiness evidence
→ Software architect 技术设计 + Application Spec drafts / Technical Baseline Proposal
→ 独立技术 Review sessions
→ 有界 Review topic
→ 修订与独立复核
→ PASS：物化 accepted Technical Baseline，gate promotion 固定 Application Specs / Baseline
```

### 9.5 Work Package 拆分与并行执行

```text
技术基线
→ Coordinator 根据依赖拆分 Work Package
→ 冻结目标、验收、范围、权限和集成条件
→ 为每个包分派 Developer AI Member
→ 创建独立 branch / Worktree / Sandbox / Session
→ 并行或按依赖顺序执行
→ Developer self-check
```

### 9.6 独立 CR 与集成

```text
Work Package 完成
→ 独立 Code Review
→ PASS：进入 Integration branch
→ FAIL：生成 Defect，责任开发者新 Attempt 修复
→ 创建 immutable Integration Generation
→ 每个 Repository 在 generation-scoped Integration branch 按依赖顺序集成
→ 冲突 / 契约失败：生成 Integration defect
→ 任一仓库失败：generation 失败；修复后从固定 base 创建新 generation
→ 聚合 CR 与集成测试
```

### 9.7 测试、交互、安全与可运维

```text
Integration branch
→ Test case 设计
→ 单元 / 静态 / Runtime 契约测试
→ 真实 Electron 交互 Test run
→ 冻结 Delivery Candidate Input
→ Security review
→ Operability review
→ 缺陷返工和受影响回归
```

### 9.8 Delivery candidate 与人工发布

```text
Integration/Test evidence 完整
→ 冻结 Delivery Candidate Input
→ 最终质量门全部 PASS
→ 组装不可变 Delivery candidate
→ 人工检查完整证据
→ Accept：完成 Run，仅授权独立 merge/export operation
→ Reject：终结该 Run 的发布路径
→ Request changes：同 Run rework，边界变化时创建 child Fork Run
```

### 9.9 咨询与受控介入

用户可以从 AI Member、Project、Review topic、Work Package 或 Run Current Node 打开 Agent Interaction Workspace。Consultation 和观察不改变正式执行；实质性修改必须暂停当前执行、记录反馈并创建新的 Snapshot Revision 或 Node Attempt。

## 10. 功能需求

### 10.1 Company Overview

必须展示：

- Active、Waiting、Blocked、Failed、Reviewing、Testing、Ready for Delivery 和 Completed Runs；
- 各 Project 的当前生产阶段、阻塞、质量门和 Delivery candidate；
- 各 Department / Position / AI Member 当前活动和最近证据；
- 待处理的人审、Governed intervention、Security / Operability 风险和失败恢复；
- 最近 Artifact、Work Package、Review topic、Test run 和 Defect；
- Token、时间、成本、返工次数、Review 轮次和测试通过率。

### 10.2 Projects

- 创建、编辑、归档 Project。
- 关联、移除和检查多个 Repository / Application。
- 保存 Product Baseline、Project Spec、跨应用契约、Project Memory 和 Improvement proposal。
- 展示 Department Runs、Work Packages、Review topics、Artifacts、Defects 和 Delivery candidates。
- Confirmation 与 explicit Fork 都通过同一 formalization boundary 原子生成 Run/r1；复用既有 Baseline 的 Fork 可 exact replay chosen Snapshot，或显式 reconfigure Repository/Pipeline/execution 输入并使受影响的旧 Gate promotion 失效。Baseline 变化则由新的 Proposal confirmation 带 fork source 同时创建新 Baseline 与 child Run。不存在可由 Start 补齐的无 Snapshot Run。
- 一个 Project 不被固定成 PRD / Design / R&D / Review 的页面阶段。

### 10.3 Product manager Workspace

- 用户可以直接与 Product manager 对话。
- 消息、问题、约束、用户故事、验收标准和引用 Artifact 都进入可审查的 Product proposal。
- Product manager 输出 Product proposal、开放问题、风险和质量报告。
- 用户只有显式确认后才能形成 Product Baseline。
- Consultation 不能直接产生代码、正式 Artifact 或 Work Package。

### 10.4 Delivery coordinator 与 Pipeline

- Coordinator 在 Product Baseline 确认后被激活。
- Coordinator 推进声明式 Pipeline，不能直接绕过 Company Runtime 写状态。
- Pipeline 顶层节点类型保持 Start、AI Task、Human Approval、Condition、Parallel、Join 和 Complete 的闭集；Product Discovery/确认属于 pre-run handlers，Review、Spec、Readiness、Development、Integration、Test、Security、Operability 和 Candidate 由版本化 Node Handler Kind 实现，不允许任意代码节点。
- Pipeline 草稿与发布版本分离；运行中的 Snapshot 不受后续编辑影响。
- 节点必须声明负责人、Harness、Skill Flow、输入 Contract、输出 Artifact、权限、预算、超时和失败处理。
- 每个中间质量门结论为 PASS、CONDITIONAL_PASS 或 FAIL，并绑定 exact input manifest；只有 PASS 满足下游 Artifact Contract 或创建 Snapshot gate promotion。

### 10.5 Review topics

- 产品和技术评审必须支持独立 findings、主持人、参与者、引用 Artifact、预算、最大轮次、超时和停止条件。
- 讨论只能围绕明确冲突和验收标准进行，不能无限自由聊天。
- 方案负责人可以修订方案，但不能批准自己的 Review topic。
- 每个 finding 记录证据、严重度、责任人、状态和复核结果。
- Review topic 结论自动写入 Run Record 和 Artifact lineage。

### 10.6 Work Packages

- Technical Baseline 通过 Technical Review PASS 并完成 gate promotion 后，Coordinator 自动拆分 Work Package。
- 每个 Work Package Version 必须恰属一个 Application/Repository，并有 ID、目标、验收、依赖、module scope、权限、Harness / Spec 引用、assignment/`branch`/isolation requirements 和预期 Artifact；每个 Attempt 分配唯一 AI Member/Workspace Allocation，正式 Work Package 不允许 `head` / `merge-to-head`。
- 无依赖包可并行；有依赖包必须等待前置 Artifact / commit / contract。
- Work Package 的范围、验收、权限或仓库变化必须创建新版本。
- 不允许多个 Agent 共享一个可写 Worktree。
- 只有普通 mutable cache 等非安全冲突可按 frozen capability policy 串行；writable shared Git refs 绝不能靠串行化放行。若不能隔离 Git refs、Agent Session、Reviewer hidden context、credential 或 filesystem scope，必须阻塞并要求更换 Provider。
- Work Package 完成前必须执行 Developer self-check；通过后才能排入独立 CR。

### 10.7 Runs、观察和介入

- Run 页面同时提供 Graph、Timeline、Agent Activity、Review、Artifacts、Defects、Tests 和 Evidence 视图。
- 每个 Agent Activity 必须显示 AI Member、Position、Agent Adapter、Model、Session、Run、Snapshot、Node Run、Attempt、Work Package、Worktree、状态、开始时间、Token、成本和下一步。
- 实时活动至少包括 Message、Structured decision rationale、Step、Tool Call、Tool Result、Permission Request、Artifact / Diff update、Usage、Commit、Error 和状态转换。
- 原始 Transcript 默认折叠，但不能删除；结构化活动优先展示。
- 用户可以实时观察、暂停、取消和发起旁路咨询。
- 需要改变目标、约束、权限或任务时，必须使用 Governed intervention；Renderer 不能直接编辑 Runtime 状态。
- 断线或 Renderer 重载后，必须通过 Runtime Event cursor 和 Run Record 恢复，不得要求用户手动 reload 才能得到正确状态。

### 10.8 Code Review 与 Integration

- Reviewer 使用新 Session、独立 Worktree / workspace 和限定输入（Diff、Spec、Harness、测试、知识）。
- Reviewer 不能访问实现 Agent 的隐藏上下文，也不能直接替开发者修改分支。
- Review findings 必须产生 PASS、CONDITIONAL_PASS 或 FAIL，并关联证据。
- 只有通过独立 CR 的 Work Package 才能进入 Integration branch。
- Integration Generation 冻结全部 Repository base/source commits、依赖和跨应用契约；每个 Integration operation 记录 generation、输入分支、commit、expected Integration-branch tip、冲突、合并结果和测试结果，且不能写 Release target branch。
- 冲突、构建失败或跨应用契约失败形成 Integration defect，返回责任 Work Package。
- 多仓部分成功不能组装 Candidate；修复后创建新 generation，不继续写 failed generation 的混合结果。
- 聚合 CR 必须在所有包集成后重新执行。
- Human release accepted 后的 Release operation 是 `merge | export` 判别契约：merge 固定 per-repository source commit、Release target branch/expected tip；export 固定 Artifact Versions、destination state 和 overwrite policy。部分失败保存并 reconcile，destination 漂移必须重新确认，Integration Adapter 不能代替它。

### 10.9 Test、Security 与 Operability

- Test engineer 根据 Product Baseline、Specs、Work Packages 和 Review findings 生成版本化 Test case。
- Test run 必须记录 build、Company Directory、Runtime fixture、Provider / Model、UI actions、Runtime payload、截图、日志、时间和结果。
- 所有用户可见交互必须在真实 Electron renderer + preload + Company Runtime 中验证。
- authoritative Electron E2E 只替换 `ScriptedExecutionAdapter` / `ScriptedInteractionExecutionAdapter`，保留真实 Company Runtime、SQLite、Pipeline、Interaction、Audit、Outbox、Electron main 和 preload；`ScriptedRuntimeTransport` 只用于 client/protocol contract test。
- 交互断言必须同时检查 UI 和权威 Runtime，不能以文案或颜色单独判定通过。
- Test defect 进入责任 Work Package 的 rework loop，并自动重跑受影响测试和相关回归。
- 每个 Delivery Candidate Input 必须有绑定 exact hash 的 Security review 和 Operability review；高风险 Work Package 需要深度审查，只有 PASS 结果进入最终 Candidate。

### 10.10 Artifacts、Lineage 与 Memory

- Artifact 必须记录类型、版本、Project、Department Run、Node Run、Work Package、Producer AI Member、输入版本和 inspectable location。
- Review finding、Test run、Security / Operability report、Diff、commit、provider-versioned build/PR 和 Delivery candidate 都可以成为正式 Artifact；branch/preview URL 只有解析到 immutable object/version/digest 后才可作 Gate evidence。
- Artifact 版本不可静默覆盖；后续变化创建新版本。
- Run Record 是审计证据，不自动变成 Project Memory 或 AI Member Memory。
- Memory 晋升使用 `Draft → Review → Accepted / Rejected`。

### 10.11 AG-UI、ACP 与协议边界

- Company Runtime 是唯一状态权威；内部 Runtime Events 是 AG-UI 和 ACP 的共同来源。
- AG-UI 必须覆盖 Run / Step 生命周期、文本增量、Tool Call、Tool Result、Usage、Commit、Error、Permission、Artifact、Review、Test、Snapshot 和 Custom Evidence 事件。
- ACP Facade 使用 JSON-RPC 2.0：Client→Agent `initialize` / `session/new` / v1 `session/load` / `session/prompt` / `session/cancel`；Agent→Client `session/update` notification 和 `session/request_permission` request，并绑定同一 AI Member、Project、Run、Node、Snapshot、Interaction Turn 和权限策略。
- Renderer/ACP resync 先使旧 subscription generation 和在途 callback 失效，再读取 `{ view, asOfSequence, viewSyncToken }`、应用 View、sync Ack 并打开新 generation；每个 frame 携带 generation，旧 frame 不得回写新 View。Ack 只更新 Cursor/Audit。
- 外部 Client 不能绕过 Pipeline、Worktree、Sandbox、Approval、Artifact、Memory 或 Security 规则。
- Interaction 数据模型保留 Participant、Topic、Thread 和多 Session 扩展位；Review topic 使用这些能力，不把一个 Client 永久等同于一个 AI Member。

### 10.12 本地优先、安全与双语

- 无账号即可使用；Company Directory 可选择、备份和迁移。
- 不公开监听本地服务；ACP 仅使用 stdio 或受控本地 IPC。
- Provider credentials、完整环境变量、敏感 Memory 和原始 secret 不进入 Snapshot、Artifact、Event 或日志。
- 权限按 Position、Work Package、Sandbox、Repository 和操作类型最小化。
- 支持 `zh-CN` / `en` 即时切换；稳定 ID 不依赖显示文案。

### 10.13 统计与 Improvement proposal

- 记录阶段耗时、Token、成本、失败、返工、Review 轮次、Test 通过率、人工介入、等待时间和质量门结果。
- Coordinator 可按 Project、Department、AI Member、Model、Repository、Work Package 和 Pipeline 生成统计。
- Improvement proposal 必须包含数据证据、根因、建议修改、影响范围、验证计划和回滚路径。
- 只有人工批准的 proposal 才能更新 Harness、Spec、模板或 Skill Flow。
- 后续 Runs 必须保留改进前后可比较的指标。

## 11. 内置 Software R&D Department 模板

### 11.1 初始职位

| Position             | 中文         | 默认职责                                                                  |
| -------------------- | ------------ | ------------------------------------------------------------------------- |
| Product manager      | 产品经理     | 需求澄清、Product proposal、Product Baseline 准备和 Project Spec 修订     |
| Delivery coordinator | 交付协调者   | 运行编排、评审组织、任务拆分、依赖、异常升级和 Delivery candidate 组装    |
| Product reviewer     | 产品评审     | 独立检查用户价值、范围、验收、风险和可验证性                              |
| Software architect   | 软件架构师   | Application Spec、Technical Baseline Proposal、架构、契约、迁移和部署约束 |
| Developer            | 开发者       | 在独立 Worktree / Sandbox 实现一个或多个 Work Package                     |
| Code reviewer        | 代码审查员   | 在独立 Session 检查 Diff、Spec、Harness、安全和质量                       |
| Test engineer        | 测试工程师   | Test case、Runtime 契约、Electron 交互和回归测试                          |
| Security reviewer    | 安全审查员   | 权限、密钥、数据、依赖、供应链和合规风险                                  |
| Operability reviewer | 可运维审查员 | 日志、监控、恢复、部署、回滚、资源和超时                                  |

### 11.2 默认流水线

```text
Product Discovery (pre-run, Product manager ↔ User)
→ Requirement Confirmation (Human)
→ Product Baseline + formal Department Run / Snapshot r1
→ Start (formal Pipeline)
→ Project Spec Draft
→ Product Review Topic + PASS Gate Promotion
→ Repository Readiness + Cross-Application Contract Check + PASS Gate Promotion
→ Technical Design + Application Spec Drafts / Technical Baseline Proposal (Software architect)
→ Technical Review Topic + PASS Gate Promotion
→ Work Package Fan-out
→ Parallel Development (isolated Worktrees)
→ Developer Self-check
→ Independent Code Review
→ Integration Branch + Aggregate Review
→ Runtime / Contract / Build Tests
→ Electron Interaction Test Run
→ Delivery Candidate Input
→ Security Review
→ Operability Review
→ Delivery Candidate
→ Human Release Decision
→ Complete
```

### 11.3 角色权限边界

- Product manager 不能在 Product Baseline 前创建正式开发 Work Package。
- Delivery coordinator 能编排和分派，但不能批准自己实现的代码或绕过 Runtime。
- Software architect 能写 Application Spec draft / Technical Baseline Proposal revision，但不能物化 accepted Baseline、写 Developer Worktree、批准 Code Review、推进 Integration branch 或做 Human release decision。
- Developer 只能写自己的 Worktree，不能修改目标分支、其他 Worktree 或 Review 结论。
- Reviewer、Test engineer、Security reviewer 和 Operability reviewer 使用独立 Session，不能把实现 Agent 的自述当作唯一证据。
- 多个 Agent 不能互相授予权限、批准 Run、修改 Snapshot 或直接登记正式 Artifact。
- 只有人可以做 Human release decision。

## 12. 状态模型

### 12.1 Product discovery

```text
draft → clarifying → awaiting-confirmation → confirmed
                         ↘ rejected / needs-rework
```

### 12.2 Review topic

```text
scheduled → independent-review → discussion → revision → re-review
                                              ↘ PASS / CONDITIONAL_PASS / FAIL
```

### 12.3 Work Package

```text
draft → ready → assigned → running → self-check
                              ↘ blocked / failed
self-check → cr-pending → cr-approved → integrating → integrated
                          ↘ rework
integrating → integration-defect → rework
```

### 12.4 Department Run

```text
ready (created atomically with r1)
→ running
↔ paused
→ waiting-approval
→ running
→ candidate-ready
→ waiting-human-release
   ├ accepted → completed
   ├ rejected → release-rejected
   └ changes-requested → blocked → recovering → running
→ superseded (boundary-changing child Fork)

running / waiting-approval / candidate-ready
→ blocked
→ recovering
→ running

任何不可恢复错误 → failed（终态）
任何未结束状态 → cancelled
```

### 12.5 Delivery candidate

```text
Candidate input: assembling → frozen-for-final-gates
Candidate manifest: created → ready-for-delivery
Decision projection: awaiting-decision → accepted | rejected | changes-requested | superseded
```

Candidate manifest 不保存 accepted/rejected 状态；该投影来自每个 Candidate 最多一个 Human release decision。只有未 accepted 的旧 candidate 可被后续版本投影为 superseded；`accepted` 是终态，只允许后续受授权的 merge、export 或 deployment action，不等于已经部署生产环境。

### 12.6 Pipeline、Snapshot 与 Artifact

```text
Pipeline Draft → published → archived
Artifact draft → produced → accepted | rejected | superseded
Snapshot revision：immutable
```

已 formalize 的 Run 永远引用其 Snapshot；发布新 Pipeline、Harness、Spec 或 Skill Flow 不会改变现有 Revision。只有 `PASS` Quality Gate Result 能通过 gate promotion 为后续 Node Attempt 创建新 Snapshot Revision。

## 13. 产品指标

v1.0 首要验证产品是否“可控地完成交付”，而不是追求访问量。

- Product Baseline 首次确认所需轮次和时间。
- 产品 / 技术 Review 的独立 finding 数、冲突数、讨论轮次和复核通过率。
- Repository readiness 阻塞率和跨应用契约失败率。
- Work Package 并行度、完成率、返工率、集成冲突率和平均周期。
- Independent CR 发现缺陷率、重复缺陷率和 rework 次数。
- Test run 通过率、真实 Electron 交互覆盖率、Runtime / UI 不一致率。
- Security / Operability 高风险发现关闭率。
- Run 完成率、失败恢复成功率、人工介入次数和审批等待时间。
- 每个 Delivery candidate 的 Token、时间、成本、质量门状态和发布接受率。
- Artifact 被后续 Run 复用的比例。
- Improvement proposal 采用率，以及采用前后的质量、成本和周期变化。

## 14. v1.0 验收标准

1. 用户可在无账号、无云服务情况下创建 Company Directory。
2. 用户可创建 Project 并关联多个 Repository / Application。
3. 用户能直接与 Product manager 交互，并看到 Product proposal、开放问题、风险和质量报告。
4. 未经用户确认 Product Baseline，系统不会创建 Department Run、Snapshot、正式 Work Package 或修改代码；确认 Command 原子创建 formal Run + `r1`，Start 只调度 Node Run。
5. Project Spec draft 先于 Product Review；Review topic 支持独立审查、有界讨论、修订和独立复核，只有 PASS 能 promotion accepted Project Spec。
6. Project Spec 和 per-application Spec 都有版本、输入、契约和 lineage；Technical Review 绑定 exact Technical Baseline Proposal hash，PASS 后才物化 accepted Baseline 并 promotion。
7. Repository readiness 和跨应用契约预检在技术设计和开发前可检查、可阻塞并有证据。
8. Technical Review topic 支持架构、安全、可运维、测试和跨应用影响的独立复核。
9. Coordinator 只能从 promoted Technical Baseline 自动拆分 Work Package，声明依赖、验收、权限和集成条件。
10. 无依赖 Work Package 的 Attempts 能在独立 Workspace Allocations（branch / Worktree / Sandbox / Interaction Session）中并行执行；新 Attempt 不复用旧 Attempt 的可写 allocation，正式 Work Package 不使用 `head` / `merge-to-head`。
11. 任意 Agent 都不能共享其他开发者的可写 Worktree、Session/hidden context 或静默改写目标分支；无法隔离时必须阻塞。
12. Developer self-check 通过后，独立 Reviewer 能在新 Session 中检查 Diff 并形成 PASS / CONDITIONAL_PASS / FAIL。
13. Code Review FAIL 能生成 Defect，触发责任 Work Package 新 Attempt，并保留原证据。
14. 只有绑定 exact commit/diff 的独立 CR `PASS` 才能进入 Integration branch；`CONDITIONAL_PASS` 不满足。
15. Integration Generation 能冻结多仓输入；合并冲突、构建失败、跨应用契约失败或部分成功会失败并生成 Integration defect，修复后以新 generation 重建。
16. 每个 Agent 的身份、输入、Session、Run、Snapshot、Node Run、Worktree、Tool Call、权限、Artifact、Diff、状态、Token、成本和决策理由都可观察。
17. UI 可实时显示 Agent 活动，Runtime Event 和 Run Record 是权威证据；重载/断线后通过 old-generation barrier + Query/View sync Ack + generation-tagged 无过滤 replay 恢复，Ack 不产生递归事件。
18. 用户可以观察、暂停、取消和旁路咨询活动 Agent；实质性修改必须通过 Governed intervention 形成新 revision / attempt。
19. Test case 和 Test run 同时验证公共 UI 与权威 Runtime，不以按钮或颜色单独判定通过。
20. 用户可见交互变更必须在真实 Electron renderer + preload + Company Runtime 中测试。
21. 交互 E2E 使用临时 Company Directory、两个 Scripted Execution Adapters 和真实 Electron/Company Runtime，不把 `ScriptedRuntimeTransport` 当成验收证据，也不调用本机真实 Agent。
22. Test run 能保存 UI actions、Runtime payload、截图、日志、环境、revision 和状态转换。
23. Runtime 先冻结 Delivery Candidate Input；Security/Operability Gate 至少生成绑定该 exact hash 的轻量结果，高风险 Work Package 执行深度检查。
24. 全部 required Gate 具有 `PASS` Quality Gate Result 后才从该 Input 生成不可变 Delivery candidate；任何 `CONDITIONAL_PASS` obligation 必须先完成并 fresh re-review。
25. Delivery candidate 必须等待 Human release decision；accepted/rejected/changes-requested 对 Run 的转换可恢复且有审计，Agent PASS 不自动更新 Release target branch 或发布生产环境。
26. Product、Technical、Code、Test、Security 和 Operability findings 都能进入 Defect / Rework Loop。
27. Run Record、成本、耗时、返工、讨论和干预能生成 Improvement proposal。
28. Improvement proposal 必须经过人工批准和显式 apply operation 才可创建新的 Harness、Spec、模板或 Skill Flow revision；不修改当前 Run，rollback 也创建新 revision。
29. Project Memory、AI Member Memory、Run Record 和正式 Artifact 之间的晋升边界清晰且可审计。
30. Desktop 和 ACP 使用同一 Company Runtime、Permission、Snapshot、Artifact、Memory 和 Runtime Event 边界。
31. 产品支持 `zh-CN` 与 `en` 即时切换，稳定状态不使用显示文案作为持久值。

## 15. 实现演进原则

- Company Runtime 是 Company SQLite 的唯一写者，也是 Pipeline、Run、Snapshot、Approval、Permission、Artifact、Review、Test 和 Improvement 状态的唯一权威。
- 保留既有 Agent、Sandbox、Worktree、branch strategy、Runtime Event、AG-UI 和 ACP 能力，通过节点处理器接入内置 Software R&D Department。
- 新增深模块优先放在 Company Runtime / Pipeline Engine / Review / Work Package / Quality Gate 边界后面，不让 Renderer 直接编排 Agent。
- 所有 Provider、Company Agent Adapter、Sandbox Provider、测试 Fixture 和 Execution Profile 必须可替换；Runtime 行为使用 `ScriptedExecutionAdapter` / `ScriptedInteractionExecutionAdapter` 验证，client/protocol contract 才使用 `ScriptedRuntimeTransport`。
- v1.0 作为新的产品数据模型启动，不导入旧 Desktop Project 或 Board 数据；旧数据保持原样，不覆盖、不删除。
- 不创建第二套 Project、Run、Task、Review 或 Artifact 状态来源。

## 16. 后续文档与实施切片

本 PRD 确认后，技术设计需要按以下顺序更新：

1. Company Runtime 数据模型：Product Baseline、Project / Application Spec、Technical Baseline Proposal、Work Package、Review、Test、Defect、Delivery Candidate Input/Candidate、Improvement proposal。
2. Pipeline Engine 节点、状态机、Snapshot、Revision、Attempt、Lease 和质量门契约。
3. Review Topic / Participant / Thread / independent finding / bounded discussion 协议。
4. Work Package Fan-out、独立 Worktree/Session、Integration Generation/branch 和冲突恢复。
5. Test Case / Test Run、两个 Scripted Execution Adapters、真实 Electron Fixture、Runtime payload 和截图证据。
6. Security / Operability risk tier 和最小权限策略。
7. Delivery Candidate Input/Candidate、Human release decision、idempotent release operation 和未来 Deployment Adapter 边界。
8. Runtime Event、AG-UI Custom Event、ACP Session 和断线恢复契约。
9. Run Record 统计、Improvement proposal、Harness 版本与验证闭环。
10. 分阶段实施计划、Changesets、回归测试和迁移策略。
