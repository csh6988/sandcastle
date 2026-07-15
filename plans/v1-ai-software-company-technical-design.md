# Sandcastle v1.0 AI 软件公司技术方案

## 文档状态

- 状态：目标架构已确认，可进入实施拆分
- 版本：v1.0 Draft 1
- 日期：2026-07-13
- 对应产品方案：`plans/v1-ai-software-company-prd.md`
- 对应设计方案：`plans/v1-ai-software-company-design.md`
- 产品形态：本地优先、单用户、Electron Desktop
- 数据策略：v1.0 采用新 Company Directory，不迁移旧 Desktop/Board 数据

## 1. 方案摘要

Sandcastle v1.0 在现有 Electron Desktop 和 Sandcastle 执行核心上，新增一个由 Electron 监管的本地 **Company Runtime**。Company Runtime 是公司数据、部门流水线运行、快照、审批、权限、Artifact、Agent Interaction 和 RuntimeEvent 的唯一控制面。

核心技术方向：

1. 保留现有 Agent Provider、Sandbox、Worktree、分支策略、Session、RuntimeEvent 和验证能力。
2. 新增声明式 Department Pipeline Engine，支持封闭节点类型的版本化 DAG。
3. 使用 SQLite 保存事务性元数据和当前状态，普通文件保存 Artifact 内容、快照载荷和证据。
4. 采用“当前状态表 + 追加式审计 + RuntimeEvent Outbox”，不使用完整事件溯源。
5. 每次 Department Run 绑定不可变 Snapshot Revision；恢复或执行配置变化创建新修订版。
6. Desktop 使用 AG-UI Adapter 呈现事件，ACP Facade 通过本地 IPC 连接同一 Company Runtime。
7. v1 中一个 Position 对应一个长期 AI Member，但 AI Member 身份不绑定 Agent Provider 或模型。
8. 为后续多 AI Member Discussion Topic 预留 Participant、Topic、预算与停止条件字段，不在 v1 实现自主群聊。

## 2. 目标与非目标

### 2.1 技术目标

- 一个权威 Department Run 状态来源。
- Renderer 刷新、崩溃或重新连接不影响正在执行的流水线。
- 流水线配置修改不影响已启动 Run。
- 串行、并行、条件、审批和汇合节点具有确定性状态转换。
- Agent、Sandbox 和 Provider 可替换，不进入领域身份模型。
- RuntimeEvent 可持久化、按游标补发，并能映射到 AG-UI 与 ACP。
- Artifact 具备不可变版本、Producer、输入输出和完整 Lineage。
- 权限、审批、快照修订、恢复和取消均可审计。
- 中英文只影响系统 UI 文案，不改变领域 ID、事件类型和数据结构。

### 2.2 技术非目标

- 不迁移旧固定阶段 Desktop Project 或旧 Board 数据。
- 不继续维护 PRD → Design → R&D → Review 固定项目状态机。
- 不把 AG-UI、ACP、Electron IPC 或 HTTP 作为内部领域模型。
- 不开放任意脚本流水线节点。
- 不允许 Renderer 直接访问 SQLite、文件系统、Agent 或 Sandbox。
- 不实现云同步、多人账号、远程控制面或公网 ACP。
- 不实现完整事件溯源。
- 不在 v1 实现多 Agent 自主话题讨论。

## 3. 已确认架构决策

本方案遵循并扩展以下 ADR：

- `0028-runtime-events-ag-ui-and-acp-facade.md`：RuntimeEvent 是内部结构化事件模型。
- `0029-desktop-company-storage.md`：SQLite 保存公司元数据，文件保存 Artifact 内容。
- `0030-company-runtime-process.md`：Company Runtime 是受 Electron 监管的单写者进程。
- `0031-declarative-department-pipeline-engine.md`：声明式 DAG 引擎位于现有执行能力之上。
- `0032-state-audit-and-runtime-event-outbox.md`：当前状态、审计日志和 Outbox 同事务写入。
- `0033-immutable-run-snapshot-revisions.md`：Run 使用不可变快照修订版。
- `0034-parallel-node-workspace-isolation.md`：并行仓库节点必须隔离工作区。
- `0035-v1-company-model-starts-fresh.md`：新产品数据模型不迁移旧数据。

ADR 0026 与 ADR 0027 中关于“只有一个固定部门”“Project 固定阶段”“Desktop 没有 Agent Interaction”的旧产品约束，被当前 PRD、设计方案和本技术方案取代；其中 Electron 独立打包、根 npm 包不引入 Electron 依赖等工程边界继续保留。

## 4. 总体架构

### 4.1 系统豆腐图

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        Sandcastle Desktop                            │
│                                                                      │
│  ┌──────────────────┐       Typed IPC       ┌────────────────────┐  │
│  │ React Renderer   │◄─────────────────────►│ Electron Main      │  │
│  │                  │                        │                    │  │
│  │ Company UI       │                        │ Window / Menu      │  │
│  │ Pipeline Editor  │                        │ Directory Picker   │  │
│  │ Run Workspace    │                        │ Notifications      │  │
│  │ Agent Interaction│                        │ Runtime Supervisor │  │
│  └────────┬─────────┘                        └─────────┬──────────┘  │
│           │ AG-UI Events                              │ Local IPC    │
└───────────┼───────────────────────────────────────────┼──────────────┘
            │                                           │
            │                                  ┌────────▼─────────────┐
            └─────────────────────────────────►│ Company Runtime      │
                                               │                      │
                                               │ Commands / Queries   │
                                               │ Pipeline Engine      │
                                               │ Interaction Manager  │
                                               │ Artifact Registry    │
                                               │ Permission Policy    │
                                               │ RuntimeEvent Hub     │
                                               └──────┬───────┬───────┘
                                                      │       │
                                      ┌───────────────┘       └──────────────┐
                                      │                                      │
                             ┌────────▼────────┐                    ┌────────▼────────┐
                             │ SQLite + Files │                    │ ACP stdio Facade│
                             │ Company Store  │                    │ External Client │
                             └─────────────────┘                    └─────────────────┘
                                      │
                             ┌────────▼───────────────────────────────┐
                             │ Execution Adapters                    │
                             │ Agent / Sandbox / Worktree / Verifier │
                             └────────┬───────────────────────────────┘
                                      │
                             ┌────────▼────────┐
                             │ Agent Workers   │
                             │ Local/Sandboxed │
                             └─────────────────┘
```

### 4.2 唯一事实来源

| 信息                        | 权威来源                                      |
| --------------------------- | --------------------------------------------- |
| Company/Project/Department  | Company SQLite                                |
| Pipeline Draft/Version      | Company SQLite                                |
| Run/Node/Approval 状态      | Company SQLite 当前状态表                     |
| 运行审计                    | Company SQLite 追加式 Audit Log               |
| 实时事件与补发              | RuntimeEvent Outbox                           |
| Artifact 元数据与 Lineage   | Company SQLite Artifact Registry              |
| Artifact 内容               | Company Directory 普通文件或外部资源引用      |
| Run Configuration Snapshot  | SQLite 元数据 + 不可变 JSON 载荷              |
| Agent Provider 原生 Session | 对应 Agent Provider 的 Session Storage        |
| Provider 凭证               | Secret Store/环境引用，不进入 SQLite Snapshot |

旧 Board Store、Renderer State、AG-UI Event 和 ACP Session 都不是新的 Department Run 状态来源。

## 5. 进程架构

### 5.1 进程豆腐图

```text
┌─────────────────────── Electron Process ─────────────────────────┐
│ BrowserWindow / Menu / Notification / Company Runtime Supervisor │
└──────────────────────────────┬────────────────────────────────────┘
                               │ spawn + authenticated local IPC
┌──────────────────────────────▼────────────────────────────────────┐
│ Company Runtime Process                                           │
│ SQLite Single Writer / Scheduler / Event Hub / Policy / Sessions  │
└───────────────┬───────────────────┬───────────────────────┬────────┘
                │                   │                       │
       ┌────────▼────────┐ ┌────────▼────────┐     ┌────────▼────────┐
       │ Agent Process   │ │ Sandbox Process│ ... │ ACP stdio Bridge│
       │ Codex/Claude/Pi │ │ Docker/Podman  │     │ Editor Client   │
       └─────────────────┘ └─────────────────┘     └─────────────────┘
```

### 5.2 生命周期

1. Electron 选择或创建 Company Directory。
2. Electron 生成本次启动的随机 IPC Token。
3. Electron 启动 Company Runtime，传入 Company Directory、IPC 地址和 Token 引用。
4. Company Runtime 获取目录锁，打开 SQLite，执行 Schema Migration 和完整性检查。
5. Electron 建立 IPC，查询 Runtime 健康状态后加载 Renderer。
6. Renderer 通过 preload 暴露的窄接口发送 Command、Query 和 Event Subscription。
7. Electron 退出时先请求 Company Runtime 优雅停止；活动 Run 默认暂停并保留检查点，不强制标记失败。

### 5.3 崩溃规则

- Renderer 崩溃：Company Runtime 和活动 Run 继续；重新加载后按 Event Cursor 补发。
- Electron 窗口关闭：macOS 可保持应用进程；真正退出时停止 Runtime。
- Company Runtime 崩溃：Electron 最多自动重启一次；回收未完成 Node Lease，并将中断节点标记为 `failed`，同时附带 `recoverable: true` 和恢复证据。
- Agent Worker 崩溃：仅当前 Node Run 失败，保存 Recovery Evidence，不拖垮 Runtime。
- SQLite 打不开或迁移失败：Runtime 不启动写模式，Desktop 进入只读诊断页。

## 6. 深模块与接缝

`codebase-design` 的原则是把复杂行为放在少量深模块后面。Renderer、ACP 和测试都跨同一接口，不各自实现业务规则。

### 6.1 模块豆腐图

```text
┌─────────────────────────────────────────────────────────────────┐
│ Company Runtime Interface                                       │
│ execute(command) / query(query) / subscribe(cursor, filter)     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────┐   ┌───────────────────┐                  │
│  │ Company Catalog   │   │ Pipeline Runtime  │                  │
│  │ Projects/Dept/AI  │   │ DAG/Run/Recovery  │                  │
│  └─────────┬─────────┘   └─────────┬─────────┘                  │
│            │                       │                            │
│  ┌─────────▼─────────┐   ┌─────────▼─────────┐                  │
│  │ Artifact Registry │   │ Interaction       │                  │
│  │ Version/Lineage   │   │ Session/Permission│                  │
│  └─────────┬─────────┘   └─────────┬─────────┘                  │
│            │                       │                            │
│  ┌─────────▼───────────────────────▼─────────┐                  │
│  │ Transaction Coordinator                  │                  │
│  │ State + Audit + RuntimeEvent Outbox      │                  │
│  └─────────┬───────────────────────┬─────────┘                  │
│            │                       │                            │
│  ┌─────────▼─────────┐   ┌─────────▼─────────┐                  │
│  │ SQLite Adapter    │   │ Execution Adapter │                  │
│  │ Production/Test  │   │ Sandcastle/Fake   │                  │
│  └───────────────────┘   └───────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Company Runtime Interface

进程外只暴露三类操作：

```ts
interface CompanyRuntimeClient {
  execute(command: CompanyCommand): Promise<CommandResult>;
  query(query: CompanyQuery): Promise<QueryResult>;
  subscribe(input: EventSubscription): AsyncIterable<EventEnvelope>;
}
```

接口约束：

- Command 必须携带 `commandId`，支持幂等重试。
- Query 不产生状态变化。
- Event Subscription 使用持久化 `cursor`，不能只依赖内存广播。
- 错误使用稳定错误码，UI 文案由客户端本地化。
- Renderer 和 ACP 不获得 SQL、文件路径写入或 Node Handler 直接调用能力。

### 6.3 Company Catalog Module

隐藏以下复杂度：

- Company、Project、Department、Position 和 AI Member 生命周期。
- Skill Catalog 与 Position Skill Flow 绑定。
- Pipeline Draft 编辑、校验、发布和版本冻结。
- Execution Profile 与 AI Member 身份解耦。

外部接口保持为高层命令，例如 `CreateDepartment`、`PublishPipeline`，不暴露表级 CRUD。

### 6.4 Pipeline Runtime Module

隐藏以下复杂度：

- DAG 依赖计算和 Ready Queue。
- Node Lease、并发限制和重复执行保护。
- Condition、Parallel/Join、Approval 和 Complete 语义。
- Snapshot Revision、Checkpoint、Pause、Cancel、Retry、Resume 和 Fork。
- Node Handler 选择和 Artifact Contract 校验。

建议接口：

```ts
interface PipelineRuntime {
  start(input: StartDepartmentRun): Promise<DepartmentRunView>;
  decide(input: RunDecision): Promise<DepartmentRunView>;
  control(input: RunControl): Promise<DepartmentRunView>;
  inspect(runId: RunId): Promise<DepartmentRunView>;
}
```

### 6.5 Artifact Registry Module

Artifact Registry 负责：

- 创建 Artifact 和不可变 Artifact Version。
- 对 managed file 计算 SHA-256 和大小。
- 登记 external reference，例如 Git Branch、Commit、Pull Request 和 Preview URL。
- 维护 `produced-by`、`derived-from`、`consumed-by` 和 `supersedes` 关系。
- 状态流转：Draft → Produced → Accepted/Rejected/Superseded。
- 验证 Artifact 是否满足 Pipeline Node 的输入输出契约。

Artifact 内容写入与元数据登记必须采用“临时文件 → fsync/rename → SQLite 登记”的顺序；失败时由清理任务处理孤儿临时文件。

### 6.6 Interaction Module

Interaction Module 负责：

- Consultation 和 Run Collaboration Session。
- Participant、Session、Message、Tool Call、Permission 和 Usage。
- 将 Agent Provider 原生 Session ID 绑定到 Sandcastle Session。
- 将节点反馈限制在当前 Run、Snapshot Revision 和 Node Run。
- 将咨询结果显式转换为 Run、Node Feedback 或 Memory Candidate。
- 为后续 Topic 保留 `topicId`、`participantId` 和 `moderatorId`。

Interaction 不直接批准 Run，也不直接登记正式 Artifact；它调用 Pipeline Runtime 与 Artifact Registry 的正式命令。

### 6.7 Execution Adapter Seam

存在两个真实 Adapter：

- Production：调用现有 `run()`、`runWorkspaceTask()`、`interactive()`、Sandbox、Worktree 和 Provider。
- Test：Scripted Execution Adapter，可按脚本发出 RuntimeEvent、失败、超时、权限请求和 Artifact 结果。

因此该接缝是必要的，测试不启动真实 Agent 或 Sandbox。

## 7. 目标代码布局

本方案不新增独立 monorepo package，优先在现有 `apps/desktop` 内完成产品闭环，并通过现有 Sandcastle 公共接口复用执行核心。

```text
apps/desktop/
├─ main/
│  ├─ main.ts
│  ├─ companyRuntimeSupervisor.ts
│  ├─ nativeBridge.ts
│  └─ notifications.ts
├─ preload/
│  └─ index.ts
├─ runtime/
│  ├─ entry.ts
│  ├─ interface.ts
│  ├─ application/
│  ├─ catalog/
│  ├─ pipeline/
│  ├─ interaction/
│  ├─ artifacts/
│  ├─ events/
│  ├─ storage/sqlite/
│  └─ adapters/sandcastle/
├─ acp/
│  ├─ stdio.ts
│  └─ runtimeClient.ts
├─ renderer/
│  ├─ app/
│  ├─ features/
│  ├─ ag-ui/
│  └─ i18n/
└─ tests/

src/
├─ RuntimeEvent.ts           # 继续作为执行事件核心
├─ run.ts
├─ runWorkspaceTask.ts
├─ interactive.ts
├─ AgentProvider.ts
├─ SandboxProvider.ts
└─ ...                       # 不引入 Electron/React/SQLite
```

当 Company Runtime 需要成为无界面独立产品时，再以真实第二个调用方为依据提取 package；v1 不提前建立只有一个 Adapter 的抽象包。

## 8. Company Directory 与文件布局

```text
<company-root>/
├─ .sandcastle/
│  ├─ company.sqlite
│  ├─ company.sqlite-wal
│  ├─ snapshots/
│  │  └─ <run-id>/
│  │     ├─ r1.json
│  │     └─ r2.json
│  ├─ evidence/
│  │  └─ <run-id>/<node-run-id>/
│  ├─ runtime/
│  │  ├─ company-runtime.sock     # Unix；Windows 使用 Named Pipe
│  │  └─ runtime.lock
│  └─ backups/
├─ projects/
│  └─ <project-id>/
│     ├─ project-files/
│     └─ artifacts/
│        └─ <artifact-id>/<version>/
└─ templates/
   └─ departments/
```

规则：

- SQLite 使用 WAL 模式和外键约束。
- Snapshot JSON 使用 canonical JSON 后计算 SHA-256；写入后不可修改。
- Managed Artifact 位于 Project 目录；外部代码仓库只保存引用，不复制整个仓库。
- Runtime Socket 和 Lock 是临时文件，不作为可迁移数据。
- 备份使用 SQLite Online Backup，不直接复制活动 WAL 文件。

## 9. 数据模型

### 9.1 领域关系豆腐图

```text
┌───────────┐     ┌────────────┐     ┌─────────────────┐
│ Company   │1───*│ Project    │1───*│ Department Run  │
└─────┬─────┘     └────────────┘     └───────┬─────────┘
      │                                      │
      │1                                     │1
      │                                      │
      │*                                     │*
┌─────▼──────┐ 1  ┌─────────────────┐ 1  ┌──▼──────────┐
│ Department │───*│ Pipeline Version│───*│ Node Run    │
└─────┬──────┘    └─────────────────┘    └────┬────────┘
      │1                                       │
      │                                        │ produces
      │*                                       │
┌─────▼──────┐ 1  ┌───────────────┐      ┌────▼─────────┐
│ Position   │───1│ AI Member     │      │ Artifact Ver │
└────────────┘    └──────┬────────┘      └──────────────┘
                         │
                         │*
                  ┌──────▼──────────┐
                  │ Interaction     │
                  │ Session         │
                  └─────────────────┘
```

### 9.2 核心表

| 表                       | 关键字段                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `companies`              | `id`, `name`, `default_locale`, `created_at`                                |
| `projects`               | `id`, `company_id`, `name`, `goal`, `status`                                |
| `departments`            | `id`, `company_id`, `name`, `status`, `active_pipeline_version_id`          |
| `positions`              | `id`, `department_id`, `name`, `responsibility`, `ai_member_id`             |
| `ai_members`             | `id`, `display_name`, `profile`, `status`, `memory_policy_id`               |
| `skills`                 | `id`, `source`, `name`, `version`, `location_ref`                           |
| `skill_flows`            | `id`, `name`, `definition_json`, `version`                                  |
| `pipeline_drafts`        | `department_id`, `revision`, `graph_json`, `updated_at`                     |
| `pipeline_versions`      | `id`, `department_id`, `version`, `graph_json`, `hash`, `published_at`      |
| `execution_profiles`     | `id`, `provider_ref`, `model`, `sandbox_ref`, `branch_strategy`, `limits`   |
| `department_runs`        | `id`, `project_id`, `department_id`, `status`, `active_snapshot_revision`   |
| `run_snapshot_revisions` | `run_id`, `revision`, `parent_revision`, `payload_path`, `hash`             |
| `node_runs`              | `id`, `run_id`, `node_id`, `attempt`, `status`, `lease_until`, `checkpoint` |
| `approvals`              | `id`, `run_id`, `node_run_id`, `status`, `decision`, `decided_at`           |
| `permission_requests`    | `id`, `session_id`, `node_run_id`, `scope`, `status`, `expires_at`          |
| `artifacts`              | `id`, `project_id`, `type`, `logical_name`                                  |
| `artifact_versions`      | `id`, `artifact_id`, `version`, `content_ref`, `hash`, `status`             |
| `artifact_links`         | `from_version_id`, `to_version_id`, `relation`                              |
| `interaction_sessions`   | `id`, `mode`, `ai_member_id`, `project_id`, `run_id`, `node_run_id`         |
| `session_participants`   | `session_id`, `participant_id`, `role`, `topic_id`                          |
| `session_messages`       | `id`, `session_id`, `participant_id`, `kind`, `content_ref`                 |
| `memory_candidates`      | `id`, `scope`, `source_ref`, `summary`, `status`                            |
| `audit_log`              | `sequence`, `actor`, `action`, `subject`, `payload`, `created_at`           |
| `runtime_event_outbox`   | `sequence`, `event_id`, `type`, `scope_ids`, `payload`, `published_at`      |
| `command_deduplication`  | `command_id`, `result_ref`, `completed_at`                                  |

### 9.3 ID 与版本

- 领域 ID 使用 UUIDv7 或等价的时间有序全局 ID。
- Pipeline Version 使用部门内递增展示版本，同时保留不可变 ID 和 Hash。
- Artifact Version 使用 Artifact 内递增版本。
- Snapshot Revision 使用 Run 内递增 `r1`, `r2`。
- RuntimeEvent 使用全局递增 `sequence` 和唯一 `eventId`。
- 所有时间存 UTC，Renderer 按语言和时区显示。

## 10. Department Pipeline 定义

### 10.1 Graph Schema

```ts
interface PipelineDefinition {
  id: string;
  departmentId: string;
  version: number;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  inputContracts: ArtifactContract[];
  outputContracts: ArtifactContract[];
}
```

节点定义只保存领域配置，不保存任意可执行代码。AI Task 的实际执行由已注册 Node Handler 决定。

### 10.2 v1 节点类型

| 类型           | 语义                                                                 |
| -------------- | -------------------------------------------------------------------- |
| Start          | 校验 Run 输入并激活首批节点                                          |
| AI Task        | 由 Position/AI Member 执行指定 Skill Flow，生成结构化结果或 Artifact |
| Human Approval | 阻塞下游，等待 Approve/Changes/Reject                                |
| Condition      | 对结构化字段执行声明式判断，不执行任意 JavaScript                    |
| Parallel       | 激活多个分支，并应用并发与工作区隔离策略                             |
| Join           | 等待指定分支，校验结果与 Artifact Contract                           |
| Complete       | 校验部门输出契约并结束 Run                                           |

### 10.3 发布校验

发布 Pipeline Version 前必须验证：

- 恰好一个 Start，至少一个 Complete。
- 所有节点可从 Start 到达，所有非终点节点可到达 Complete。
- 无非法环；v1 不支持循环节点。
- AI Task 和 Approval 节点具有 Position 负责人。
- Condition 分支完整并包含默认分支。
- Parallel 与 Join 配对，Join 等待策略明确。
- Artifact 输入输出类型兼容。
- 敏感动作前存在所需 Approval 或 Permission Policy。
- 同仓库并行节点满足隔离条件。
- Timeout、Completion Signal、重试和预算存在有效默认值。

## 11. Run 与 Node 状态机

### 11.1 Department Run 状态

```text
┌───────┐    ┌───────┐    ┌─────────┐     ┌──────────────────┐
│ Draft ├───►│ Ready ├───►│ Running │────►│ Waiting Approval │
└───────┘    └───────┘    └────┬────┘     └────────┬─────────┘
                               │  ▲                │ approve
                        pause  │  │ resume         └──────────┐
                               ▼  │                           │
                           ┌────────┐                         │
                           │ Paused │                         │
                           └────────┘                         │
                               │                              │
                 dependency / resource unavailable           │
                               ▼                              │
                           ┌────────┐                          │
                           │Blocked │──────────────────────────┘
                           └───┬────┘       unblocked
                               │ failure
                               ▼
                           ┌────────┐  recover  ┌────────────┐
                           │ Failed ├──────────►│ Recovering │
                           └────────┘           └─────┬──────┘
                                                    ▼
                                                 Running

Any unfinished state ──cancel──► Cancelled
Running + output contracts ─────► Completed
Rejected / unrecoverable ────────► Failed
```

### 11.2 Node Run 状态

```text
Queued → Ready → Running → Succeeded
                    │
                    ├→ Waiting Permission → Running
                    ├→ Waiting Approval   → Succeeded/Failed
                    ├→ Paused             → Running
                    └→ Failed             → Retry/Recover/Cancelled

Condition not selected → Skipped
Run cancelled          → Cancelled
```

状态转换由 Pipeline Runtime 在 SQLite 事务中完成。Agent RuntimeEvent 只能提供执行事实，不能直接修改 Run 状态；Node Handler 必须返回显式结果，由 Pipeline Runtime 判定转换。

## 12. 启动与执行流程

### 12.1 启动 Run 时序豆腐图

```text
User        Renderer       Company Runtime      Store       Pipeline Engine
 │             │                  │               │                │
 │ Start Run   │                  │               │                │
 ├────────────►│ execute(command) │               │                │
 │             ├─────────────────►│ validate      │                │
 │             │                  ├──────────────►│ load versions  │
 │             │                  │◄──────────────┤                │
 │             │                  ├───────────────┼───────────────►│ build snapshot
 │             │                  │               │◄───────────────┤
 │             │                  ├──────────────►│ tx: run+snapshot+outbox
 │             │                  │◄──────────────┤                │
 │             │                  ├───────────────┼───────────────►│ schedule ready nodes
 │             │◄─────────────────┤ command result│                │
 │◄────────────┤ show Run         │               │                │
```

### 12.2 Node 执行流程

1. Scheduler 在事务中为 Ready Node 获取 Lease。
2. 读取该 Node 对应 Snapshot Revision，不读取当前 Draft 配置。
3. 解析 Position、AI Member、Skill Flow 和 Execution Profile。
4. 创建隔离 Worktree/Sandbox；bind-mount/no-sandbox 根据并发策略降级。
5. Execution Adapter 调用现有 Sandcastle 能力并转发 RuntimeEvent。
6. RuntimeEvent 进入 Outbox；高频文本增量可以批量提交，但 Tool/Permission/Status 不得丢失。
7. Node Handler 校验 Structured Output 和 Artifact Contract。
8. 同一事务写入 Node 结果、Artifact 元数据、Audit 和状态事件。
9. Scheduler 计算新的 Ready Node；到达 Approval 时停止自动推进。

### 12.3 并发调度

并发限制按四层取最小值：

- Company 全局最大活动 Node 数。
- Provider/模型并发限制。
- Department/Run 预算限制。
- Repository Workspace 隔离能力。

Scheduler 使用数据库 Lease 防止重复执行；Lease 定期续租。Runtime 崩溃后，过期 Lease 的 Node 进入 `failed` 并标记 `recoverable: true`，不会未经检查自动重新运行有副作用的步骤。

## 13. Snapshot、恢复与 Fork

### 13.1 Snapshot 豆腐图

```text
┌────────────────────── Snapshot r1 ───────────────────────┐
│ Pipeline Version v4                                      │
│ Node Definitions + Artifact Contracts                    │
│ Position / AI Member / Skill Flow                         │
│ Input Artifact Version IDs                                │
│ Permission Policy                                         │
│ Execution Profile: Provider/Model/Sandbox/Branch/Limits   │
│ Secret References only                                    │
└──────────────────────────┬─────────────────────────────────┘
                           │ recovery override
                           ▼
┌────────────────────── Snapshot r2 ───────────────────────┐
│ parent = r1                                               │
│ changed: model / provider / sandbox / limits              │
│ unchanged fields copied and re-hashed                     │
└────────────────────────────────────────────────────────────┘
```

### 13.2 恢复规则

- 重试相同配置：复用当前 Snapshot Revision，新建 Node Attempt。
- 修改允许的执行配置：创建新 Snapshot Revision。
- 修改目标、Pipeline Version、输入 Artifact 或审批结果：不得作为原 Run 恢复；创建 Fork Run。
- 有效上游 Node 不重复执行，除非用户显式选择从该节点 Fork。
- 原生 Agent Session 仅在 Provider 声明支持且 Session 文件可用时 Resume。
- Fork Session 不修改父 Session；记录 `parentSessionId`。

### 13.3 Timeout 与 Completion Signal

沿用现有 Sandcastle 语义：

- Idle Timeout：无输出超过阈值，Node 失败并保留恢复证据。
- Completion Timeout：已看到 Completion Signal 但进程未退出，宽限期后收敛结果。
- Node Timeout：Pipeline 层的总时限，超过后通过 AbortSignal 取消底层执行。
- Run Budget：Token、成本或时间预算触顶时暂停到人工确认点，不静默继续。

## 14. RuntimeEvent、AG-UI 与断线恢复

### 14.1 事件信封

```ts
interface EventEnvelope {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  type: string;
  companyId: string;
  projectId?: string;
  departmentId?: string;
  runId?: string;
  nodeRunId?: string;
  sessionId?: string;
  participantId?: string;
  topicId?: string;
  timestamp: string;
  payload: unknown;
}
```

`participantId` 和 `topicId` 在 v1 多数为空，但事件结构不假设永远只有一个 Agent。

### 14.2 事件流豆腐图

```text
Agent/Sandbox Events
        │
        ▼
┌──────────────────┐
│ RuntimeEvent     │  内部协议无关模型
└────────┬─────────┘
         ▼ SQLite transaction
┌──────────────────┐
│ Event Outbox     │──cursor/replay──┐
└────────┬─────────┘                 │
         │                           │
   ┌─────▼──────┐              ┌─────▼──────┐
   │ AG-UI      │              │ ACP Facade │
   │ Adapter    │              │ Adapter    │
   └─────┬──────┘              └─────┬──────┘
         ▼                           ▼
   Desktop UI                  External Client
```

### 14.3 AG-UI 映射

| RuntimeEvent                   | AG-UI                              |
| ------------------------------ | ---------------------------------- |
| `run.started`                  | `RUN_STARTED`                      |
| `node.started`                 | `STEP_STARTED`                     |
| `message.delta`                | `TEXT_MESSAGE_CONTENT`             |
| `tool.call`                    | `TOOL_CALL_START/ARGS/END`         |
| `tool.result`                  | Tool Result Event                  |
| `usage.recorded`               | Usage Custom Event                 |
| `permission.requested/decided` | Sandcastle Permission Custom Event |
| `approval.requested/decided`   | Sandcastle Approval Custom Event   |
| `artifact.version.created`     | Sandcastle Artifact Custom Event   |
| `snapshot.revision.created`    | Sandcastle Snapshot Custom Event   |
| `run.paused/failed/completed`  | Run Status Event                   |

AG-UI Adapter 失败只影响显示。Renderer 重新订阅时携带最后 `sequence`，Outbox 从下一条补发。

### 14.4 Event Retention

- 状态、审批、权限、Artifact 和 Audit 类事件长期保留。
- 高频 Text Delta 可在 Session 完成后压缩为 Message Content，并保留原始 Evidence 文件引用。
- Raw 命令输出默认进入 Evidence 文件，Outbox 只保留摘要和引用，避免 SQLite 无限膨胀。
- 清理策略不得删除仍被审计、Artifact Lineage 或失败恢复引用的记录。

## 15. ACP Facade

### 15.1 连接方式

v1 ACP 通过 stdio 暴露；Facade 自身不运行 Pipeline Engine，不打开第二个写 Store，而是通过受认证本地 IPC 连接 Company Runtime。

v1 要求 Desktop 和 Company Runtime 已启动；若本地 Runtime Socket 不存在，ACP Facade 返回明确的 `COMPANY_RUNTIME_UNAVAILABLE`，不在后台静默创建第二个 Runtime。无界面启动模式留到后续版本。

```text
ACP Client ⇄ stdio ⇄ ACP Facade ⇄ local IPC ⇄ Company Runtime
```

### 15.2 方法映射

| ACP 方法                     | Company Runtime 命令/查询                            |
| ---------------------------- | ---------------------------------------------------- |
| `initialize`                 | 查询 Runtime、Provider 和协议能力                    |
| `session/new`                | `OpenInteractionSession`                             |
| `session/prompt`             | `SendSessionPrompt`                                  |
| `session/update`             | 按 Session Filter 订阅 Event Outbox                  |
| `session/request_permission` | `DecidePermission`，复用同一 Permission Policy       |
| `session/cancel`             | `CancelInteractionTurn` 或受限 `CancelNodeExecution` |

### 15.3 ACP 限制

- 外部 Client 不永久等同于 AI Member。
- Session 必须显式绑定 AI Member，并可选绑定 Project、Run 和 Node。
- ACP 不能修改 Pipeline Version、Snapshot、审批结果或正式 Artifact 状态。
- Run Collaboration 只能在当前 Node 允许的命令集合内操作。
- ACP 能力响应不得返回凭证、完整环境变量、敏感 Memory 或任意本地路径。

## 16. Agent Interaction 与未来 Topic

### 16.1 v1 Session 模型

| 模式              | 允许                                                    | 禁止                           |
| ----------------- | ------------------------------------------------------- | ------------------------------ |
| Consultation      | 咨询、引用只读 Artifact、生成 Memory Candidate          | 直接写正式 Artifact 或推进 Run |
| Run Collaboration | 节点反馈、权限决定、观察 Tool/Usage、节点允许的文件更新 | 绕过 Approval、修改 Snapshot   |
| External ACP      | 与上述模式相同，入口不同                                | 获得额外权限                   |

### 16.2 Topic 扩展位

v1 数据和事件保留：

- `topicId`
- `participantId`
- `moderatorId`
- `budgetPolicy`
- `maxRounds`
- `stopCondition`

但 v1 不提供 Topic Scheduler。后续 Topic Coordinator 必须通过 Interaction Module 创建多个受限 Session，不能直接调用 Agent Provider 或互相授予权限。

## 17. Artifact 与 Memory

### 17.1 Artifact 类型

v1 至少支持：

- Markdown/文档
- 图片与设计稿
- JSON/结构化数据
- Git Commit/Branch/Pull Request 引用
- 构建包与测试报告
- Preview URL
- Verification Report

Artifact 类型由 `type` + `schemaVersion` 标识；领域逻辑不依赖文件扩展名推断类型。

### 17.2 Lineage

每个 Artifact Version 必须记录：

- Producer：Run、Node Run、AI Member、Snapshot Revision。
- Inputs：被消费的 Artifact Version。
- Content Ref：受管文件或外部资源引用。
- Integrity：Hash、大小和创建时间。
- Status：Draft、Produced、Accepted、Rejected 或 Superseded。

### 17.3 Memory

- Project Memory 与 AI Member Memory 分开。
- 原始 Transcript 不自动进入长期 Memory。
- Agent 只能创建 Memory Candidate。
- 用户审核后才 Promotion。
- Memory 记录来源 Session/Run/Artifact，并支持撤销。
- Snapshot 只记录 Memory 版本引用，不复制全部敏感内容。

## 18. 权限与安全

### 18.1 权限豆腐图

```text
Requested Operation
        │
        ▼
┌───────────────────┐
│ Permission Policy │
│ Node + Snapshot   │
└───────┬───────────┘
        │
   ┌────▼────┐  allow  ┌────────────────┐
   │ Decision├────────►│ Execution      │
   └────┬────┘         └────────────────┘
        │ ask
        ▼
┌───────────────────┐
│ User Approval     │──► Audit + Outbox
└───────────────────┘
```

### 18.2 安全规则

- Electron 使用 `contextIsolation: true`、`nodeIntegration: false` 和显式 preload allowlist。
- Renderer 传入的所有 Command 使用 Zod 或等价 Schema 校验。
- Company Runtime Socket 仅当前用户可访问，并校验每次启动的随机 Token。
- 不监听公网地址；若开发模式使用 TCP，只绑定 `127.0.0.1` 并要求 Token。
- Provider 凭证保存于 OS Keychain、Electron safeStorage 或外部环境引用。
- Snapshot、SQLite、Artifact、Audit 和日志不保存原始 Token、完整环境变量或签名 URL。
- 文件路径必须 canonicalize，并验证位于 Company Directory、声明的 Repository 或 Sandbox 范围内。
- Tool Result 和 Raw Event 在进入 UI 前执行敏感字段折叠。
- ACP Permission 与 Desktop Permission 使用同一 Policy 和 Audit。

## 19. 错误模型

错误返回稳定 `code`，而非依赖英文错误文本：

| 类别       | 示例错误码                                              |
| ---------- | ------------------------------------------------------- |
| Validation | `PIPELINE_INVALID`, `ARTIFACT_CONTRACT_MISMATCH`        |
| Conflict   | `VERSION_CONFLICT`, `COMMAND_ALREADY_APPLIED`           |
| Permission | `PERMISSION_REQUIRED`, `PERMISSION_DENIED`              |
| Execution  | `AGENT_FAILED`, `SANDBOX_FAILED`, `NODE_TIMEOUT`        |
| Recovery   | `CHECKPOINT_MISSING`, `SESSION_NOT_RESUMABLE`           |
| Storage    | `STORE_BUSY`, `STORE_CORRUPT`, `SNAPSHOT_HASH_MISMATCH` |
| Protocol   | `CURSOR_EXPIRED`, `ACP_SESSION_NOT_FOUND`               |

每个失败 Node 保存 `RunFailureRecovery` 扩展证据：失败类别、阶段、Worktree、日志、Session、Commit、Completion Signal 和可用恢复动作。

## 20. IPC 与界面契约

### 20.1 Renderer Bridge

preload 只暴露：

```ts
window.sandcastle = {
  execute(command),
  query(query),
  subscribe(filter, cursor),
  selectDirectory(),
  openExternalArtifact(ref),
};
```

不暴露任意 `ipcRenderer.send`、`fs`、`child_process` 或 SQL。

### 20.2 Query View

Renderer 获取面向页面的只读 View，而不是拼接多张表：

- `CompanyOverviewView`
- `ProjectDetailView`
- `DepartmentEditorView`
- `DepartmentRunView`
- `ArtifactDetailView`
- `InteractionWorkspaceView`

View 包含稳定 ID 与本地化前的枚举；系统文案由 Renderer i18n 生成。

### 20.3 乐观并发

Pipeline Draft、Department 设置和 AI Member Profile 使用 `revision`。更新命令携带 `expectedRevision`，不匹配时返回 `VERSION_CONFLICT`，避免多个窗口静默覆盖。

## 21. 软件开发部门内置模板

### 21.1 v1 默认流程

```text
┌────────┐   ┌──────────────┐   ┌──────────────┐
│ Start  ├──►│ 产品目标对齐 │──►│ 生成技术方案 │
└────────┘   └──────────────┘   └──────┬───────┘
                                       ▼
                              ┌────────────────┐
                              │ 人工批准方案   │
                              └───────┬────────┘
                                      ▼
                  ┌──────────────── Parallel ────────────────┐
                  │                                          │
          ┌───────▼────────┐                        ┌────────▼───────┐
          │ 仓库实现 A     │          ...           │ 仓库实现 N    │
          └───────┬────────┘                        └────────┬───────┘
                  └──────────────────┬───────────────────────┘
                                     ▼
                              ┌──────────────┐
                              │ Join/代码审查│
                              └──────┬───────┘
                                     ▼
                              ┌──────────────┐
                              │ 交付验证     │
                              └──────┬───────┘
                                     ▼
                              ┌──────────────┐
                              │ 最终验收     │
                              └──────┬───────┘
                                     ▼
                                ┌────────┐
                                │Complete│
                                └────────┘
```

### 21.2 现有能力复用

| 新节点       | 复用能力                                                      |
| ------------ | ------------------------------------------------------------- |
| 产品目标对齐 | Skill Flow + Structured Output                                |
| 生成技术方案 | `runWorkspaceTask()` 规划与仓库分析能力                       |
| 仓库实现     | `run()`、Worktree、Sandbox、Branch Strategy                   |
| 代码审查     | 独立 Agent Session + Artifact/Commit 输入                     |
| 交付验证     | 现有 Evaluator、Verification Report、Runtime Failure Evidence |
| 节点协作     | `interactive()` 与 Provider-owned Session Storage             |

复用指行为和测试可被 Adapter 调用，不复制旧 Board Store 或固定阶段状态机。

## 22. 实施阶段

### Phase 0：工程骨架

- 新建 Company Runtime 子进程和 Supervisor。
- 建立 preload Typed IPC。
- 引入 SQLite Adapter、Schema Migration、备份和目录锁。
- 用 Electron 实际运行时验证 SQLite Driver；优先使用 Electron 内置 Node 可直接支持的实现，若必须使用原生 Addon，则把 ABI 重建和 macOS/Windows/Linux 打包验证列为 Phase 0 硬门槛。
- 建立 Command/Query/Event Envelope 和 Scripted Fake。

交付标准：Renderer 能查询 Runtime 健康状态；重载 Renderer 不影响 Runtime。

### Phase 1：公司与配置

- Company、Project、Department、Position、AI Member、Skill Flow。
- Pipeline Draft Editor、校验和发布。
- Execution Profile 与 Secret Reference。
- 新公司目录初始化和软件开发部门模板安装。

交付标准：不调用模型即可完成所有配置操作。

### Phase 2：Pipeline Engine

- Run Snapshot r1。
- Start/AI Task/Approval/Condition/Parallel/Join/Complete。
- Scheduler、Lease、Pause、Cancel、Retry 和 Recovery。
- Software Development Node Handlers。

交付标准：Scripted Adapter 可完成完整流水线；真实 Adapter 可完成单仓库交付。

### Phase 3：Artifact 与审计

- Artifact Registry、Version、Lineage 和文件布局。
- State + Audit + Outbox 同事务。
- Run/Node/Approval 页面 View。
- Snapshot Revision 和 Fork Run。

交付标准：任意 Artifact 可追溯到准确 Snapshot、Node、AI Member 和输入版本。

### Phase 4：Agent Interaction 与协议

- Interaction Session、Permission 和 Message。
- AG-UI Adapter、Cursor Replay 和事件压缩。
- ACP stdio Facade。
- Consultation 与 Run Collaboration。

交付标准：Desktop 和 ACP 观察同一 Session、权限和 Run 状态，任一入口都不能绕过审批。

### Phase 5：Memory 与稳定性

- Project/AI Member Memory Candidate 与审核。
- Runtime 崩溃恢复、Store 备份、诊断与数据压缩。
- 性能、长时间运行和多仓库并发测试。
- Participant/Topic 扩展字段验证，不实现 Topic Coordinator。

## 23. 测试策略

### 23.1 Module Interface 测试

- Company Catalog：使用临时 SQLite 验证版本冲突和发布不可变性。
- Pipeline Runtime：使用 Scripted Execution Adapter 测试所有状态转换。
- Artifact Registry：使用临时文件系统测试原子写、Hash 和 Lineage。
- Interaction：使用 Fake Provider Session 测试权限、取消和反馈边界。
- Event Hub：测试 Outbox 顺序、重复投递、Cursor Replay 和 Adapter 故障隔离。

### 23.2 契约测试

- Production 与 Fake Execution Adapter 共享行为契约。
- SQLite Migration 从空库到当前版本逐级验证。
- IPC Command/Query Schema 在 Main、Runtime 和 Renderer 三端共享生成类型。
- RuntimeEvent → AG-UI 与 RuntimeEvent → ACP 映射使用固定 Fixture。

### 23.3 集成测试

- 启动 Company Runtime 子进程，执行完整 Scripted Department Run。
- Renderer 刷新后从 Cursor 恢复事件。
- Runtime 在 Node Running 时崩溃，将节点标记为 `failed`/`recoverable`，并可进入 `recovering` 后恢复执行。
- 并行同仓库节点获得不同 Worktree。
- bind-mount/no-sandbox 同仓库节点被自动串行化。
- Snapshot Revision r2 不改变 r1 Hash。
- ACP 与 Desktop 对同一 Permission Request 得到一致结果。

### 23.4 端到端测试

- 创建公司 → 创建项目 → 启动软件开发部门 → 审批 → 并行实现 → 验证 → Artifact 验收。
- 从 Run 打开 Agent Interaction，处理权限并发送 Node Feedback。
- 暂停、退出、重启、恢复。
- 中英文切换不改变状态和 ID。

## 24. 性能与容量基线

v1 目标不是大规模服务器，但必须适合长期本地使用：

- Company Overview 查询：P95 < 200ms（10,000 Runs、100,000 Event 摘要）。
- Command 提交：不含 Agent 执行时 P95 < 100ms。
- Event 推送：状态/权限事件本机 P95 < 250ms。
- Text Delta 批处理窗口：50–100ms。
- 默认同时运行 Node：4；同 Provider 和同仓库进一步限流。
- SQLite Busy Timeout：5s，所有写入只在 Company Runtime 单进程发生。
- 原始 Evidence 采用文件分片，不将无限日志写入单个 SQLite Row。

## 25. 可观测性与诊断

Company Runtime 输出结构化本地日志，但不记录敏感 Payload：

- `commandId`, `runId`, `nodeRunId`, `sessionId`, `eventId`
- Command 延迟、SQLite 事务延迟、Outbox Lag
- Scheduler Queue、活动 Lease、Provider 并发
- Agent/Sandbox 启动和退出结果
- Event Adapter 错误计数

Settings/Diagnostics 页面提供：

- Runtime、SQLite、Provider、Sandbox、ACP、AG-UI 状态。
- 最近失败和 Recovery Evidence。
- Event Outbox 积压与最后 Cursor。
- 数据库完整性检查和备份动作。
- 可脱敏导出的诊断包。

## 26. 主要风险与控制

| 风险                        | 控制方式                                                 |
| --------------------------- | -------------------------------------------------------- |
| 新 Pipeline Engine 范围膨胀 | 封闭节点类型；不实现通用脚本、循环和插件 SDK             |
| SQLite 与文件内容不一致     | 原子文件写 + 事务登记 + 孤儿清理 + Hash 校验             |
| Runtime 与 Agent 子进程泄漏 | Supervisor、Lease、AbortSignal、退出回收                 |
| RuntimeEvent 体积持续增长   | Text 压缩、Raw Evidence 文件化、保留策略                 |
| ACP 绕过 Desktop 权限       | 同一 Company Runtime、Permission Policy 和 Audit         |
| 并行 Agent 修改冲突         | Worktree/Sandbox 隔离、Join/Review 合并                  |
| Provider Session 不可恢复   | 能力协商；不支持时创建新 Attempt 并保留原证据            |
| 旧 Board 逻辑污染新领域模型 | 仅通过 Execution Adapter 复用行为，不复用 Store/页面状态 |
| Electron 主进程阻塞         | Agent、SQLite 调度和协议处理位于 Company Runtime 子进程  |
| Topic 扩展导致 v1 过度设计  | 只保留 ID/Participant/预算字段，不实现 Topic Scheduler   |

## 27. 实施完成定义

技术实现达到 v1.0 完成标准时，必须满足：

1. Company Runtime 是 Company SQLite 的唯一写者。
2. Renderer 不直接访问文件系统、SQLite、Agent 或 Sandbox。
3. 用户可创建 Department、Position、AI Member 和版本化 Pipeline。
4. 软件开发部门模板可完成一次真实交付。
5. 所有 Run 绑定不可变 Snapshot Revision。
6. 并行同仓库 Node 使用独立 Worktree/隔离 Sandbox。
7. Run、Node、Approval、Permission、Artifact 和 Session 有统一审计。
8. Artifact Version 具备 Hash、Producer 和 Lineage。
9. Renderer 可通过 AG-UI 实时显示并断线补发。
10. 外部 ACP Client 连接同一 Runtime 并遵守同一权限规则。
11. Consultation 不能直接生成正式 Artifact。
12. Runtime 或 Renderer 崩溃后，Run 可被安全识别并恢复。
13. 中英文系统 UI 完整，领域 ID 和事件契约不依赖语言。
14. 旧固定阶段 Desktop 和 Board 数据不迁移、不双写。

## 28. 后续文档与实施拆分

进入编码前再从本方案拆出：

1. SQLite Schema 与 Migration 规格。
2. Pipeline Graph JSON Schema 与校验错误码。
3. Pipeline Runtime 状态转换表。
4. Command/Query/Event TypeScript 契约。
5. AG-UI Custom Event 规格。
6. ACP stdio 与 Local IPC 规格。
7. 软件开发部门模板定义与 Node Handler 清单。
8. 分阶段 tracer-bullet tickets 和 Changesets。
