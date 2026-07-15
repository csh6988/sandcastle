# Sandcastle v1.0 产品设计方案

## 1. 设计目标

本设计将 Sandcastle 从“Project 文档阶段管理器”重构为“可观察、可配置、可运行的 AI 软件公司”。

用户打开产品后首先感知到的应当是：

- 公司正在完成哪些工作；
- 哪些部门和 AI 员工正在执行；
- 哪里需要人工处理；
- 产生了什么正式 Artifact；
- 接下来可以采取什么动作。

PRD、Design、代码和报告都作为 Pipeline 输入或 Artifact 出现，不再占据全局固定导航。

## 2. 设计原则

### 2.1 运行优先于配置

首页优先展示 Active、Waiting Approval 和 Blocked 工作。部门和流水线配置是重要能力，但不应遮蔽当前公司状态。

### 2.2 让 AI 员工像员工，不像模型下拉框

员工卡片首先展示姓名、职位、状态、当前工作和能力；Provider 与模型是次级执行信息。

### 2.3 所有自动化都要留下可读证据

默认展示目标、输入、摘要、Artifact 和下一步。原始 Transcript、命令和日志折叠在 Evidence 中。

### 2.4 配置与运行必须视觉区分

- 配置态使用 Draft/Published、版本和编辑操作。
- 运行态使用 Snapshot、节点状态、审批、成本和恢复操作。
- 不允许用户误以为修改配置会改变正在执行的 Run。

### 2.5 高密度但不拥挤

桌面端主要服务开发与交付场景。使用明确层级、紧凑卡片、可扫描表格和状态色，不使用大面积营销插画。

## 3. 信息架构

```text
Company Overview / 公司总览
Projects / 项目
├─ Project Overview
├─ Department Runs
├─ Artifacts
└─ Project Memory
Departments / 部门
├─ Overview
├─ Positions
│  └─ AI Member Detail
├─ Pipeline
├─ Runs
└─ Settings
Artifacts / 产物
└─ Artifact Detail + Lineage
Settings / 设置
├─ General + Language
├─ Company Directory
├─ Agent Providers
├─ Sandbox Providers
├─ Security
└─ Diagnostics
```

旧 Board 不再作为一级导航。运行详情可从总览、Project、Department 或 Artifact Lineage 进入。

Agent Interaction Workspace 也是上下文页面，不新增一个脱离 Project、Department 和 Run 的全局聊天入口。

## 4. 全局 App Shell

### 4.1 左侧导航

宽度建议 232–248px。

顶部：

- Sandcastle 标识
- Company Name
- 本地/离线状态

导航：

- 公司总览 / Company Overview
- 项目 / Projects
- 部门 / Departments
- 产物 / Artifacts
- 设置 / Settings

底部：

- 当前语言切换
- Provider 健康状态
- Desktop 版本

### 4.2 顶部上下文栏

根据当前页面显示：

- 面包屑
- 当前 Company / Project / Department
- 全局搜索
- Waiting Approval 数量
- 新建 Project
- 启动部门运行

不得长期显示“Board idle”这类旧实现状态。

## 5. 关键页面

## 5.1 公司总览

### 页面目标

回答“公司现在怎么样，我需要处理什么”。

### 页面结构

1. Welcome/Company header：公司名称、当前时间范围、主要动作。
2. Attention Queue：等待审批、失败、需要恢复的 Run。
3. Operating Metrics：Active Runs、Waiting Approval、Blocked、Completed Today。
4. Department Operations：各部门负载、员工状态、最近完成率。
5. Active Work：运行列表，按紧急程度排序。
6. Recent Artifacts：最近交付物及版本。
7. Resource Usage：Token、时间和可得成本趋势。

### 空状态

新公司首页只展示两个主动作：

- 创建第一个 Project
- 查看软件开发部门模板

不自动运行模型。

## 5.2 Projects

### Project List

卡片或高密度列表展示：

- 名称与目标摘要
- Active Department Runs
- Waiting Approval / Blocked
- 最近 Artifact
- 最近更新时间

新建 Project 表单不应常驻占据三分之一页面；使用按钮打开 Sheet/Modal。

### Project Detail

Header：目标、状态摘要、关联仓库、启动部门运行。

Tabs：

- Overview
- Runs
- Artifacts
- Memory

Overview 中显示运行时间线和 Artifact 关系，不显示固定 PRD/Design 阶段卡片。

## 5.3 Departments

### Department List

部门卡片展示：

- 名称、说明、Published Pipeline Version
- 职位与 AI 员工数量
- 当前 Active Runs
- 最近成功率
- Built-in / Custom 标签

主动作：Create Department、Duplicate Template。

### Department Detail

Tabs：

- Overview
- Positions
- Pipeline
- Runs
- Settings

Overview 显示部门输入、预期 Artifact、运行健康度和最近活动。

## 5.4 Positions 与 AI 员工

### Positions 页面

建议使用两栏结构：

- 左侧：职位列表和状态。
- 右侧：选中职位/员工详情。

员工详情包含：

- 员工名称和职位
- Available / Working / Waiting / Offline
- 职责边界
- Skills 与 Skill Flows
- 默认 Provider/模型（次级信息）
- 当前和最近 Runs
- 已审核 Memory
- Consult 按钮

Provider 不应出现在员工名称旁，避免形成“员工就是模型”的认知。

## 5.5 Pipeline Editor

### 布局

```text
┌ Node Library ─┬──────── Canvas ─────────────┬ Inspector ┐
│ Start         │                            │ Node       │
│ AI Task       │     visual DAG             │ Position   │
│ Approval      │                            │ Skills     │
│ Condition     │                            │ Inputs     │
│ Parallel/Join │                            │ Outputs    │
│ Complete      │                            │ Policy     │
└───────────────┴────────────────────────────┴────────────┘
```

### 节点视觉

- Start：中性蓝灰
- AI Task：品牌蓝，显示员工头像缩写、职位和 Skill Flow
- Approval：琥珀色，显示审批人和通过条件
- Condition：紫色，显示结构化条件摘要
- Parallel/Join：青色，明确分叉和汇合
- Complete：绿色，显示最终 Artifact 契约
- Failed/Invalid：红色边框与具体错误

### 编辑行为

- 自动保存 Draft，不自动发布。
- Publish 前打开 Validation Drawer。
- 顶部一直显示 `Draft based on vN`。
- Published Version 只读查看。
- Active Run 使用的 Snapshot 从版本历史进入，不在编辑器中直接修改。

### Inspector 字段

AI Task：

- Name
- Position / AI Member
- Skill Flow
- Instructions
- Input Artifact Types
- Output Artifact Types
- Provider Override（可选）
- Timeout / Retry Policy

Approval：

- Approval title
- Required evidence
- Approver
- Approve / Request Changes / Reject 路径

## 5.6 Department Run Detail

### 页面目标

回答“这次工作进行到哪里、谁在做、我需要做什么、已经产生什么”。

### Header

- Run goal
- Project / Department
- Snapshot version
- Running duration
- Token / cost
- Pause / Cancel

### 主区域

默认使用 Timeline + Current Node 两栏：

- 左侧：节点时间线，包含并行分支。
- 中间：当前节点摘要、员工活动和最新输出。
- 右侧：Inputs、Artifacts、Approvals、Evidence。

可切换到 Graph View 查看整条流水线状态。

### Waiting Approval

审批操作固定在页面底部或右侧 Sticky Panel，展示：

- What changed
- Produced Artifacts
- Risks
- Downstream impact
- Approve / Request Changes / Reject

### Failed

失败页面首先提供可读诊断和恢复建议，原始日志置于 Evidence。动作必须说明影响范围：Retry Node、Add Feedback and Retry、Change Allowed Execution Setting、Cancel Run。

## 5.7 Artifacts

### Artifact List

支持按 Type、Project、Department、Producer、Status、Date 筛选。

每行显示：

- Name + Version
- Type
- Project
- Producing Department / AI Member
- Status
- Created At
- Used By count

### Artifact Detail

- Preview / Open
- Metadata
- Version history
- Producer Run and Node
- Input lineage
- Downstream consumers
- Review state
- Use as Run Input

Lineage 使用小型 DAG，不使用纯文本路径列表。

## 5.8 Agent Interaction Workspace

### 页面目标

让用户能与长期 AI 员工实时交流、观察 Agent 行为、处理权限请求，并在不绕过流水线边界的前提下协作当前节点。

### 入口与模式

- AI Member Detail → Consultation
- Project → Consult an AI Member
- Department Run Current Node → Collaborate with Agent
- 外部 ACP Client → 连接同一 AI Member Session

顶部必须明确显示当前模式：

- `Consultation / 非正式咨询`
- `Run Collaboration / 正式节点协作`
- `External ACP Session / 外部本地会话`

### 页面布局

```text
┌ Context / Sessions ─┬────── Conversation + Activity ──────┬ Run / Evidence ┐
│ AI Member           │ User and Agent messages             │ Project        │
│ Project             │ Tool call cards                     │ Run snapshot   │
│ Run / Node          │ Step transitions                    │ Input artifacts│
│ Session history     │ Permission requests                 │ Skill flow     │
│ ACP connection      │ Artifact and status updates         │ Token / cost   │
└─────────────────────┴─────────────────────────────────────┴────────────────┘
```

### AG-UI 事件呈现

- `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`：会话状态条和最终状态。
- `STEP_STARTED` / `STEP_FINISHED`：可折叠的步骤卡片。
- `TEXT_MESSAGE_CONTENT`：流式 Agent 消息。
- `TOOL_CALL_START` / `ARGS` / `END`：结构化 Tool Call 卡片，参数默认摘要化。
- Tool Result：与对应 Tool Call 分组，敏感内容折叠。
- Usage 与 Commit Custom Events：显示成本和代码证据。
- Artifact、Approval、Permission、Snapshot Custom Events：显示 Sandcastle 领域动作。
- `RAW`：只进入 Evidence，不混入主消息流。

断线重连后先加载 Session Snapshot，再接收增量事件。UI 不能依赖重放全部文本才能恢复状态。

### Permission Request

权限卡片必须显示：

- 请求的 Tool/操作
- 目标路径或资源
- 请求原因
- 风险等级和作用范围
- Allow once、Allow for this run、Deny

“长期允许”不作为默认动作；任何持久权限修改应跳转 Settings 并单独确认。

### Consultation

- 顶部明确标记非正式工作。
- 显示当前 Project、员工和 Provider/模型。
- 支持引用 Artifact。
- 结束后动作：Start Run、Add Node Feedback、Draft Project Memory、Submit Memory Candidate、Discard。
- 不提供直接 `Save as Artifact`。

### Run Collaboration

- 固定绑定 Department Run、Snapshot 和 Current Node。
- 用户消息写入 Node Feedback，不修改已冻结的 Pipeline 定义。
- Agent 只能执行当前节点允许的操作和 Skill Flow。
- Artifact Update 必须进入当前 Run 的正式 Artifact 登记流程。
- Pause、Cancel、Request Changes 和 Permission Decision 与 Run Detail 使用同一动作。

### ACP 连接状态

左侧 Session 区域显示：

- Transport：stdio / local IPC
- Client name
- ACP Session ID
- Bound AI Member
- Bound Project / Run / Node
- Connected / Reconnecting / Disconnected

外部 ACP Session 的消息和权限决策必须能在 Desktop 中审计；Desktop 操作也应同步给 ACP Client。

### 多 Agent Discussion Topic 扩展

后续版本允许多个长期 AI 员工围绕一个明确目标自行讨论，体验类似 Discord 的话题频道，但必须保留公司运行所需的控制边界。

未来布局：

```text
┌ Topics ─────────┬──────── Thread / Activity ────────┬ Participants / Context ┐
│ Architecture    │ Human and AI-member messages     │ Moderator              │
│ Product review  │ Replies and sub-threads          │ Participants           │
│ Incident #184   │ Tool and artifact references     │ Project / Run / Node   │
│ + New topic     │ Summary and decisions            │ Budget / stop policy   │
└─────────────────┴───────────────────────────────────┴────────────────────────┘
```

设计约束：

- 每条消息显示 AI Member 身份、职位和状态，不以模型名称代替身份。
- Topic 必须显示 Scope、Goal、Moderator、Participants、Budget 和 Stop Conditions。
- 支持 Reply Thread，避免多个 Agent 的消息变成无法追踪的单一时间流。
- Tool Call、Permission Request 和 Artifact Update 明确标记所属 Participant。
- 主持人可邀请、移除、暂停成员并结束 Topic，但不能替代人工审批。
- 达到 Token、时间、轮次或空转阈值时自动暂停并请求用户决定。
- Topic 结束时生成 Reviewable Summary：共识、分歧、建议、引用 Artifact 和未解决问题。
- Summary 不能直接成为正式 Artifact；用户选择 Start Run、Add Feedback、Create Artifact Draft、Promote Memory 或 Discard。

v1 的 Interaction Workspace 应预留但不展示空壳功能：

- Session Header 组件接受 Participant List，而不是只接受一个头像。
- Message、Event 和 Permission Card 都包含 Participant 槽位。
- 左侧 Session List 后续可无破坏升级为 Topic List。
- 右侧 Context Panel 后续可增加 Participants 和 Topic Policy。
- 一对一页面不出现不可用的“多人讨论”按钮，直到能力真正实现。

## 6. 双语设计

### 6.1 语言切换

- 左侧导航底部和 Settings 均可切换。
- 切换即时生效，不刷新运行状态。
- 布局以英文较长文案为基准，避免中文版正常而英文溢出。

### 6.2 翻译范围

翻译：系统导航、状态、按钮、表单、验证、内置模板。

不翻译：用户创建的名称、Prompt、Artifact 内容、文件路径、外部日志。

### 6.3 状态文案示例

| ID                 | 中文     | English          |
| ------------------ | -------- | ---------------- |
| `running`          | 运行中   | Running          |
| `waiting-approval` | 等待审批 | Waiting approval |
| `blocked`          | 已阻塞   | Blocked          |
| `paused`           | 已暂停   | Paused           |
| `recovering`       | 恢复中   | Recovering       |
| `completed`        | 已完成   | Completed        |

## 7. 视觉方向

### 7.1 品牌感觉

专业、清晰、可信赖的本地 AI 运营系统。视觉参考是研发控制台与现代项目操作系统，而不是聊天应用或传统 Kanban。

### 7.2 色彩

```text
Canvas             #F4F6F8
Surface            #FFFFFF
Surface subtle     #F8FAFC
Border             #D9E0E8
Text primary       #172033
Text secondary     #64748B
Brand              #2357D9
Brand strong       #173EA6
Success            #16875D
Warning            #C47A12
Danger             #C73B45
Purple/condition   #7C5AC7
Teal/parallel      #168C99
```

避免全黑背景、霓虹赛博风、大面积渐变和过多圆角胶囊。

### 7.3 字体与密度

- 中文：系统字体或 `PingFang SC`。
- 英文：Inter/系统 UI 字体。
- 基准字号 14px，页面标题 24–28px。
- 卡片圆角 10–12px。
- 使用 4/8px spacing system。

### 7.4 状态表达

颜色只能作为辅助。所有状态必须同时包含文字、图标或形状差异。

## 8. 响应式策略

v1 以桌面窗口为主：

- 推荐宽度：1440px
- 最低支持宽度：1024px
- 小于 1180px 时 Inspector 变为 Drawer
- 小于 900px 时左侧导航折叠
- Pipeline Editor 不要求移动端完整编辑，但必须可只读查看和审批

## 9. 无障碍要求

- 所有核心操作支持键盘。
- Pipeline 节点提供可访问的列表视图替代画布。
- Focus 状态清楚可见。
- 文本与背景至少满足 WCAG AA。
- 不依赖颜色区分运行状态。
- 实时活动使用适当的 `aria-live`，避免原始日志频繁打断读屏。

## 10. 设计稿范围

本轮高保真交互原型应覆盖：

1. 中文公司总览
2. 英文公司总览
3. 中文部门流水线编辑器
4. 中文 Department Run 等待审批状态
5. 中文 Agent Interaction Workspace（AG-UI 实时事件 + ACP Session + Permission Request）

原型现已升级为内存状态驱动的可点击原型，属于抛弃式设计验证代码，不应直接进入生产实现。

### 可点击交互范围

- 一级导航：公司总览、项目、部门流水线、产物和设置。
- 中文/英文即时切换；中文模式仅保留协议名、Skill 名、文件名、品牌名和代码命令原文。
- 创建 Project：打开表单、填写并新增到项目列表。
- 启动 Department Run：选择 Project、Department、输入 Artifact，预览并生成 Snapshot。
- Pipeline Editor：选择节点并更新 Inspector、验证流水线、发布新版本。
- Run：批准、要求修改、驳回、暂停、恢复和取消，并同步状态与 Timeline。
- Agent Interaction：Permission Decision、引用 Artifact、发送 Node Feedback、暂停/恢复 Agent。
- Artifact：打开版本详情并查看 Lineage。
- Settings：切换语言、检查 Provider 和进入协议诊断。
- Agent Interaction 固定采用方案甲“运营工作台”布局，同时呈现 AI 员工会话、实时事件和运行上下文；方案切换器不属于正式产品界面。

所有状态仅保存在页面内存中，刷新后重置，不连接真实 Agent、数据库或文件系统。

原型文件：`plans/v1-ai-software-company-design/mockup.html`。

截图输出：

- `plans/v1-ai-software-company-design/company-overview-zh.png`
- `plans/v1-ai-software-company-design/company-overview-en.png`
- `plans/v1-ai-software-company-design/pipeline-editor-zh.png`
- `plans/v1-ai-software-company-design/run-approval-zh.png`
- `plans/v1-ai-software-company-design/agent-interaction-zh.png`
- `plans/v1-ai-software-company-design/projects-zh.png`

## 11. 与当前 Desktop 的主要差异

| 当前形态                          | v1.0 设计方向                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| 首页是 Project 列表和常驻创建表单 | 首页是公司运营总览，创建 Project 使用 Modal/Sheet                                      |
| Project 固定五阶段                | Project 聚合多个 Department Runs                                                       |
| PRD/Design 编辑是主工作台         | Pipeline 运行、审批与 Artifact 是主工作台                                              |
| Departments 主要用于成员配置      | Department 是职位、员工和流水线的完整执行单元                                          |
| Board 独立一级导航                | Run 从公司、Project、Department 上下文进入                                             |
| Artifact 主要显示路径             | Artifact 有版本、类型、Producer 和 Lineage                                             |
| Agent 接近临时角色/模型           | AI Member 是长期员工，Provider 只是执行配置                                            |
| 只有终端或原始运行流              | Agent Interaction Workspace 使用 AG-UI 呈现结构化交互，并允许 ACP Client 本地连接      |
| 会话模型默认一对一                | Session、Event 与 Card 保留 Participant/Topic 扩展位，后续支持 Discord 式多 Agent 讨论 |

## 12. 设计验收

- 用户在 5 秒内能识别当前公司是否有阻塞或待审批工作。
- 用户能从 Project 在 3 个主要动作内打开启动 Run 的预览。
- Pipeline Editor 中任一 AI Task 节点能直接看出负责职位和 Skill Flow。
- Run Detail 中默认不阅读 Transcript 也能判断进度和下一步。
- 中文与英文切换不改变布局结构和状态数据。
- 所有页面都不再暗示 Project 必须经过固定五阶段。
- 用户能区分 Consultation、Run Collaboration 和 External ACP Session。
- Tool Call、Permission Request、Artifact Update 和 Run Status 不依赖原始 Transcript 才能理解。
- Desktop 与外部 ACP Client 显示并遵守同一 Run Snapshot 和权限状态。
- 一对一 Interaction 组件没有把唯一 AI Member 写死到消息、事件和权限卡片结构中。
