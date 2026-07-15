# Sandcastle v1.0 AI 软件公司 PRD

## 文档状态

- 状态：产品方案与交互方向已确认，技术方案 Draft 1 已完成
- 版本：v1.0 Draft 1
- 语言：本文以中文为主；产品必须完整支持简体中文和英文
- 技术方案：见 `plans/v1-ai-software-company-technical-design.md`

## 1. 产品定义

Sandcastle v1.0 是一个本地优先的 **AI 软件公司**。

用户在公司中创建 Project，建立或使用部门，为部门配置长期存在的 AI 员工、职位、Skills 和可视化流水线，然后显式启动一次部门运行。部门流水线在人工审批点之间自主执行，生成一个或多个可检查、可追踪、可复用的 Artifact。

Sandcastle 不是 Markdown 文档管理器，也不是把现有 Board 套上“公司”导航。现有 Board 所代表的能力应成为内置的“软件开发部门”模板。

### 一句话价值

让用户像经营一家软件公司一样，组织长期 AI 员工，通过可控、可恢复、可审计的部门流水线完成真实的软件交付。

## 2. 当前问题

当前 Desktop 产品形态与 v1.0 目标存在以下偏差：

1. Project 被写死为 `PRD → Design → R&D → Review → Artifacts`，所有业务都被迫使用同一阶段模型。
2. PRD 和 Design 编辑器成为主体验，AI 员工、部门流水线和运行控制反而处于次要位置。
3. Department 主要是导航包装，用户不能真正创建和编辑部门流水线。
4. Planner、Generator、Evaluator 更接近临时执行角色，而不是拥有身份、能力、记忆和历史的长期 AI 员工。
5. Board、Desktop 和 Project 状态存在形成多套事实来源的风险。
6. Artifact 主要以文件路径展示，缺少类型、版本、来源和上下游关系。

## 3. 产品目标

### 3.1 v1.0 目标

- 提供一个可信、可运行的本地 AI 软件公司首页。
- 内置一个完整的软件开发部门模板。
- 允许用户创建、复制和编辑部门。
- 每个部门拥有一条可视化、版本化的部门流水线。
- 每个部门可以设置多个职位；v1 中一个职位对应一个长期 AI 员工。
- 每个职位拥有多个 Skills，流水线节点按需激活 Skill Flow。
- 用户在 Project 中显式选择部门、目标和输入 Artifact 后启动运行。
- 流水线支持串行、并行、条件分支和人工审批。
- 运行在审批点之间自主执行，并支持暂停、取消、失败恢复和审计。
- Artifact 支持多种类型、不可变版本和完整来源链路。
- AI 员工拥有受控的长期记忆，并可直接接受用户咨询。
- 提供 Agent Interaction Workspace，支持咨询和 Department Run 节点协作。
- Desktop 使用 AG-UI 呈现实时消息、Tool Call、步骤、权限、用量和 Artifact 更新。
- 提供本地 ACP Facade，让编辑器和其他 ACP Client 调用同一批长期 AI 员工。
- Agent Interaction 的 Session、消息和协议模型为后续多 AI 员工 Discussion Topic 保留扩展能力。
- 产品完整支持简体中文和英文即时切换。
- 默认本地优先，无需账号和云服务即可工作。

### 3.2 非目标

- v1 不提供公司级 CEO Agent 自动选择和启动部门。
- v1 不提供多人协作、账号体系、云同步或企业权限管理。
- v1 不提供薪资、组织汇报线、日历、考勤或人力资源系统。
- v1 不提供任意代码流水线节点或通用低代码平台。
- v1 不要求内置多个功能不完整的占位部门。
- v1 不允许咨询对话绕过流水线生成正式交付物。
- v1 不允许 Agent 静默重写流水线、目标、输入或审批结果。
- v1 不自动把原始对话和运行日志写入长期记忆。
- v1 不把 AG-UI 或 ACP 作为内部编排核心；内部事实来源仍是 RuntimeEvent。
- v1 不通过公网暴露 ACP，协议入口只允许 stdio 或受控的本地 IPC。
- v1 不实现多 Agent 自主群聊、自动辩论或无限持续的公司频道；这些属于后续 Discussion Topic 能力。

## 4. 目标用户

### 4.1 个人开发者与独立产品开发者

希望把需求、开发、验证和交付委托给多个 AI 员工，同时保留审批权和完整证据。

### 4.2 小型软件团队负责人

希望通过本地可控的流水线组织 AI 工作，复用团队 Skills、规范和交付流程。

### 4.3 Agent 工作流设计者

希望创建部门、职位和流水线模板，观察不同 Agent Provider、模型和 Skills 组合的效果。

## 5. 产品原则

1. **公司优先**：首页呈现公司运行状态，而不是 Project 表单或旧 Board。
2. **部门拥有流程**：阶段属于部门流水线，不属于 Project。
3. **员工长期存在**：AI 员工身份、职位、Skills、记忆和历史跨运行保持。
4. **执行配置可替换**：员工身份不绑定 Claude、Codex、Pi 或某个模型。
5. **运行必须可解释**：用户始终知道谁在做、使用什么输入、等待什么、产生什么。
6. **审批点之间自治**：减少逐步确认，同时不牺牲控制权。
7. **产物是正式交付对象**：所有正式结果都有类型、版本和来源。
8. **快照保证一致性**：运行中的配置不会被后台编辑静默改变。
9. **记忆必须受控**：跨 Project 学习需要总结和审核。
10. **本地优先**：默认不登录、不上传公司数据、不依赖远程控制面。

## 6. 核心领域模型

```text
Company
├─ Projects
│  ├─ Department Runs
│  │  ├─ Run Configuration Snapshot
│  │  ├─ Pipeline Node Runs
│  │  ├─ Approvals
│  │  ├─ Run Records
│  │  └─ Artifacts
│  └─ Project Memory
├─ Departments
│  ├─ Positions
│  │  └─ AI Member (1:1 in v1)
│  │     ├─ Skill Catalog
│  │     ├─ AI Member Memory
│  │     ├─ Work History
│  │     └─ Agent Interaction Sessions
│  └─ Department Pipeline
│     ├─ Versions
│     └─ Nodes and Edges
└─ Provider and Local Settings
```

### 6.1 Company

本地产品边界，拥有 Projects、Departments、Artifacts 和公司级配置。v1 一次打开一个 Company Directory。

### 6.2 Project

长期业务目标和共享上下文容器。Project 不拥有固定阶段，一个 Project 可发起多次、跨部门的 Department Run。

### 6.3 Department

一种工作的执行单元，拥有一条部门流水线、多个职位、输入契约和 Artifact 契约。用户可以创建、复制、编辑和归档部门。

### 6.4 Position 与 AI Member

Position 是部门流水线中的长期岗位。v1 中一个 Position 对应一个 AI Member。AI Member 是长期数字员工，拥有稳定身份、完整 Skills 清单、受控记忆和工作历史。

### 6.5 Department Pipeline

显式、可视化、可编辑、可恢复的 DAG。v1 支持：

- Start
- AI Task
- Human Approval
- Condition
- Parallel / Join
- Complete

### 6.6 Department Run

用户为某个 Project 显式启动的一次部门流水线执行。启动前必须展示目标、输入 Artifact、参与职位、预计产物和执行配置摘要。

### 6.7 Artifact

类型化、版本化的正式交付物，可表示文档、图片、设计稿、结构化数据、代码提交、分支、PR、构建包、预览地址和验证报告。

### 6.8 Agent Interaction Workspace

用户与长期 AI 员工实时交互的上下文工作区，包含两种模式：

- Consultation：非正式咨询，不直接改变 Run 或产生正式 Artifact。
- Run Collaboration：绑定某个 Department Run 和 Pipeline Node，可补充反馈、处理权限请求、观察 Agent 活动并在既有审批规则内推动当前节点。

Desktop 通过 AG-UI 消费 RuntimeEvent；外部编辑器或 Agent Client 通过本地 ACP Facade 建立 Session。两种入口必须共享 AI Member 身份、Run Snapshot、Permission、Artifact 和 Memory 边界。

### 6.9 Discussion Topic（后续扩展）

类似 Discord 话题频道的多参与者讨论空间。一个 Topic 必须绑定 Project、Department Run 或 Pipeline Node，并声明讨论目标、参与 AI Members、主持人、引用 Artifact、Token/时间预算和停止条件。

Topic 的讨论结论默认只是候选内容，必须经过人工确认或流水线节点处理后，才能成为 Node Feedback、Artifact、Project Memory 或 AI Member Memory。

## 7. 信息架构

一级导航：

| ID            | 中文     | English          | 职责                                  |
| ------------- | -------- | ---------------- | ------------------------------------- |
| `overview`    | 公司总览 | Company Overview | 运行状态、阻塞、成本、部门和近期产物  |
| `projects`    | 项目     | Projects         | Project、运行和项目上下文             |
| `departments` | 部门     | Departments      | 部门、职位、员工和流水线设计          |
| `artifacts`   | 产物     | Artifacts        | 跨 Project/部门的产物查询与关系       |
| `settings`    | 设置     | Settings         | 语言、本地目录、Providers、安全和诊断 |

不设置独立的旧 Board 一级导航。运行详情从公司总览、Project 或 Department 进入。

## 8. 核心用户流程

### 8.1 首次启动

```text
启动应用
→ 选择或创建 Company Directory
→ 选择界面语言
→ 初始化公司数据
→ 安装内置软件开发部门模板
→ 进入公司总览
```

首次启动不得自动调用模型或消耗 Token。

### 8.2 创建 Project 并启动部门运行

```text
创建 Project
→ 输入目标与共享背景
→ 选择 Department
→ 填写本次工作目标
→ 选择输入 Artifact 版本
→ 预览 Pipeline / Positions / Expected Artifacts / Execution Defaults
→ 确认启动
→ 生成 Run Configuration Snapshot
→ 自动运行至审批点、失败或完成
```

### 8.3 人工审批

审批页面必须同时显示：

- 当前节点与负责 AI 员工
- 输入 Artifact 版本
- 本节点生成的 Artifact
- 运行摘要、风险和成本
- 下游节点影响

动作：Approve、Request Changes、Reject、Cancel Run。

### 8.4 失败与恢复

失败后不得自动修改目标或跳过节点。页面展示：

- 失败类别与可读说明
- 相关 Run Record
- 已完成节点和有效 Artifact
- 重试、补充反馈、替换允许的执行配置、从快照恢复或终止

恢复默认从失败节点继续，不重复有效节点。

### 8.5 AI 员工咨询

用户可从员工详情或 Project 中发起咨询。咨询必须显示上下文范围、Provider/模型和成本。咨询结果只有在用户显式执行以下动作后才能进入正式流程：

- 转为新的 Department Run
- 添加为运行节点反馈
- 保存为 Project Memory 草稿
- 提交为 AI Member Memory 候选并审核

### 8.6 Agent 节点协作与外部 ACP Client

```text
从 Run Current Node 或 AI Member 打开 Interaction Workspace
→ 选择 Consultation 或 Run Collaboration
→ 绑定 Project / Department Run / Pipeline Node 上下文
→ 创建或恢复 Agent Session
→ 通过 AG-UI 实时显示消息、Tool Calls、Steps、Usage 和状态
→ 遇到敏感操作时显示 Permission Request
→ 用户允许、拒绝或补充反馈
→ 将正式结果写回当前 Node，或将咨询结果显式转为 Run/Memory 草稿
```

外部 ACP Client 流程：

```text
ACP initialize
→ 获取本地能力、可用 AI Members 和 Provider 能力
→ session/new，绑定 AI Member 与可选 Project/Run/Node
→ session/prompt
→ session/update 持续接收 RuntimeEvent 映射
→ session/request_permission 使用同一权限策略
→ session/cancel 取消当前执行
```

ACP Client 不得绕过 Pipeline Approval、Run Snapshot、Sandbox 或 Artifact 登记规则。

## 9. 功能需求

### 9.1 公司总览

必须展示：

- Active、Waiting Approval、Blocked、Failed、Completed Runs
- 部门卡片及每个部门当前负载
- AI 员工当前状态和最近活动
- 需要用户处理的审批与失败
- 最近 Artifact
- 活跃 Project
- Token、时间和可得的成本数据

主要动作：Create Project、Start Department Run、Open Blocker。

### 9.2 Projects

- 创建、编辑、归档 Project。
- 保存目标、背景、Project Memory 和关联仓库。
- 展示该 Project 的 Department Runs、Artifacts 和时间线。
- 启动新的 Department Run。
- 不展示固定 PRD/Design/R&D 阶段导航。

### 9.3 Departments

- 查看内置和用户创建的部门。
- 创建空白部门。
- 复制现有部门及其流水线。
- 编辑名称、说明、职位、Artifact 契约和默认执行配置。
- 发布新的部门配置版本。
- 查看历史 Runs 和运行质量。

部门详情标签：Overview、Positions、Pipeline、Runs、Settings。

### 9.4 Positions 与 AI Members

- 创建、编辑、停用职位。
- v1 中每个职位配置一个长期 AI Member。
- 配置职责、完整 Skills 清单、默认 Provider/模型和执行限制。
- 身份与 Provider/模型解耦。
- 查看员工工作历史、Artifact、Project 参与情况和已审核记忆。
- 支持咨询，但清楚标记为非正式工作。

### 9.5 Pipeline Editor

- 画布支持缩放、平移、选择、连线和自动布局。
- 左侧提供最小节点库。
- 右侧 Inspector 编辑节点属性。
- 节点显示负责职位、激活 Skill Flow、输入和输出摘要。
- 保存草稿与发布版本分离。
- 发布前验证不可达节点、缺失负责人、无终点、Artifact 类型不匹配和非法循环。
- 正在运行的快照不受新版本影响。

### 9.6 Runs

- 显示运行快照版本和当前节点。
- 支持 Timeline 和 Graph 两种查看方式。
- 支持暂停、恢复、取消和审批。
- 实时显示 AI 员工活动，但原始 Transcript 默认折叠。
- 显示 Artifact、运行证据、Token、时间和成本。
- 并行节点应独立显示状态和失败范围。

### 9.7 Artifacts

- 类型、版本、状态、Project、Department、Run、Node、Producer。
- 支持文件、URL、Git 引用和结构化数据。
- 展示输入/输出 Lineage 图。
- Artifact 版本不可静默覆盖。
- 新运行必须显式选择输入版本。
- 支持打开、预览、定位文件、复制引用和作为新运行输入。

### 9.8 Memory

- AI Member Memory：可跨 Project 使用的已审核经验。
- Project Memory：仅当前 Project 可用。
- Run Record：审计证据，不自动加载为记忆。
- 支持 `Draft → Review → Accepted/Rejected` 的记忆晋升流程。

### 9.9 双语

- 支持 `zh-CN` 与 `en`。
- 首次启动跟随系统语言，失败时默认英文。
- 设置中即时切换并持久保存。
- 系统文案、状态、验证信息和内置模板必须完整翻译。
- 用户内容和外部 Artifact 不自动翻译。
- 状态和数据字段使用稳定 ID，不使用显示文案作为持久值。

### 9.10 本地优先与安全

- 无账号即可使用。
- Company Directory 可选择、备份和迁移。
- 元数据本地保存，Artifact 保存在用户可检查的位置。
- Provider 凭证不得进入运行快照、Artifact、员工记忆或日志。
- 默认不公开监听本地服务。
- 敏感 Project Memory 不得自动跨 Project 使用。

### 9.11 Agent Interaction、AG-UI 与 ACP

#### Agent Interaction Workspace

- 可从 AI Member、Project 和 Run Current Node 打开。
- 顶部必须显示当前模式、AI Member、Project、Run/Node、Provider/模型和成本。
- 会话支持新建、恢复、取消和清晰的连接状态。
- 消息区同时支持用户消息、Agent 消息、Tool Call、Tool Result、Step、Permission Request、Artifact Update 和 Run Status。
- 原始输出默认折叠，结构化活动优先展示。
- Run Collaboration 的输入作为当前节点反馈记录；Consultation 输入不直接改变正式运行。
- 用户可以将咨询内容显式转换为 Department Run、Node Feedback、Project Memory Draft 或 AI Member Memory Candidate。

#### AG-UI

- Desktop 通过 AG-UI Adapter 消费内部 RuntimeEvent。
- 至少覆盖 Run/Step 生命周期、文本增量、Tool Call、Tool Result、Usage、Commit、Error 和 Raw Evidence。
- Artifact、Approval、Permission 和 Snapshot 等 Sandcastle 领域更新使用明确命名的 AG-UI Custom Events，直到协议存在对应标准事件。
- 前端断线重连后必须能恢复可读状态，不能只依赖瞬时文本增量。
- AG-UI Adapter 故障不得中断 Agent 执行。

#### ACP Facade

- v1 提供真正可用的本地 ACP 入口，而不是只保留接口草图。
- 支持 initialize、Session 创建、Prompt、Update、Cancel 和 Permission Request。
- Session 可绑定 AI Member，并可选绑定 Project、Department Run 和 Pipeline Node。
- ACP Session 是一次交互/执行会话，不等于长期 AI Member 身份。
- 使用 stdio 或本地 IPC；默认不监听公网端口。
- Desktop 与外部 ACP Client 使用相同的权限、审计、Snapshot、Memory 和 Artifact 规则。
- Provider 凭证、完整环境变量和敏感 Memory 不得通过 ACP 能力响应或事件泄露。

### 9.12 多 Agent Discussion Topic 扩展要求

v1 不交付完整的自主多 Agent 讨论，但必须避免形成无法扩展的一对一交互模型：

- Interaction Session 数据模型允许一个 Topic 关联多个 Participant ID，不把单一 `aiMemberId` 作为唯一参与者字段。
- 每条消息和事件都记录 Producer/Participant，而不是默认来自唯一 Agent。
- AG-UI 映射保留 Participant、Topic 和 Thread 关联信息的 Custom Event 扩展位。
- ACP Facade 不把一个外部 Client 永久等同于一个 AI Member；后续可由 Topic Coordinator 管理多个本地 Agent Session。
- Conversation、Tool Call、Permission 和 Artifact Update 必须能按 Participant 区分。
- Discussion Topic 必须支持主持人、邀请/移除成员、暂停、结束、预算上限、最大轮次和超时。
- 多 Agent 不能互相授予权限、批准 Run、修改 Snapshot 或把结论直接登记为正式 Artifact。
- Topic 结论需要生成可审核 Summary，并由用户选择是否转为 Run、Feedback、Artifact 或 Memory Candidate。
- UI 布局保留 Topic 列表、Thread、Participants 和 Shared Context 的扩展区域，但 v1 可以只启用一对一 Consultation 与 Run Collaboration。

## 10. 内置软件开发部门模板

现有 Board 的 Agent、Sandbox、Worktree、验证等执行能力复用为默认模板的节点处理器，而不是整个产品的固定流程或数据来源。

建议初始职位：

| Position           | 中文     | 默认职责                         |
| ------------------ | -------- | -------------------------------- |
| Product Planner    | 产品规划 | 对齐目标、澄清需求、形成计划输入 |
| Software Architect | 软件架构 | 生成技术方案和仓库级拆分         |
| Software Engineer  | 软件工程 | 按批准方案实现与测试             |
| Reviewer           | 代码审查 | 独立审查实现与风险               |
| Evaluator          | 交付验证 | 根据证据验证验收标准             |

建议默认流水线：

```text
Start
→ Product alignment
→ Technical plan
→ Human approval
→ Parallel repository execution
→ Review
→ Verification
→ Human acceptance
→ Complete
```

现有 Planner、Generator、Evaluator 的行为和提示词可以作为对应职位的实现参考，但新模型不得被旧 Board Role 或旧数据结构限制。

## 11. 状态模型

### 11.1 Department Run

```text
draft
→ ready
→ running
↔ paused
→ waiting-approval
→ running
→ completed

running / waiting-approval
→ failed
→ recovering
→ running

任何未结束状态
→ cancelled
```

### 11.2 Pipeline Version

```text
draft → published → archived
```

已经启动的 Run 永远引用其 Run Configuration Snapshot。发布新版本不会改变现有 Run。

### 11.3 Artifact Version

```text
draft → produced → accepted | rejected | superseded
```

## 12. 产品指标

v1.0 首要验证产品是否“可控地完成交付”，而不是追求页面访问量。

- 从创建 Project 到成功启动 Run 的完成率。
- Run 完成率与失败恢复成功率。
- 人工审批等待时间。
- Artifact 被后续 Run 复用的比例。
- 用户查看原始 Transcript 的比例，作为摘要是否足够的信号。
- 每个完成 Artifact 的 Token、时间和可得成本。
- Pipeline 模板复制、编辑和重复使用次数。

## 13. v1.0 验收标准

1. 用户可在无账号、无云服务情况下初始化公司。
2. 用户可在中文和英文之间即时切换。
3. 首页以公司运行状态为中心，而不是 Project 创建表单或旧 Board。
4. 用户可创建 Project，并从中显式启动一个部门运行。
5. 用户可创建或复制 Department，配置多个 Position 和长期 AI Member。
6. 用户可用可视化编辑器建立并发布合法 Pipeline Version。
7. 启动 Run 时生成不可变 Run Configuration Snapshot。
8. Run 可在审批点之间自主执行，并可暂停、取消、审批和失败恢复。
9. 软件开发部门模板可完成一次从目标到代码与验证 Artifact 的运行。
10. Artifact 具有类型、版本、Producer 和输入 Lineage。
11. AI 员工身份不随 Provider/模型变更而丢失。
12. 咨询不能直接产生正式 Artifact。
13. Project Memory 不会自动泄露到其他 Project。
14. UI 不再把所有 Project 写死为 PRD/Design/R&D/Review/Artifacts 五阶段。
15. 用户可在 Agent Interaction Workspace 中与 AI Member 咨询或协作当前节点。
16. Desktop 能通过 AG-UI 实时展示文本、Tool Call、步骤、权限和运行状态。
17. 外部 ACP Client 能通过本地入口初始化、创建 Session、Prompt、接收更新、请求权限和取消执行。
18. Desktop 与 ACP Client 无法绕过相同的审批、Snapshot、Sandbox 和 Artifact 规则。
19. Agent Interaction 的持久化和事件契约不假设一次交互永远只有一个 AI Member，为 Discussion Topic 保留 Participant/Topic 扩展位。

## 14. 实现演进原则

- 保留现有底层 Agent、Sandbox、Worktree 和运行事件能力。
- 将现有 Board 软件开发能力重组为内置软件开发部门的节点处理器和模板参考。
- 新产品只有一份 Department Run 状态来源。
- v1.0 作为新的产品数据模型启动，不导入旧 Desktop Project 或 Board 数据。
- 旧固定阶段页面和存储不做双写兼容，也不得继续发展为平行产品模型。
- 用户为 v1.0 创建新的 Company Directory；旧数据保持原样，不删除、不覆盖。

## 15. 后续文档

PRD 和视觉设计确认后再编写：

1. v1.0 总体技术方案
2. 数据模型与版本/快照方案
3. Pipeline Engine 状态机方案
4. Software Development Department 内置模板与旧 Board 能力复用方案
5. Artifact 与 Memory 存储方案
6. 分阶段实施计划与 Changesets
7. AG-UI Custom Event 与断线恢复契约
8. ACP Local Transport、Session 与 Permission 映射方案
9. 多 Agent Discussion Topic、主持策略、预算和停止条件方案
