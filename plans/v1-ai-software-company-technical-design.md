# Sandcastle v1.0 AI 软件公司技术方案

## 文档状态

- 状态：Draft 3 最小修订，待 implementation-readiness 复审
- 版本：v1.0 Draft 3
- 日期：2026-07-23
- 对应产品方案：`plans/v1-ai-software-company-prd.md`
- 对应架构决策：`docs/adr/0028` 至 `docs/adr/0040`
- 产品形态：本地优先、单用户、Electron Desktop
- 数据策略：v1 使用新的 Company Directory，不迁移或双写旧 Desktop / Board 数据

本文把 PRD Draft 3 变成可实施的 Runtime、数据、状态、事件和测试契约。Draft 3 收敛了 Run formalization、Pipeline Handler、Gate promotion、Command/Cursor、ACP、执行隔离、Integration Generation 和恢复协议；它仍是设计文档，不授权本轮修改生产代码或开始 UI 实现。

## 1. 设计结论

Sandcastle v1 的控制面分为两个深模块：

1. **Company Runtime** 是本地唯一写者，拥有 Company Directory、命令幂等、权限、审计、Runtime Event Outbox、Interaction Session 和所有正式对象的持久化边界。
2. **Pipeline Runtime** 是 Company Runtime 内的状态转换权威，拥有 Department Run、Node Run、Node Attempt、Lease、依赖调度、自动推进、暂停、取消、恢复和质量门收敛。

Company Runtime 不把 Coordinator、Agent、Renderer 或 ACP 当作状态权威；Pipeline Runtime 不把 Agent 输出当作状态写入命令。所有外部入口都通过 Company Runtime Interface 发送 Command、读取 Query View、订阅带 Cursor 的 Runtime Event。

运行模型如下：

```text
Electron main / ACP facade / test driver
                    │ typed local IPC
                    ▼
             Company Runtime
       ┌────────────┼────────────┐
       │            │            │
  Catalog & Spec  Pipeline    Interaction
  Review/Quality  Runtime     Supervision
       │            │            │
       └────── Transaction Coordinator ──────┘
                    │
          SQLite state + audit + outbox
                    │
        files: snapshots, evidence, artifacts
                    │
      execution adapters: Agent/Sandbox/Worktree
```

### 1.1 不可违背的约束

- Product manager 在用户确认 Product Baseline 前是唯一产品入口；确认后 Delivery coordinator 才能编排下游。
- Requirement Confirmation 和 Human release decision 是硬门；中间节点自动推进，异常才暂停并升级。
- Product / Technical Review 必须执行“独立审查 → 有界讨论 → 方案修订 → 独立复核”。
- Project 可关联多个 Repository / Application；Project Spec 是共享目标，Application Spec 从属于它。
- 每个 Work Package 使用独立 branch、Worktree、Sandbox、Session、Node Run、Attempt 和 Artifact lineage。
- 独立 Code Review 通过前，变更不得进入对应仓库的 Integration branch。
- 用户可见交互必须在真实 Electron renderer + preload + Company Runtime 中测试；`ScriptedExecutionAdapter` / `ScriptedInteractionExecutionAdapter` 只替换执行 facts，不替换被测控制面。
- Security review 和 Operability review 始终存在，深度按风险分级。
- Agent 质量门只产生不可变 Delivery candidate；生产部署永不由 Agent 自动触发。
- Improvement proposal 只能由人工批准后改变后续 Harness、Spec、模板或 Skill Flow。

## 2. 范围、非目标和 ADR 约束

### 2.1 本轮技术目标

- 明确定义 Company Runtime / Pipeline Runtime 的模块接口、写权限和状态所有权。
- 建立 Product Baseline、Project Spec、Application Spec、Review、Work Package、Defect、Test、Security、Operability、Delivery 和 Improvement 的持久化模型。
- 让每个对象都能追溯到 Run、Snapshot Revision、Node Run、Attempt、Session、Participant、Artifact 和 Runtime Event。
- 为多仓库、跨应用契约、独立 Worktree、Integration branch、质量门、断线恢复和 Electron Fixture 提供实现边界。

### 2.2 非目标

- 不迁移、双写或兼容旧 Board Store 和旧固定阶段页面。
- 不在 v1 实现任意代码节点、无限循环、无限 Topic 群聊、远程控制面或公网 ACP。
- 不把 AG-UI、ACP、Renderer 或 Electron IPC 变成领域状态模型。
- 不暴露模型私有思维链；只保存结构化活动、证据、决策理由和可回放事件。
- 不自动改变目标、Snapshot、权限、Harness、Spec、模板、Skill Flow 或生产环境。

### 2.3 既有 ADR 的落实

| ADR  | 在本设计中的落实                                                                            |
| ---- | ------------------------------------------------------------------------------------------- |
| 0028 | Runtime Event 是唯一协议无关观察模型；AG-UI 和 ACP 是适配器。                               |
| 0029 | SQLite 保存公司元数据，文件保存 Snapshot、Artifact 和证据。                                 |
| 0030 | Company Runtime 是受 Electron 监管的独立单写者进程。                                        |
| 0031 | Pipeline 是封闭节点类型的版本化 DAG，Handler 通过 Adapter 注入。                            |
| 0032 | 当前状态、Runtime Audit Record 和 Event Outbox 同事务写入。                                 |
| 0033 | Run 只使用不可变 Run Configuration Snapshot Revision。                                      |
| 0034 | 并行仓库执行必须隔离 Worktree / Sandbox / Session；目标分支只由集成操作更新。               |
| 0035 | v1 从新 Company Directory 开始，不导入旧数据。                                              |
| 0036 | Pipeline Version 发布时冻结 Skill Flow Snapshot。                                           |
| 0037 | Node Attempt/standalone Turn 使用持久化 Execution Lease；过期不静默回队。                   |
| 0038 | Catalog 变更也写 Audit 和 Outbox，不能绕过统一观察模型。                                    |
| 0039 | Agent 使用稳定 Company Agent Adapter ID；凭证不进入 Snapshot。                              |
| 0040 | Software R&D 是 supervised multi-role production pipeline，角色、评审、隔离和人审职责分离。 |

本轮不新增 ADR；上述 ADR 已覆盖本设计中不可逆的进程、存储、事件、隔离和监督决策。

## 3. Runtime 模块边界

### 3.1 Company Runtime 与 Pipeline Runtime 的责任矩阵

| 能力                                         | Company Runtime        | Pipeline Runtime                 | 其他模块                        |
| -------------------------------------------- | ---------------------- | -------------------------------- | ------------------------------- |
| Company / Project / Repository / Application | 写入和版本校验         | 只读解析 Snapshot 输入           | Catalog / Spec Module           |
| Product proposal / Product Baseline          | 写入、确认硬门、审计   | 将已确认 Baseline 作为节点输入   | Product Discovery Handler       |
| Project / Application Spec                   | 版本化、冻结、契约校验 | Snapshot 引用                    | Spec Module                     |
| Pipeline Draft / Version                     | 写入、发布、Hash       | 读取已发布图                     | Catalog Module                  |
| Department Run / Node Run / Attempt          | 事务入口               | **唯一状态转换者**               | Scheduler / Node Handler        |
| Lease / Ready Queue / Join                   | 保存结果               | **Claim、续租、释放、过期收敛**  | Worker Supervisor               |
| Review / Finding / Discussion                | 持久化、权限和审计     | 根据结果推进或回退节点           | Review Module                   |
| Work Package / Integration                   | 保存版本和操作证据     | 调度开发、CR、集成节点           | Workspace / Integration Adapter |
| Test / Security / Operability                | 保存报告和证据         | 把 Gate 结果映射到状态           | Quality Gate Module             |
| Delivery candidate / Human release           | 候选不可变和人审记录   | 只有候选组装自动推进             | Delivery Module                 |
| Permission / Consultation / Intervention     | 命令授权、审计         | 应用暂停、Attempt、Revision 规则 | Interaction Module              |
| Runtime Event / Audit / Cursor               | 单事务写入和发布       | 产生领域状态变化意图             | AG-UI / ACP Adapter             |

### 3.2 深模块与外部接口

`CompanyRuntimeInterface` 是唯一进程外接口。它隐藏 SQLite 事务、状态转换、文件原子写、权限和重试复杂度；Renderer、ACP 和 transport-level client tests 都跨同一接口。

```ts
interface ActorRef {
  type:
    | "human"
    | "electron-main"
    | "acp-client"
    | "runtime-worker"
    | "test-driver";
  id: string;
  authenticatedBy: "local-session" | "ipc-token" | "acp-connection" | "runtime";
}

interface CommandEnvelope<TCommand extends CompanyCommand = CompanyCommand> {
  schemaVersion: number;
  commandId: string;
  actor: ActorRef;
  consumerId?: string; // trusted transport context; only consumer-scoped commands
  expectedRevision?: number; // command registry 声明的唯一 primary aggregate
  command: TCommand;
}

interface QueryEnvelope<TQuery extends CompanyQuery = CompanyQuery> {
  schemaVersion: number;
  requestId: string;
  principal: ActorRef;
  consumerId: string;
  query: TQuery;
}

interface QueryResult<TView> {
  view: TView;
  asOfSequence: number;
  viewSyncToken: string; // short-lived, consumer/query/view/sequence bound
}

interface CompanyRuntimeInterface {
  execute(envelope: CommandEnvelope): Promise<CommandResult>;
  query(envelope: QueryEnvelope): Promise<QueryResult<unknown>>;
  openSubscription(input: {
    principal: ActorRef;
    consumerId: string;
  }): Promise<{
    subscriptionId: string;
    subscriptionGeneration: number;
    barrierSequence: number;
  }>;
  readSubscription(input: {
    principal: ActorRef;
    subscriptionId: string;
    subscriptionGeneration: number;
    limit: number;
  }): Promise<{
    events: EventEnvelope[];
    nextSequence: number;
    hasMore: boolean;
  }>;
  closeSubscription(input: {
    principal: ActorRef;
    subscriptionId: string;
    subscriptionGeneration: number;
  }): Promise<void>;
}
```

约束：

- Command/Query 身份元数据只存在于统一 Envelope；Renderer payload 不能自报可信 actor、principal 或 consumer。Electron main、ACP connection、Runtime Worker 或测试 Fixture 在受认证边界注入并校验 `actor/principal/consumerId`，业务模块只能读取这些可信字段。`commandId` 由 caller-facing client/preload 每次用户意图生成一次；transport 透明重试必须复用它，语义上新的意图必须使用新 ID。
- 每个 Command kind 在 registry 中声明一个 primary mutable aggregate；Envelope 的 `expectedRevision` 只校验该对象，Command body 不再携带第二份 expected revision。没有 primary mutable aggregate 的 append-only Command 不传该字段。
- Query 只读；所有 Query 都在同一 SQLite read snapshot 中计算 `view` 与当时 Outbox 最大 sequence，并返回顶层 `{ view, asOfSequence, viewSyncToken }`。短期签名 token 包含随机 nonce，并绑定受信 transport 注入的 consumer/principal、query hash、view hash、sequence 和 expiry；Query 不写数据库，Ack 时才把 nonce/hash 唯一写入 consumed-token 表。它用于证明 Consumer 已用权威 View 覆盖之前事件；单个 View 不再各自定义另一份 sequence。
- `open/read/closeSubscription` 是 transport-neutral 的有界批读取协议；Subscription 只从服务端 durable acknowledged cursor 打开，并持有 generation、barrier/next/last-delivered sequence，调用者不能传 cursor/sequence 跳过事件。同一 Consumer 只允许一个 active generation；新 `open` 原子 supersede 旧 generation，旧 handle 的 `read/close` 返回 `SUBSCRIPTION_SUPERSEDED` 且不能影响新流。Runtime 内部 client 可以包装成 `AsyncIterable`，但该类型不跨 `contextBridge`。权威订阅不接受服务端过滤，AG-UI、ACP 和 Renderer 在各自 Adapter 中按 scope 过滤，避免全局 sequence 因隐藏事件形成不可确认的 gap。
- Cursor acknowledgment 通过统一 `execute({ command: { kind: "ack-runtime-events", sequence, subscriptionGeneration?, viewSyncToken? }, ... })` 完成；consumer 只取 Envelope 中由 transport 注入的 `consumerId`，业务 body 出现该字段即拒绝。普通 Ack 必须携带当前 active generation且不能超过该 generation 的 last delivered；带有效 token 的 View sync Ack 不携带 generation，它先原子 supersede 旧 generation，再 rebase 到该 `asOfSequence`。Ack 只在同一事务更新 Cursor/Audit，不写 Outbox。
- Event Subscription 至少一次交付；消费者用 `eventId` 去重并只 Ack 已连续应用的全局 sequence，不能把内存广播当作事实来源。
- Subscription handle 绑定已认证 principal 与 consumer owner；`read/close` 若调用者不匹配则拒绝，Client 不能用猜测的 ID 读取其他消费者事件。
- IPC、preload 和 ACP 共用这组 discriminated schema，通过一个 typed request tunnel 传输；现有逐 channel 方法只能作为迁移期兼容 Adapter，不能继续扩张为第二套接口。
- 进程外不暴露 SQL、任意文件写入、child process、Agent Provider 或 Sandbox Provider。
- 运行错误使用稳定错误码；本地化只存在于 Renderer。

### 3.3 内部模块

```text
Company Runtime
├─ Catalog Module                 Company / Department / Position / Agent / Skill
├─ Spec Module                    Product Baseline / Project Spec / Application Spec
├─ Pipeline Runtime               DAG / Run / Node / Attempt / Lease / Gate transition
├─ Review Module                  Topic / Participant / Finding / bounded discussion
├─ Workspace & Integration        Work Package / Worktree / Sandbox / branch / merge
├─ Quality Gate Module            CR / Test / Security / Operability / Defect
├─ Delivery Module                Candidate / Human release / export seam
├─ Interaction Module             Session / Participant / Permission / Intervention
├─ Memory Module                  candidate / review / human promotion / Snapshot selection
├─ Artifact Registry              immutable versions / content / lineage
├─ Statistics Module              metrics / Improvement proposal, no hidden mutation
└─ Event & Transaction Coordinator state + audit + outbox in one SQLite transaction
```

每个模块保留小的外部 Interface；SQLite、filesystem、Agent/Sandbox 和 test fake 是 Adapter。模块内部可以有更多测试 Seam，但不把这些 Seam 暴露成新的公共状态入口。

### 3.4 进程和生命周期

Runtime lifecycle 是 `booting → ready → draining → stopped`，异常进入 `diagnostic | failed`：

1. Electron 选择或创建 Company Directory，生成一次性本地 IPC Token；Runtime 在 `booting` 时拒绝业务写入。
2. Company Runtime 获取目录锁，打开 SQLite，执行迁移、`quick_check`、Artifact journal reconcile 和事件 outbox/cursor 健康检查；全部通过后才进入 `ready`。
3. Runtime `ready` 后才加载 Renderer；Renderer 重载不影响 Runtime、Scheduler 或活动 Agent。
4. Electron 关闭时把 Runtime 置为 `draining`：拒绝新的执行 Command，允许 Query、Ack、pause/cancel 和诊断；停止新 Claim，要求活动 Worker checkpoint/cancel，并等待受限 grace period。
5. grace period 内完成的 Worker 正常提交；未证明终止的 Node Attempt 按 17.2 进入 `reconciling` 并保留 Lease/operation evidence，已确认停止的才标记 `interrupted`；未绑定 Node 的 Interaction Turn 按 operation key cancel/reconcile。两者都不能假装释放后可直接重跑。之后关闭订阅、checkpoint WAL、释放目录锁并进入 `stopped`。
6. Runtime 崩溃后最多自动重启一次；未完成 Lease 按 17.2 和 17.4 的恢复规则收敛，绝不因重启而偷偷复制副作用。
7. SQLite 无法打开或迁移失败时进入 `diagnostic`：只在旧 schema reader 明确兼容时开放只读 health/diagnostic Query；不启动写入、订阅或 Agent Worker。`RuntimeHealthView` 至少返回 lifecycle、schema/reader 版本、directory lock、quick check、journal/outbox/cursor 状态、restart count 和 safe remediation。

## 4. 存储、目录和事务

### 4.1 Company Directory

```text
<company-directory>/
├─ .sandcastle/
│  ├─ company.sqlite
│  ├─ company.sqlite-wal
│  ├─ snapshots/<run-id>/r<revision>.json
│  ├─ evidence/<run-id>/<node-run-id>/<attempt-id>/
│  ├─ artifacts/<project-id>/<artifact-id>/v<version>/
│  ├─ runtime/runtime.lock
│  ├─ runtime/runtime.sock              # Windows 使用 Named Pipe
│  └─ backups/
└─ projects/<project-id>/               # 仅公司拥有的文档和导出物
```

Repository source 不复制到 Company Directory；只存 Repository Reference、Application Reference、基线 commit、Worktree 位置和外部 Artifact 引用。Work Package Worktree 使用该 Repository 的 `<repository-root>/.sandcastle/worktrees/<allocation-id>`；测试也在临时 Repository 内使用同一相对布局。Sandbox 内部临时目录不是 Worktree，不能登记为 Worktree 同义词。

### 4.2 SQLite 事务规则

每个正式 Command 由 Event & Transaction Coordinator 建立一个 Unit of Work。同步状态变化在一个 SQLite 事务中完成：

1. 在事务外先认证 transport principal、验证 Envelope/schema，注入可信 actor/consumer context，并 canonicalize `schemaVersion + actor/context + expectedRevision + command body` 得到 request hash；无效认证/畸形 schema 不创建 receipt。
2. 事务内首先按 `commandId` 查 receipt，早于 permission、当前 revision 和业务状态校验：同 actor/context/hash 的 `completed` 直接重放原 `CommandResult`/error 和 effect IDs；hash 不同返回 `COMMAND_ID_REUSE`；同进程 in-flight reservation 返回 `COMMAND_IN_PROGRESS`。
3. 仅对新 command 按 registry 解析 primary aggregate，验证权限、Envelope `expectedRevision` 和当前状态；Command body 中出现平行 expected-revision 字段即 deterministic rejection。
4. 设置事务内 `runtime_unit_of_work_context`（commandId、actor、schemaVersion），更新状态或插入不可变版本。
5. 追加 Runtime Audit Record；ADR 0038 覆盖的 Catalog 表只由 ID-only trigger 写 Audit，Coordinator 不重复写。
6. 追加协议无关 Runtime Event 到 Outbox；同一批 Catalog trigger 同时负责对应 ID-only Event，Coordinator 不重复写第二条。
7. 持久化完整的 success 或 deterministic business-rejection `CommandResult`、result hash 和 effect/operation IDs，把 receipt 标记为 `completed`。认证/schema 错误与 `STORE_BUSY`/事务崩溃等瞬态失败不写 completed receipt。
8. 清除 Unit of Work context，Commit 后才通知外部订阅者；事务回滚不留下可见 `processing` row。

启动 Agent、Sandbox、Integration 或长时 Test 的 Command 只在上述事务中接受工作并返回持久化 operation/Attempt ID，同时把该接受结果标为 `completed`；Worker facts、heartbeat、checkpoint 和完成使用后续 Unit of Work。`processing` 只是一条未提交事务或同进程 in-flight reservation，不作为崩溃后可见状态。

`ack-runtime-events` 是唯一不写 Runtime Event Outbox 的正式 Command；它仍校验 actor/consumer ownership、写 Audit 和 dedup result。Catalog trigger 使用 Unit of Work context 补齐 actor/commandId，但继续只保存 ADR 0038 要求的 ID-only before/after payload。

需要创建 immutable Snapshot 文件的 Command 可以在事务前把 canonical bytes 写入与 final path 同一文件系统的受控 temp path 并 `fsync`，但该文件不是领域状态。最终 Unit of Work 必须重新校验所有 source revisions/hash，在 commit 前完成 temp→final rename 和父目录 `fsync`，再原子插入 Baseline/Run/Snapshot 元数据；事务失败时 final/temp 都是按 commandId/hash 可识别的 orphan。数据库中不能出现引用未落盘 Snapshot 的 Run。

Snapshot 启动恢复只扫描受控命名空间：有 DB 引用的文件必须 hash 匹配；无 DB 引用但与重试的 commandId/hash 完全相同的 final 可幂等复用，其他 orphan 隔离后删除，不根据文件名补写领域 row。Windows 或其他平台若 final 已存在，hash 相同视为既有结果，hash 不同返回 `SNAPSHOT_INTEGRITY_FAILED` 并保留冲突证据；不得覆盖未知目标。

Artifact 使用可恢复 journal，而不是声称文件系统与 SQLite 原子：

1. 事务插入 `artifact_write_journal(prepared)`，冻结 logical producer、expected hash、受控 temp/final path。
2. 写 temp、`fsync` 文件，更新 journal 为 `written`；原子 rename 后 `fsync` 父目录并标记 `renamed`。
3. finalize 事务校验 final path/hash，插入 Artifact Version/lineage/audit/outbox，并把 journal 标记 `finalized`；只有此时 Artifact 对 Query 和质量门可见。
4. 启动 reconcile 按 journal 恢复或隔离 `prepared/written/renamed` 项；未知 temp 只在受控前缀内作为 orphan 处理。数据库不得出现 `ready` 但文件缺失的 Artifact；校验失败进入 `artifact-integrity-failed` 并保留证据。

### 4.3 Schema 与迁移

- Company v1 schema 使用递增 `schema_version`，迁移脚本只前进、不修改历史迁移。
- 每次迁移在备份点后事务执行；文件布局变更有独立 migration journal。
- Runtime 拒绝打开高于自身版本的数据库；低版本先迁移，失败进入只读诊断。
- 领域对象的 `schemaVersion` 与 SQLite schema 独立。历史 Snapshot、Event Payload、Test Fixture 使用自己的 reader。
- Event Payload 只允许向后兼容字段添加；删除字段需要新 event type 或新 `schemaVersion`。
- v1 不为旧 Board Store 做 migration adapter；旧目录保持可由旧产品读取。

## 5. 持久化数据模型

### 5.1 ID、修订和不可变性

- 领域 ID 使用 UUIDv7 或等价的时间有序 ID；展示版本与稳定 ID 分离。
- 每个实体都有 `id`, `createdAt`, `updatedAt`（不可变实体的 `updatedAt` 只用于索引）和 `revision`。
- 可变对象更新携带 `expectedRevision`；冲突返回 `VERSION_CONFLICT`。
- 生产证据使用 `(companyId, projectId?, runId?, snapshotRevisionId?, nodeRunId?, nodeAttemptId?, workPackageId?, integrationGenerationId?, deliveryCandidateInputId?, sessionId?, interactionTurnId?, artifactVersionId?)` 作为 lineage context。
- Revision、Snapshot Revision、Node Attempt、Session 和 Artifact Version 是追加式对象；旧版本永不覆盖。
- 删除采用 archive / supersede；历史 Run 引用的对象不可物理删除。

### 5.2 公司、项目和规格表

| 表                             | 关键字段和不变量                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companies`                    | `id`, locale, directory fingerprint；v1 每个 Runtime 只打开一个 Company。                                                                                                                          |
| `projects`                     | `id`, goal, status, sharedContext, revision；Project 是交付对象而非 Repository。                                                                                                                   |
| `repository_references`        | provider/path/url、default branch、revision policy、dirty policy、capabilities。                                                                                                                   |
| `application_references`       | `id`, projectId, repositoryReferenceId, applicationKey, ownership, build/test commands。                                                                                                           |
| `product_proposals`            | 对话输入、开放问题、风险、验收候选、producer Session、proposal revision。                                                                                                                          |
| `product_baselines`            | 确认后的目标、范围、非目标、用户、验收、约束、风险、unique source proposal revision、confirmedBy/confirmedAt/confirmationCommandId、content hash；不可变。                                         |
| `project_specs`                | Project-level outcome、acceptance、application map、cross-app contracts、delivery constraints。                                                                                                    |
| `application_specs`            | applicationId、parentProjectSpecId、design、local acceptance、work package map、integration duties。                                                                                               |
| `spec_revisions`               | Spec kind/id、revision、content hash、supersedes、author Session、review result。                                                                                                                  |
| `technical_baseline_proposals` | immutable proposal revision/hash，包含 Project/Application Spec revisions、readiness、architecture/dependency graph、contracts、risk/permission/test strategy；是 Technical Review 的 exact 输入。 |
| `technical_baselines`          | 从通过的 proposal 物化出的 accepted manifest、proposal hash、acceptance Gate Result ID、canonical manifest hash；不可变。Gate Result 绑定 proposal hash，不反向哈希 accepted baseline。            |
| `gate_promotions`              | run、source/target Snapshot Revision、Gate Result、promoted refs/hash、actor/commandId；`(runId, gateResultId)` 唯一且只接受 `PASS`。                                                              |
| `cross_application_contracts`  | producer/consumer application、API/data/event schema、compatibility policy、test commands。                                                                                                        |
| `repository_readiness_checks`  | repository/application revision、clean state、branch/worktree capability、commands、blockers、evidence。                                                                                           |

Project Spec 可以有多个 Application Spec，但 Application Spec 必须引用一个 Project Spec revision 和所有适用跨应用契约；不能自行改写 Project goal。

### 5.3 Company 配置和 Harness

| 表                                        | 关键字段和不变量                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `departments`, `positions`, `ai_members`  | 角色职责、允许动作、稳定 AI member 身份；Position 与 AI member v1 为 1:1。                                                         |
| `harnesses`, `harness_revisions`          | principles、constitution、rules、positive/negative examples、impact scope、status。                                                |
| `skill_flows`, `pipeline_skill_snapshots` | Pipeline publish 时冻结 Skill ID、fingerprint、instructions 和顺序。                                                               |
| `execution_profiles`                      | Company Agent Adapter ID、model、Sandbox provider、branch strategy、limits/retry/permission/Secret References，不含 secret value。 |
| `pipeline_drafts`, `pipeline_versions`    | Draft 可变；Version 带 canonical hash、handler registry version/hash 和 Pipeline Skill Snapshot refs，发布后不可变。               |
| `harness_snapshots`                       | Run-scoped Harness revision/fingerprint/selection；与 Run Snapshot Revision 一起固定。                                             |
| `run_skill_snapshots`                     | Run-scoped resolved refs，引用 Pipeline Skill Snapshot 并冻结该 Run 的 applicability/selection；不复制或修改已发布 Skill Flow。    |

`harness_snapshots` 不是第二套 Harness；它只记录某次 Run 实际使用的 revision 和 applicability，支持历史复现。

Skill source 遵循 ADR 0039，不复制进 Runtime。Run formalization 与每次新 Node Attempt 都必须解析 selected Skill sources 并核对 fingerprint；源缺失或漂移返回 `SKILL_VERSION_UNAVAILABLE`，使 Node/Run blocked。历史 Snapshot 仍可审计，但不能用当前同名 Skill 静默重放。

### 5.4 Run、Node、Session 和权限表

| 表                                              | 关键字段和不变量                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `department_runs`                               | project/department、status、activeSnapshotRevision、parentRun/fork source、run revision；只引用 confirmed Product Baseline，并由 confirmation 或 explicit fork 与 r1 原子创建。                                                                              |
| `run_snapshot_revisions`                        | run、revision、parent、reason（initial/gate-promotion/recovery/fork）、payload path/hash、pipeline/handler registry/spec/harness/run-skill/memory/artifact refs、Execution Profile。                                                                         |
| `node_runs`                                     | frozen node id/nodeType/exact handler kind version/schema hashes、dependencies、status、active attempt、result summary。Pipeline Runtime 是唯一写者。                                                                                                        |
| `node_attempts`                                 | nodeRun、attempt number、snapshot revision、reason、status、checkpoint、execution operation key、failure evidence。                                                                                                                                          |
| `execution_leases`                              | target kind/id（Node Attempt 或 standalone Interaction Turn）、kind execution/reconciliation、lease id、epoch/fence token、worker、operation key、issued/expires/renewed/released、cancel requested；同 target/operation 跨 kind 同时最多一个 active owner。 |
| `execution_facts`                               | operation key、target、lease kind/id/epoch/fence token、factId/ordinal、canonical payload hash、kind/schema、payload/evidence、accepted/duplicate/stale/conflict 和处理 result refs；append-only。                                                           |
| `continuation_plans`, `continuation_plan_items` | source/target Run+Snapshot、expected Run revision、changed refs/invalidated closure、per Node/Gate `rerun/reuse-evidence/skip/blocked`、Artifact provenance、budget、status；append-only。                                                                   |
| `interaction_sessions`                          | Runtime-owned stable Session、mode、AI member、optional provider Agent Session ref、run/node/topic context、parent Interaction Session。                                                                                                                     |
| `interaction_turns`                             | session、input message、status queued/running/reconciling/completed/failed/cancelled/interrupted、commandId/operation key、provider execution ref、Node Attempt ref（正式协作时）、standalone Turn lease refs、output/event range。                          |
| `session_participants`                          | Session/Topic participant、role、scope、moderator flag、input visibility。                                                                                                                                                                                   |
| `session_messages`                              | participant、kind、content ref、runtime event range、redaction state。                                                                                                                                                                                       |
| `permission_requests`, `permission_decisions`   | Tool/execution scope、policy snapshot、decision actor、expiry、evidence；只处理能力授权。                                                                                                                                                                    |
| `node_approval_requests`                        | human-approval Node、Snapshot、exact input manifest/hash、requested action、status pending/decided/expired/cancelled、expiry。                                                                                                                               |
| `node_approval_decisions`                       | request、verified human、approved/rejected/changes-requested、feedback、timestamp、decision command；每个 request 最多一个。                                                                                                                                 |
| `governed_interventions`                        | actor、target run/node/session、reason、feedback、pause/attempt/revision outcome。                                                                                                                                                                           |
| `command_deduplication`                         | commandId、verified actor/consumer context、request hash、completed success/rejection result/hash、effect/operation IDs、completedAt；未提交 processing 不可见。                                                                                             |

### 5.5 Review、Work Package 和 Defect 表

| 表                          | 关键字段和不变量                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_topics`             | kind product/technical/code/aggregate/verification、scope artifact refs、criteria、budget、maxRounds、stop condition、owner、moderator、status。                                                                                                                       |
| `review_participants`       | topic、participant role owner-participant/reviewer-participant/moderator、AI member/position、independent Session、reviewed producer IDs、input visibility、reviewer capability、eligibility snapshot/result；只有 eligible reviewer-participant 可提交 finding/投票。 |
| `independent_findings`      | finding ID、participant、severity、evidence refs、rationale、disposition、recheck status；讨论前不可合并。                                                                                                                                                             |
| `review_discussions`        | topic、round、conflict finding IDs、bounded prompt, moderator action, budget usage, stop reason。                                                                                                                                                                      |
| `review_revisions`          | revised proposal/spec/diff、owner Session、input finding IDs、content hash。                                                                                                                                                                                           |
| `review_rechecks`           | fresh Session/eligibility snapshot、limited exact input manifest、finding disposition、result PASS/CONDITIONAL_PASS/FAIL。                                                                                                                                             |
| `work_packages`             | stable package identity、project/application scope、current version/status/owner.                                                                                                                                                                                      |
| `work_package_versions`     | goal、acceptance、dependency refs、module scope、permissions、Spec/Harness refs、expected artifacts、integration conditions。                                                                                                                                          |
| `work_package_dependencies` | predecessor package/version, dependency kind artifact/commit/contract/readiness, edge status。                                                                                                                                                                         |
| `work_package_assignments`  | AI member/position、assignment decision、attempt context、dispatch time。                                                                                                                                                                                              |
| `workspace_allocations`     | Work Package Version/Attempt、operation key、state planned/provisioning/ready/failed/cleaned、resolved branch strategy/source branch/base commit、Worktree、Interaction Session、planned provider/capabilities、later Sandbox/Agent Session refs、cleanup evidence。   |
| `integration_generations`   | run、generation number、manifest hash、per-repository base/source set、status assembling/passed/failed/superseded；不可变输入。                                                                                                                                        |
| `integration_operations`    | generation/repository、operation/idempotency key、canonical payload hash、source commit、expected Integration tip、state intent/running/succeeded/failed/unknown、provider/Git receipt、conflict/reconcile evidence。                                                  |
| `defects`                   | kind review/test/integration/security/operability/readiness、severity、evidence、owner package/node、status、rework link。                                                                                                                                             |
| `defect_links`              | defect to finding/test/artifact/event/commit and affected revision。                                                                                                                                                                                                   |

### 5.6 Quality、Delivery 和 Improvement 表

| 表                                                        | 关键字段和不变量                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_cases`, `test_case_revisions`                       | requirement/package coverage、preconditions、UI actions、Runtime assertions、fixtures、evidence policy。                                                                                             |
| `test_runs`, `test_run_cases`                             | build/source revision、temporary Company Directory、Execution Profile、fixture id、case result、status。                                                                                             |
| `test_evidence`                                           | UI screenshot/action trace、Runtime payload range、logs、environment fingerprint、correlation ids。                                                                                                  |
| `security_reviews`, `operability_reviews`                 | risk tier、depth、scope manifest、findings、result、reviewer Session。                                                                                                                               |
| `quality_gate_results`                                    | kind/scope、QualityGateInputManifest ref/hash、result PASS/CONDITIONAL_PASS/FAIL、conditions、final recheck/evidence refs；不可变。                                                                  |
| `delivery_candidate_inputs`                               | immutable pre-candidate scope/hash：Integration Generation、per-repository commits、Artifact/contract/test refs、risk summary；Security/Operability 等最终 Gate 绑定它，避免引用未创建的 Candidate。 |
| `delivery_candidates`                                     | candidate hash、Candidate Input、approved artifact versions、all PASS Gate refs、evidence manifest；不可变且不保存 release decision 状态。                                                           |
| `delivery_candidate_items`                                | candidate to Work Package, Review, Test, Security, Operability, Artifact and contract evidence.                                                                                                      |
| `human_release_decisions`                                 | human actor、candidate hash、decision accepted/rejected/changes-requested、comment、timestamp；每个 candidate 最多一个且不可修改。                                                                   |
| `release_operations`                                      | kind merge/export、accepted decision、canonical input hash、operation id、destination preconditions、per-item result/receipt、failure/reconcile evidence；独立授权且幂等。                           |
| `memory_candidates`, `memory_candidate_revisions`         | scope project/ai-member、exact source evidence refs、redacted content/hash、producer、status projection；revision append-only。                                                                      |
| `memory_decisions`, `memory_entries`                      | exact candidate revision/hash、independent review evidence、verified human accept/reject；accepted entry immutable and scope-bound。                                                                 |
| `run_memory_selections`                                   | Snapshot Revision to accepted Memory Entry revisions actually loaded；selection reason/policy hash，不解析 live “latest”。                                                                           |
| `statistics_rollups`                                      | dimensions Project/Department/AI member/Model/Repository/Package/Pipeline and metric windows.                                                                                                        |
| `improvement_proposals`, `improvement_proposal_revisions` | stable proposal identity + append-only evidence/root-cause/change/impact/validation/rollback revisions。                                                                                             |
| `improvement_decisions`                                   | exact proposal revision/hash、human actor、approved/rejected、timestamp；append-only，不能作为 proposal mutable status。                                                                             |
| `improvement_application_operations`                      | approved decision/revision、target config revision、operation id、result/applied refs、validation evidence、rollback revision。                                                                      |

### 5.7 审计、事件和 Artifact 表

| 表                               | 关键字段和不变量                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts`, `artifact_versions` | type/schemaVersion、content kind managed-file/repository-object/external-reference、immutable identity/integrity descriptor、producer context、status。 |
| `artifact_links`                 | `derived-from`, `consumed-by`, `produced-by`, `supersedes`, `evidence-for`, `blocks`。                                                                  |
| `artifact_write_journal`         | logical producer、expected hash、temp/final path、prepared/written/renamed/finalized/failed、reconcile evidence。                                       |
| `runtime_unit_of_work_context`   | transaction-scoped commandId、verified actor、schemaVersion；事务外必须为空，Catalog triggers 只读。                                                    |
| `runtime_audit_records`          | entity、before/after、actor、commandId、timestamp；不可变。                                                                                             |
| `runtime_event_outbox`           | global sequence、eventId、type、scope ids、registry/payload schema version、createdAt；没有全局 delivered 状态。                                        |
| `runtime_event_cursors`          | consumer id、owner principal、active subscription generation、last acknowledged/delivered sequence、last seen、expiry/retiredAt。                       |
| `consumed_view_sync_tokens`      | signed token nonce/hash、consumer/principal、sequence、expiry、consumed command；Ack 时唯一插入，过期后安全清理。                                       |
| `run_record_refs`                | Run/Node/Attempt/Session 到 transcript、structured rationale、tool result、usage、failure evidence。                                                    |

## 6. Lineage、Snapshot 和 Artifact

### 6.1 统一 lineage

正式对象都通过 `lineage_edges` 或等价的专用 link 表连接：

```text
Product Baseline
      │ derives
Project Spec revision ── refines ── Application Spec revision
      │                                  │
      └────────────── frozen by ─────────┘
               Run Snapshot Revision
                       │
      Node Run ── Node Attempt ── Session / Participant
           │             │                  │
     Work Package    Worktree/Sandbox     Runtime Events
           │             │                  │
       Commit/Diff ── Integration ── Test/Security/Operability
           │                                  │
           └──────────── Delivery Candidate ┘
```

每个 Artifact Version、Review finding、Defect、Test evidence、Security/Operability result 和 Delivery candidate 至少记录：

- producer / owner AI member、Position 和 Session；
- Project、Department Run、Snapshot Revision、Node Run、Node Attempt；
- 输入 Artifact Version、Spec/Harness Snapshot 和相关 Work Package；
- content hash、inspectable location、创建事件 sequence；
- supersedes / derived-from / evidence-for 关系。

### 6.2 Run Snapshot Revision

所有正式 Department Run 都通过同一个内部 `formalize-run` Unit of Work 与 `r1` 原子创建，不存在无 Snapshot Run，也不由 `start` 再次 formalize。外部只有两个入口：

- `confirm-product-baseline`：把 exact Product Proposal 确认为新的 Product Baseline，并创建使用它的 root Run；若请求带 immutable `forkSourceRunId/forkSourceSnapshotRevisionId`，则同时创建替换旧 Baseline 的 child Run。
- `fork-department-run`：复用既有 confirmed Product Baseline，从 chosen source Snapshot 创建 child Run。`mode=replay` 精确复制其 immutable payload；`mode=reconfigure` 只允许显式改变 Repository scope、Pipeline Version、Harness/Execution selection，并丢弃受影响的 downstream promotions，使新 Run 从仍有效的最早 Gate 重新执行。目标或验收变化不允许走此命令。

Root/reconfigure `r1` 捕获 Pipeline Version、Product Baseline、Harness Snapshot、Position/AI member、Run Skill Snapshot、selected Memory Entry revisions、handler registry version/hash、Execution Profile、Permission Policy、已有输入 Artifact Version 和质量门策略；replay `r1` 另保留 chosen Snapshot 中 hash 仍匹配的 promoted refs，reconfigure 则移除受 override 影响的 refs。后续只有 `PASS` 的 Gate Result 可以通过 `gate-promotion` 创建新的不可变 Snapshot Revision（`r2`, `r3`…），把已接受的 Project Spec、readiness、Application Specs 或 Technical Baseline refs 加入下一阶段输入；它不是对旧 Snapshot 的修改，也不是普通 Retry/Recovery Attempt。Product manager 的 pre-run intake 不创建 Department Run、Node Run 或 Snapshot。

允许的 Recovery Override 只能改变 Company Agent Adapter、model、Sandbox provider、limits、retry budget 或经策略允许的 Secret Reference。目标/验收变化必须由新 Baseline confirmation 创建 child Run；Repository scope/Pipeline graph 变化使用 `fork-department-run(mode=reconfigure)`。审批与 Gate Result 不能被 Recovery/Fork 改写：不同结论必须绑定新 input 并 fresh review，replay 只能保留 hash 仍完全匹配的既有结果。通过质量门正式接纳新的 Spec/readiness/Technical Baseline Artifact 时使用 `gate-promotion` Revision；Recovery Override 使用 `recovery` Revision。

所有新 Revision：

1. 复制父 Revision 的 canonical payload；
2. 记录字段级 diff、actor、reason、唯一 `gateResultId`（适用时）、promoted refs/hash 和 parent hash；
3. 生成新 hash 和新文件；
4. 只对后续 Node Attempt 生效；历史 Attempt 继续引用父 Revision。

同一 `(runId, gateResultId)` 只能产生一个 target Revision；重复 promotion 返回原结果。`CONDITIONAL_PASS`、`FAIL`、已 supersede 的 input manifest 或与当前父 Revision 不匹配的 Gate Result 都不能 promotion。

`confirm-product-baseline`、`fork-department-run`、`gate-promotion` 和 `recovery` 都使用 4.2 的 Snapshot staging protocol：canonical payload 先写 temp，最终事务重新验证输入、rename+directory fsync，并同时提交 Snapshot row、Run/active revision state、Audit、Outbox 和 dedup result。Crash 只能留下无 DB 引用的 orphan 文件，不能留下无 payload 的 visible Revision。

`gate-promotion` 的 primary aggregate 是 `runId`；Command body 只接受 `runId + parentSnapshotRevisionId + gateResultId`，Run revision 只来自 Envelope `expectedRevision`。Promoted Artifact/Spec/readiness refs 和 hash 必须由 Runtime 从 immutable Gate Result/input manifest 推导，不能由调用者另传一份可漂移列表；Technical scope 在同一 Unit of Work 物化 accepted Technical Baseline 后再写 target Snapshot。

Fork 与 Recovery 不能在执行时临时猜测“从哪里继续”。对应 Command 必须以 Envelope Run revision 串行化，并在创建 target Run/Snapshot Revision 的同一 Unit of Work 写 immutable `ContinuationPlan`：

1. 比较 source/target Snapshot、Handler schema 和 Artifact Contracts，计算 changed refs 及 dependency invalidation closure。
2. 每个 Node/Gate item 固定 `rerun | reuse-evidence | skip | blocked`、理由、source evidence/input hash、target Node/Attempt、budget/retry scope。`reuse-evidence` 只允许 immutable output 的 exact producer Handler/schema/input hash 全匹配；child Run 创建新 Node Run 并标记 `succeeded(resultOrigin=reused)`，引用 source lineage而不复制 mutable state。
3. Same-Run Recovery 保留既有 succeeded Node，只为 plan 指定的 failed/interrupted Node 创建新 Attempt；尚未开始的 invalidated descendants 回到 queued。Fork 为 target graph 创建新 Node identities；`skip` 只用于 target graph 明确不选择的 branch，不可冒充 reuse。
4. 同一 Run revision 最多一个 active plan；多个失败节点必须被同一 plan 显式覆盖或后续 Command 因 revision conflict 重算。Plan `blocked` 项、缺失 evidence 或 budget ambiguity 阻止 Start/Claim。

### 6.3 Artifact 原子性

Artifact Version 使用 discriminated content kind：

- `managed-file`：Company Directory 管理的 bytes，按 4.2 `artifact_write_journal` 执行 prepared→written→renamed→finalized；identity 是 content hash/size/controlled path。
- `repository-object`：固定 Repository reference、object kind 和 immutable Git object ID（commit/tree/blob/tag）并验证可读取；branch/Worktree 只能作为 locator，必须解析到 exact object ID 才能成为版本。
- `external-reference`：固定 provider/namespace/object ID、provider version/etag/digest、redacted retrieval ref 和 verification receipt。只有 provider 能按 immutable identity 查询并校验的对象可作为 Gate evidence；可变 preview URL、branch 或 “latest build” 只能是 non-authoritative locator。

每种 kind 都有 `verified | unavailable | failed` integrity projection 和专用 startup/on-read reconcile。只有 `finalized + verified` Artifact Version 可进入质量门；外部服务暂时不可用为 `unavailable` 并阻塞需要它的 Gate，identity/hash 不匹配为 `ARTIFACT_INTEGRITY_FAILED`。Registry 不把外部对象复制成本地文件，也不把未知文件名/URL 猜成 producer。

## 7. Product Baseline、Spec 和多仓库 Project

### 7.1 Product manager 到 Coordinator 的交接

Product manager 的 Product Discovery 是 Company Runtime 管理的 Project-scoped pre-run intake，不是已经拥有 Snapshot 的正式 Node Run。它只允许 Product manager 与用户形成 Product Proposal。用户明确 `confirm-product-baseline` Command 后，Company Runtime：

1. 验证开放问题、非目标、验收标准和风险字段完整；
2. 将 Proposal revision 固化为 Product Baseline；
3. 写 `product.baseline.confirmed` Audit/Event；
4. 创建正式 Department Run，生成 Snapshot Revision `r1`，并把后续 Pipeline 交给 Delivery coordinator；
5. 禁止 Product manager 在确认前创建正式 Department Run、Node Run 或 Work Package。

`confirm-product-baseline` 的 primary aggregate 是 Project；Command body 固定 `projectId`、exact proposal revision/hash、可选 immutable fork source、Department/Pipeline Version、Execution Profile、Harness/Skill selection policy、初始 Artifact refs 和质量门策略，Project revision 只来自 Envelope。Company Runtime 必须解析并验证这些引用后才写入；Software R&D Profile 还必须满足正式 Work Package 的 `branch` strategy。Adapter 当前不可用可以在 readiness/执行时阻塞，但引用不存在、Pipeline 未发布或 policy 不兼容会使 confirmation 整体失败。成功结果持久化并返回 `baselineId + runId + snapshotRevisionId(r1)`；`(projectId, proposalRevisionId, forkSourceSnapshotRevisionId?)` 唯一，重复 confirmation 只返回原结果。

`fork-department-run` 只接受 verified human 或明确授权的 Governed intervention；body 固定 source Run/Snapshot、existing Baseline、`replay | reconfigure` mode、显式 override diff 和 fork reason，`(sourceRunId, sourceSnapshotRevisionId, commandId)` 幂等创建 child Run/r1 + Continuation Plan，不复制任何 mutable Run/Node/Lease 状态。Reconfigure 必须记录 invalidated Gate Result/Snapshot refs，不能把旧 PASS 套到不同 input；Coordinator 不能自行替换 source 或 override。拒绝或变更只创建新的 Proposal revision；不能覆盖已确认 Baseline。Baseline 变更必须由新的 `confirm-product-baseline` 带 fork source 原子创建新 Baseline 与 child Run，不能先确认后补 Run。

### 7.2 Project Spec / Application Spec

- `project-spec` Handler 从 Product Baseline 生成 Project Spec draft，定义共享 outcome、项目级验收、Application 边界、跨应用 API/data/event contracts、交付约束和应用映射；它必须先存在，Product Review 才能开始。
- Product Review 只评审 Product Baseline 边界内的 Project Spec draft。若 finding 改变目标、范围、非目标或用户验收边界，不能“修订 Baseline”，必须回到新 Product Proposal、重新确认并 Fork 新 Run；仅分解和表述修订创建新的 Project Spec revision。
- Product Review 得到 `PASS` 后，Pipeline Runtime 创建一次 `gate-promotion`，固定 accepted Project Spec revision；`CONDITIONAL_PASS` 只能调度修订/验证 obligation，不能 promotion。
- Repository readiness 以 promoted Project Spec 和 `ReadinessGateInputManifest` 为输入；全部无 blocker 后产生绑定 exact manifest hash 的 `PASS` Gate Result，并用下一次 promotion 固定 readiness evidence。
- `technical-design` Handler 以 promoted Project Spec + readiness 为输入，生成 Application Spec drafts 与 immutable Technical Baseline Proposal revision。Application Spec 定义一个 Application 的架构、模块边界、局部验收、Work Package 分解约束、集成义务、测试入口和回滚约束，并引用适用 Project Spec revision 和 contract IDs。
- Technical Baseline Proposal 包含待接受的 Project/Application Spec revisions、readiness refs、architecture/dependency graph、cross-application contracts、risk/permission/test strategy 和 evidence refs；Technical Review 的 Gate Result 绑定其 exact proposal hash。
- Technical Review 对 Application Spec drafts 与 Technical Baseline Proposal 执行独立 finding、修订和 fresh re-review。最终 `PASS` 只产生绑定 proposal hash 的 Gate Result；随后的唯一 `gate-promotion` Unit of Work 从该 passed proposal 物化不可变 accepted Technical Baseline，以 Gate Result ID 作为外部元数据，并把 accepted Application Specs + Baseline 原子固定进新 Snapshot。Gate Result 不引用 accepted baseline hash，因此不存在自引用；Work Package fan-out 只能读取该 promoted Snapshot。
- 后续契约变化先创建新 Project Spec revision 并重新走受影响的 Product/Readiness/Technical Gate；不能让 Application Spec 静默偏离 Project-level contract。

### 7.3 Repository readiness

每个 Repository / Application 在 Product Review PASS 且 Project Spec 已 promotion 后、Technical Design 前执行 `RepositoryReadiness`：

- identity、当前 commit、default branch、protected/release-branch policy、dirty state 和 dirty policy；
- branch / Worktree 创建能力、filesystem path boundary、Sandbox provider capability；
- install/build/test/lint/typecheck 命令和所需 local service / Secret Reference；
- UI 需要的 Electron / preload / Company Runtime 启动条件；
- 依赖的其他 Application、契约版本和可验证命令；
- blockers、证据位置、建议 owner 和 expiration。

存在 blocking readiness defect 时，Pipeline Runtime 只能保持 `blocked`，不能以“Agent 看起来可以运行”代替检查。

### 7.4 Cross-application contracts

跨应用契约是 Project-level Artifact Contract 的子类型。每个契约包含 producer、consumer、schema/version、compatibility policy、fixture、validation command 和 owner。Pipeline Runtime 在以下时机验证：

1. Technical Design 完成：静态 schema 和 dependency graph；
2. Work Package Fan-out：每个包声明它生产或消费的 contract；
3. Integration branch：按 producer-first 依赖顺序执行 contract validation；
4. Test Run：在真实 Company Runtime 中执行跨应用交互；需要确定性 Agent/Sandbox 行为时注入 `ScriptedExecutionAdapter`；
5. Delivery candidate：所有 declared contract checks 必须有 evidence。

契约失败产生 `integration` 或 `test` Defect，不修改 contract 让检查通过。

## 8. Pipeline Runtime 与节点契约

### 8.1 v1 节点类型

ADR 0031 的闭集保持不变：Pipeline `nodeType` 只有 `start | ai-task | human-approval | condition | parallel | join | complete`。Software R&D 语义由版本化、受控的 Handler registry 提供；持久化的 canonical `handlerKindId` 形如 `development@1`，不是未版本化名称。每个值必须声明兼容 `nodeType`、输入/输出 schema hash、权限、失败映射和契约测试；不允许用户提供任意代码。

Product discovery 与 requirement confirmation 是 Company Runtime 的 Project-scoped **pre-run handlers**，不属于 Pipeline graph：

| Pre-run handler            | 输入                        | 输出 / 不变量                                                               |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `product-discovery`        | user messages / proposal    | Product Proposal revisions；不创建 Run、Node Run 或 Snapshot。              |
| `confirm-product-baseline` | exact Product Proposal hash | 原子创建 immutable Product Baseline + formal Department Run + Snapshot r1。 |

Software R&D v1 registry（下表为显示名，持久化时均使用 `@1` canonical ID）：

| `nodeType`       | 允许的 `handlerKind`                                                                                                                                                                                            | 主要输出 / 自动推进条件                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `start`          | `run-start`                                                                                                                                                                                                     | 对已 formalize 的 Run 创建首批正式 Node Run；不创建 Run/r1。 |
| `ai-task`        | `project-spec`, `review-topic`, `readiness`, `technical-design`, `development`, `code-review`, `integration`, `test`, `delivery-candidate-input`, `security-review`, `operability-review`, `delivery-candidate` | 对应 versioned Artifact/fact/Gate Result。                   |
| `human-approval` | `human-release`, `governed-intervention`                                                                                                                                                                        | Human decision；不能由 Agent 代签。                          |
| `condition`      | `gate-route`, `risk-route`, `contract-route`                                                                                                                                                                    | 仅基于结构化字段选择 branch。                                |
| `parallel`       | `work-package-fan-out`                                                                                                                                                                                          | 从 promoted Technical Baseline 实例化有界 package nodes。    |
| `join`           | `package-join`, `integration-join`, `quality-join`                                                                                                                                                              | 依赖与 Gate Result 全部满足才收敛。                          |
| `complete`       | `run-complete`                                                                                                                                                                                                  | 只接受 Human release `accepted`，不隐式 deploy。             |

每个 Pipeline Version 冻结 Handler registry version/hash；每个 Snapshot 和 Node Run 冻结 exact `handlerKindId` 及输入/输出 schema hash。Runtime 找不到该版本或 hash 不匹配时返回 `HANDLER_VERSION_UNAVAILABLE` 并阻塞恢复，不能用当前同名实现解释历史节点。每个节点还声明 owner Position、Harness Snapshot/Run Skill Snapshot、Artifact Contracts、permission policy、risk tier、budget、timeout、retry/recovery policy 和 failure mapping。新增 Handler 版本是 registry/schema 变更；新增顶层 `nodeType` 才需要重新评估 ADR 0031。

### 8.2 默认 Software R&D 顺序

```text
Product discovery (pre-run intake)
→ Requirement confirmation (human hard gate)
→ Product Baseline + formal Department Run / Snapshot r1 (one transaction)
→ Start (formal Pipeline; create first Node Runs)
→ Project Spec draft
→ Product Review topic + fresh re-review
→ Gate promotion: accepted Project Spec
→ Repository readiness + cross-application precheck
→ Gate promotion: accepted readiness evidence
→ Technical design + Application Spec drafts / Technical Baseline Proposal
→ Technical Review topic + fresh re-review
→ Gate promotion: accepted Application Specs / Technical Baseline
→ Work Package fan-out
→ Parallel development on isolated workspaces
→ Developer self-check
→ Independent Code Review
→ Per-repository Integration branch + aggregate review
→ Runtime / contract / build Test runs
→ Electron interaction Test run
→ Delivery Candidate Input
→ Security review
→ Operability review
→ Delivery candidate
→ Human release decision
→ Complete
```

### 8.3 自动推进与异常升级

Pipeline Runtime 在一次事务中计算 Ready Queue：

- 所有 predecessor 成功、Artifact Contract 满足、Lease 可用且权限有效时，Node Run 变为 `ready`。
- 无需人审的 `PASS` 自动激活下游。`CONDITIONAL_PASS` 只激活声明的修订、Defect、Work Package 或 Test obligation 节点，不满足 Artifact Contract，不创建 Gate promotion，也不允许进入 Integration/Candidate；条件完成后必须由 fresh re-review 得到 `PASS`。
- `FAIL`、blocking readiness、未解决 high/critical finding、预算超限、重复失败、跨应用契约冲突、危险权限或两次连续 `CONDITIONAL_PASS` 使当前 Node 和 Run 进入 `blocked` 并发出 escalation event；`waiting-human-release` 只用于已组装 Candidate 的发布门。
- Rework 不覆盖原对象：创建新的 Spec/Work Package/Attempt/Review Revision，并把 Defect 指向新责任对象。
- Pause 只阻止新 Claim 和允许中的可取消执行；Cancel 使未完成 Node/Attempt 收敛为 cancelled，并保留已产生 Artifact 和证据。
- Pipeline Runtime 不根据文本猜测结果；Handler 必须返回结构化结果和 evidence refs。

### 8.4 Human Approval Node

进入 `human-approval` Node 时，Pipeline Runtime 原子创建 `node_approval_request`，冻结 Node Run、Snapshot Revision、requested action、exact input manifest/hash、expiry 和 eligible human policy。只有统一 `decide-node-approval` Command 可追加唯一 decision；其 primary aggregate 是 approval request，Envelope `expectedRevision` 防止并发决定，actor 必须是 verified/eligible human。

```text
pending → approved | rejected | changes-requested | expired | cancelled
```

`approved` 满足该 Node 的 Artifact Contract；`rejected` 使 Node/Run 按声明 policy blocked 或 failed；`changes-requested` 创建 Node feedback 和新 Attempt/revision obligation，不覆盖 request。相同 Command 重放原结果，不同 decision 返回 `APPROVAL_DECISION_EXISTS`。`approval.requested` / `approval.decided` 是 durable Runtime Events。Tool Permission 与 Human release 分别使用自己的 request/decision 表，不能复用 generic Node approval 或代签。

## 9. 状态机和转换表

### 9.1 Product Proposal 与确认

```text
draft → clarifying → awaiting-confirmation → confirmed
                                  ├→ rejected
                                  └→ needs-rework → clarifying
```

这些是 Product Proposal 的 pre-run 状态；只有 Company Runtime 的人类确认 Command 能从 exact `awaiting-confirmation` revision 创建独立、不可变的 confirmed Product Baseline。Baseline 本身没有 draft/rework 状态。

### 9.2 Review topic / Finding

```text
scheduled → independent-review → discussion → revision → re-review
      └→ blocked                    └──────────────┘
re-review → PASS | CONDITIONAL_PASS | FAIL
```

Finding 状态：`open → accepted | disputed | resolved | rejected`；每个 `resolved` 必须有 evidence 和 revised artifact ref。`FAIL` 自动创建或更新 Defect，`CONDITIONAL_PASS` 必须列出 machine-checkable conditions。

### 9.3 Work Package

```text
draft → ready → assigned → running → self-check
              │                     ├→ blocked
              │                     └→ failed
              └─────────────────────┘
self-check → cr-pending → cr-approved → integrating → integrated
                         └→ rework → assigned
integrating → integration-defect → rework
```

每次 `rework` 都生成新的 Work Package Version 或 Node Attempt；旧 Diff、Review 和 Defect 不删除。

### 9.4 Defect

```text
open → triaged → assigned → fixing → awaiting-verification
  ├→ duplicate
  ├→ accepted-risk (仅人审或策略允许)
  └→ blocked
awaiting-verification → closed | reopened
```

Defect 关闭必须引用通过的 Review/Test/Contract evidence；不能用删除 Test Case、放宽 Spec 或改写原 finding 关闭。

### 9.5 Department Run / Node Run / Attempt

Product discovery 和 requirement confirmation 在 Project-scoped pre-run intake 中完成；下面的 Department Run 状态机从 Company Runtime 创建 Snapshot `r1` 后开始。正式 `Node Run` 必须引用 Snapshot Revision；pre-run Proposal/Session 不伪装成 Node Run。

```text
Run:           ready → running ↔ paused
                     ├→ waiting-approval → running
                     ├→ blocked → recovering → running
                     ├→ candidate-ready → waiting-human-release
                     │                       ├─ accepted → completed
                     │                       ├─ rejected → release-rejected
                     │                       └─ changes-requested → blocked/recovering
                     ├→ failed
                     └→ cancelled
                     └→ superseded

Node:          queued → ready → running → succeeded
                          ├→ waiting-permission → running
                          ├→ waiting-approval → succeeded | blocked | failed
                          ├→ paused → running
                          ├→ blocked
                          ├→ skipped
                          └→ failed → retry | recovery | cancelled

Attempt:       ready → leased → running → succeeded | failed | cancelled
                                  └→ reconciling → running | succeeded | failed | cancelled | interrupted
```

Run 在 confirmation/fork 的事务结束时直接处于 `ready` 并持有 `r1`，不存在没有 Snapshot 的 `draft` Run。`blocked` 是可恢复状态，只有它能经 `recovering` 返回 `running`；`failed`、`cancelled`、`release-rejected`、`superseded` 和 `completed` 都是终态。`reconciling` 是 Lease/Runtime/Worker 失效后的非终态 Attempt 恢复状态；`interrupted` 是 reconcile 后已证明外部执行终止的终态，不得再改写或静默回队。Human release `changes-requested` 只在当前 Product Baseline/Repository/Pipeline 边界内进入同一 Run 的 recorded rework，组装新 Candidate 后再回到 `waiting-human-release`；若要求改变这些边界，新的 confirmation/fork 原子创建 child Run，原 Run 进入 `superseded`。`rejected` 使 Run 进入终态 `release-rejected`；后续工作必须显式 Fork。Condition 未选择的 branch Node 进入 `skipped(reason=condition-not-selected)`；Join 把明确 `skipped` 视为已收敛边。

### 9.6 Quality、Candidate 和 Release

```text
Test run:       scheduled → running → PASSED | FAILED | BLOCKED | CANCELLED
Security review: scheduled → running → PASS | CONDITIONAL_PASS | FAIL
Operability:    scheduled → running → PASS | CONDITIONAL_PASS | FAIL

Candidate input assembly: assembling → frozen-for-final-gates
Candidate manifest:       created → ready-for-delivery
Candidate projection: awaiting-decision → accepted | rejected | changes-requested | superseded
Release decision:     pending → accepted | rejected | changes-requested
```

Candidate manifest 本身没有 accepted/rejected 状态，创建后永不变化；`Candidate projection` 由唯一 Human release decision 和后续 Candidate lineage 推导。每个 candidate 最多一个 append-only Release decision；`changes-requested` 产生 rework 和新 candidate，不在旧 candidate 上追加第二个决定。只有尚未 accepted 的旧 candidate 能被更新 candidate 投影为 `superseded`；`accepted` 是终态。

## 10. Review Topic、独立 finding 和有界讨论

### 10.1 独立审查输入

每个 reviewer 使用全新的 Session 和独立上下文，只收到 `ReviewInputManifest`：

```ts
interface ReviewInputManifestBase {
  topicId: string;
  supportingArtifactVersionIds: string[];
  supportingSpecRevisionIds: string[];
  harnessSnapshotIds: string[];
  acceptanceCriteria: string[];
  excludedContext: string[]; // hidden prompts, prior reviewer opinions, private transcript
}

type ReviewInputManifest = ReviewInputManifestBase &
  (
    | {
        scope: "product";
        productBaselineId: string;
        productBaselineHash: string;
        projectSpecRevisionId: string;
        projectSpecHash: string;
      }
    | {
        scope: "technical";
        promotedProjectSpecRevisionId: string;
        readinessEvidenceIds: string[];
        applicationSpecRevisions: Array<{ id: string; hash: string }>;
        technicalBaselineProposalId: string;
        technicalBaselineProposalHash: string;
      }
    | {
        scope: "code";
        workPackageVersionId: string;
        repositoryId: string;
        sourceCommit: string;
        diffArtifactVersionId: string;
        diffHash: string;
      }
    | {
        scope: "aggregate";
        integrationGenerationId: string;
        integrationManifestHash: string;
        repositoryCommits: Array<{ repositoryId: string; commit: string }>;
      }
    | {
        scope: "verification";
        verificationSubject:
          | {
              kind: "test";
              integrationGenerationId: string;
              repositoryCommits: Array<{
                repositoryId: string;
                commit: string;
              }>;
              testCaseRevisionIds: string[];
              testRunIds: string[];
            }
          | {
              kind: "candidate-final";
              deliveryCandidateInputId: string;
              deliveryCandidateInputHash: string;
            };
        evidenceIds: string[];
      }
  );

interface ReadinessGateInputManifest {
  scope: "readiness";
  runId: string;
  snapshotRevisionId: string;
  promotedProjectSpecRevisionId: string;
  promotedProjectSpecHash: string;
  executionProfileId: string;
  executionProfileHash: string;
  repositories: Array<{
    repositoryReferenceId: string;
    repositoryRevision: number;
    applicationReferences: Array<{ id: string; revision: number }>;
    commit: string;
    defaultBranch: string;
    dirtyState: "clean" | "dirty";
    dirtyPolicyHash: string;
    capabilitySnapshotHash: string;
    contractVersions: Array<{ id: string; version: string; hash: string }>;
    evidenceIds: string[];
  }>;
  checkedAt: string;
  validUntil?: string;
}

type QualityGateInputManifest =
  | ReviewInputManifest
  | ReadinessGateInputManifest;
```

Scope-specific fields are authoritative review subjects；`supporting*` arrays 只提供只读上下文，不能替代、覆盖或与这些 exact IDs/hashes 冲突。

Reviewer 先提交一组独立 findings，每条 finding 绑定 severity（`info | low | medium | high | critical`）、证据、理由、影响面、建议 owner 和是否阻塞。主持人不能在此阶段将多个 finding 合并成匿名结论。

Company Runtime 在创建 `review_participants` 和提交 re-review 前执行 eligibility check，并把结果冻结到 `eligibility snapshot`：

- `reviewerSessionId` 必须不同于被审 Artifact/Work Package 的 producer Session；
- reviewer AI member 不能是责任 Developer、方案 owner 或该 finding 的直接 producer；
- 方案 owner/producer 可以作为 Topic participant 回答问题、接收 finding、提交 resolution 和新 revision，但不能提交 independent finding、计入 reviewer quorum 或投 Gate vote；Product Review 的 Product manager 与 Technical Review 的 Software architect 均遵守此规则；
- re-review 至少更换一个 reviewer，并且不能复用原实现 Agent 的 Session、Workspace 或隐藏上下文；
- 输入可见性只由 `ReviewInputManifest` 授权，不能通过 Session parent、共享缓存或文件路径间接读取 excluded context；
- 不满足条件时 Topic 进入 `blocked`，不能由 Coordinator 手工覆盖为 PASS。

### 10.2 有界 Discussion

Topic 在创建时固定：participant IDs、moderator、owner、scope、budget（时间/Token/成本）、`maxRounds`、每轮输入、stop condition 和 escalation policy。调度规则：

1. 只把互相冲突或 high/critical 的 findings 放入讨论；没有材料冲突时直接进入 revision / re-review。
2. 每轮只允许 moderator 选择的 conflict set；每个 participant 只能回应该 set。
3. 达到 `maxRounds`、budget 或 stop condition 时停止，不自动开启下一轮。
4. stop condition 满足的最小条件是：所有 blocking finding 有 disposition，且 acceptance criteria 有明确证据；否则 Topic `FAIL` 或升级人审。
5. 讨论输出是 resolution matrix 和 owner actions，不是覆盖原 findings 的聊天摘要。

### 10.3 修订与独立复核

指定 owner 只能创建新的 proposal/spec/diff revision，不能批准 Topic。Re-review 使用新 Session，输入为：新 revision、原 acceptance criteria、finding resolution matrix、必要 evidence；不自动注入完整讨论 Transcript。复核者不能是该 revision 的 producer，且至少一名 reviewer 不得参与原方案实现；Runtime 基于当前 reviewer/session 生成 fresh eligibility snapshot，并引用上一轮 snapshot 验证更换与冲突关系，而不是依赖 Agent 自述。

### 10.4 Review 结果

- `PASS`：无 blocking finding，证据完整，自动进入下游。
- `CONDITIONAL_PASS`：仅允许低/中风险、可机器验证的条件，并生成责任 Defect/Work Package/Test obligation。
- `FAIL`：存在未解决 blocking finding、证据不足、超预算未完成或讨论死锁；回到责任阶段。

Gate-specific policy 覆盖通用结果：Code Review 必须在进入 Integration 前得到独立 `PASS`；`CONDITIONAL_PASS` 只表示允许责任 Developer 修复和复核，不表示 package 已通过 CR。

每个 Review Topic 的终局写入不可变 `quality_gate_results`，固定 discriminated `ReviewInputManifest` 全文/hash、最终 recheck/evidence refs、result 和 conditions；Readiness Gate 则固定 `ReadinessGateInputManifest` 全文/hash。Gate promotion 只从 `QualityGateInputManifest` 的 scope-specific exact refs 推导输入，并拒绝过期 readiness。Code Review 的权威结果是 `kind=code` 且输入绑定 exact Work Package Version + source commit/diff hash 的 Gate Result；Candidate 和 Integration 只能引用该 `PASS` ID。

## 11. Work Package、依赖和独立执行

### 11.1 Work Package 合同

每个 Work Package Version 恰好属于一个 Application 和一个 Repository，并声明：目标、验收、module scope、依赖包和 Contract IDs、允许权限、Harness/Spec refs、assignment criteria、required branch/isolation、预期 Artifact、self-check、独立 CR 条件、Integration 条件、risk tier 和失败恢复策略。Version 不拥有具体 AI member、Worktree、Sandbox 或 Session；这些由每个 Node Attempt 的 assignment/Workspace Allocation 唯一拥有。跨 Repository 目标拆成 Project-level dependency group 下的多个 Work Package。修改合同字段必须创建新版本。

依赖种类：

- `artifact`：前置产物版本必须 accepted/produced；
- `commit`：前置 commit 必须固定；
- `contract`：跨应用 contract validation 必须通过；
- `readiness`：指定应用 readiness check 必须无 blocker；
- `manual`：仅在 Pipeline 声明了人审时等待。

Coordinator 可以分派和排序，但不能替 Developer 写 Worktree、批准 CR 或修改 Pipeline 状态。

### 11.2 Workspace 分配

一次 Work Package Attempt 分配唯一 tuple：

```text
Work Package Version
  → source branch (独立)
  → host Worktree (Runtime-owned import destination)
  → isolated Git execution tree (Agent 独立可写)
  → Sandbox (独立执行边界)
  → Session (独立 Agent context)
  → Node Run / Node Attempt
  → Artifact lineage context
```

Workspace Command 先原子创建 `planned` allocation，固定 allocation ID、Work Package Version、Node Attempt、exact base commit、resolved `branch` strategy/source branch、expected Runtime-owned host Worktree、Company Runtime-owned Interaction Session、planned Sandbox provider/capabilities、operation key 和 cleanup policy。Idempotent provisioner 随后创建/校验 source branch、host Worktree、isolated Git execution tree 和 Sandbox，逐个事实在独立 Unit of Work 写入；只有 capability check 与 ref-write isolation 证明完成的 `ready` allocation 才能启动 Agent execution Worker。Crash recovery 比对 exact Git refs、受控路径、private Git identity 和 provider instance，输入漂移则 `failed`/blocked，不能收养未知目录。实际 Sandbox instance ID 与 provider-owned Agent Session ref 初始可空，后者只由 execution fact 填入；二者不得复用为 Interaction Session ID。Execution Adapter 只接收 `allocationId` 与受控 refs，不能自行选择 Repository root、写 host Git refs、复用未登记 Session 或退回 `head`。

Reviewer 再创建只读的独立 Workspace，基于 exact reviewed commit，不复用开发 Session、开发 Worktree 或 hidden context。Parallel Work Package 不共享可写目录、未登记的 temp path、Agent session storage 或 mutable cache。

### 11.3 Provider 和 branch strategy

- Software R&D 的正式 Work Package 强制 `branch` strategy，没有 `head` / `merge-to-head` 例外。两种兼容 strategy 仅服务于不产生 Work Package、CR、Integration 或 Candidate 的旧式串行节点，并且必须被独立 Execution Profile 和 Snapshot 明确标记。
- Branch strategy 按 Sandcastle 现有公共契约作为每次 `run()`/`interactive()`/`createWorktree()` 的执行输入，不属于 Sandbox provider 构造配置。Execution Profile/Snapshot 冻结唯一 resolved strategy 与 provider factory configuration，allocation 记录 source branch；ExecutionRequest 只能引用 frozen allocation，不能另传可漂移 strategy。
- Provider capability profile 至少记录 filesystem/session/credential isolation、`gitRefWriteIsolation`、`runtimeImportOnly`、network/tool policy 与可验证 mechanism/version。正式 Work Package 要求后两项为真：Agent 看不到可写的 host/shared Git common directory，只在独立 Git 数据库的 execution tree 产生 commit/patch/bundle；Runtime-owned importer 校验 base、object/hash、path policy 和 expected source-branch tip 后，以 CAS 只推进该 allocation 的 source branch。
- 现有共享 `.git` 的 **bind-mount provider** 与直接 host 执行的 **no-sandbox provider** 不满足正式 Work Package 的 Git ref 隔离；串行化不能把它们升级为合格。它们只可用于 Snapshot 明确允许且不产生 Work Package/CR/Integration/Candidate 的兼容节点或 consultation 之外的受限场景。未来 wrapper 只有在 capability tests 证明 Agent 无法写共享 refs 且所有导入由 Runtime 完成时才可声明合格。
- **Isolated provider** 为正式 Work Package 同步 exact base 到独立 Git 数据库；host Worktree 是 Runtime-owned import destination，结果只能经受控 commit/patch/bundle/Artifact importer 返回。v1 必须提供至少一个本地可用的合格 isolated execution profile，否则 technical readiness/Work Package allocation blocked 并返回 `PROVIDER_ISOLATION_REQUIRED`；这不阻止 Product Baseline confirmation 原子创建 Run/r1。
- 正式 Review/Test/Security/Operability 节点使用独立、只读、输入 allowlist 的 execution tree；若 Provider 不能隔离 producer Session、其他 Worktree、shared cache、hidden context 或 credential scope，则 Node blocked，串行化同样不能替代独立性。
- Agent-facing provider 不得写 source branch、generation-scoped Integration branch 或 Release target branch；Runtime importer 只写 allocation source branch，Integration Adapter 只写 Integration branch。Release target branch 只有在 Human release `accepted` 后，才能由单独授权的 merge-kind Release operation 更新。

### 11.4 Developer self-check 和 CR

Developer self-check 生成结构化报告、命令、日志和 commit evidence，只是排队条件。通过后，独立 Code Review Node 使用新 Session、独立 Workspace 和限定输入执行；原 Developer 不能成为 CR approver。CR `FAIL` 或 `CONDITIONAL_PASS` 创建 Defect，回到 Work Package 新 Attempt；修复后必须由新的独立 Re-review Session 得到 `PASS`，旧 CR 保留。

## 12. Integration branch 和 Integration defect

### 12.1 多仓库集成模型

Project 通过一个不可变 Project-level Integration Generation manifest 关联本次 Run 的各 Repository integration results。每个 generation 冻结所有 participating Repository 的 base commit、已通过 CR 的 source commits、dependency graph 和 cross-application contract versions；每个 Repository 使用独立的 `integration/<run-id>/g<generation>` Integration branch。Delivery candidate 引用一个 `PASS` generation 并记录每个 Repository 的 exact integrated commit，不假设跨仓库存在一个 Git branch。

Integration Adapter 按 dependency graph 的 topological order，在该 generation 的每个 Repository Integration branch 上应用已取得独立 CR `PASS` 且没有 open obligation 的 source commit。所有操作带 `generationId`、`integrationOperationId`、expected Integration-branch tip 和 source commit hash；重复请求返回既有结果，任何 manifest/tip 不同都返回 `INTEGRATION_CONFLICT`。

每个 Integration operation 使用 durable intent protocol，不把 Git/provider side effect 包在 SQLite 事务内：

1. 接受 Command 的 Unit of Work 先写 `intent`，冻结 canonical payload hash、idempotency key、source commit 和 expected tip，并返回 operation ID。
2. Worker 把同一 idempotency key 传给 Adapter；本地 Git 至少记录 before tip，并以 exact resulting commit/patch identity 作为 receipt。
3. Side effect 后的 Unit of Work 保存 provider/Git receipt、after tip、validation evidence 和终态，再推进 generation。
4. 启动恢复查询 provider receipt，或比较 exact branch tip/commit ancestry 后补记终态；输入不一致为 `INTEGRATION_CONFLICT`。若 provider 既不支持 idempotency key 也不能查询结果，operation 进入 `unknown`/blocked，必须人工提供 reconciliation evidence，不能盲重发。

### 12.2 冲突和失败

- Git conflict：记录冲突文件、base/source/target commits 和疑似责任 package；生成 `integration` Defect，回到责任 Work Package。
- Build/test failure：若只归因到一个 package，创建该 package Defect；若为聚合问题，创建 aggregate Defect 并保留所有候选责任。
- Cross-application contract failure：记录 producer/consumer、contract version、fixture 和 Runtime evidence，阻塞受影响包和 candidate。
- 集成修复不得直接在 Integration branch 上临时提交；必须回到源 Work Package 新 Attempt，重新 CR 后再集成。
- 任一 Repository operation 失败时，整个 generation 标记 `failed`，已成功的 per-repository result 只保留为证据，不能进入 Candidate。修复后创建新 generation 和新的 `g<n>` branches，从冻结 base 重新按 manifest 应用；不得继续写 failed generation 或复用无法证明输入完全一致的旧 tip。

### 12.3 Integration branch 保护

Integration branch 的写权限只授予 Integration Adapter；Coordinator、Developer、Reviewer、Renderer 和 ACP 都没有直接写权限。Integration branch 不是 Human release decision，也不等于生产分支；Human release 接受后才允许明确授权的 merge/export seam 运行。

Release operation 使用 discriminated input：

- `kind=merge`：固定 accepted decision/candidate hash，以及每 Repository 的 integrated source commit、用户选择的 **Release target branch** 和 expected tip。
- `kind=export`：固定 accepted decision/candidate hash、Artifact Version IDs、destination ref、expected destination state/digest 和 overwrite policy；不包含 Git branch。

两种 operation 都复用 durable intent→external effect→receipt/finalize protocol，有独立 `releaseOperationId`/input hash 并逐项保存 receipt。部分失败不回滚已完成外部副作用，也不能伪装整体成功；重试先 reconcile exact source/destination state，只补未完成且输入未漂移的项。任何 destination 变化返回 `RELEASE_DESTINATION_CONFLICT` 并要求新的人工确认；无法幂等或查询的 destination 进入 `unknown`/human reconciliation。该 seam 不属于 Integration Adapter，也不等于 Deployment。

## 13. Test、Security 和 Operability Quality Gates

### 13.1 风险分级

每个 Work Package、Review Topic、Test scope、Delivery Candidate Input 和最终 Delivery candidate 计算 `low | medium | high | critical` 风险。Risk policy 使用确定性 rubric；命中多个规则时取最高等级：

| Tier       | 最低触发条件                                                                                                        | 强制审查                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `low`      | 只读、文案、非敏感配置，且不改变公开契约、权限、数据或 Runtime 行为。                                               | 轻量 Security/Operability checklist。                              |
| `medium`   | 单应用行为或依赖变化，可回滚，不处理 secret、auth、迁移或跨应用契约。                                               | 针对性静态/动态检查。                                              |
| `high`     | auth/permission、Secret Reference、环境转发、public API、数据迁移、跨应用契约、no-sandbox 或用户可见 Runtime 状态。 | 独立深度 Security/Operability Review；未关闭 finding 阻塞。        |
| `critical` | 生产部署、不可逆数据变更、凭证材料化、破坏性操作或可能越过 Sandbox/Repository 边界。                                | 强制暂停和 Human escalation；v1 Agent 不能自动批准或执行生产动作。 |

风险因子至少包括：

- secret / credential / environment boundary；
- auth、permission、sandbox escape、network 或 filesystem scope；
- dependency/supply-chain、data migration、PII 或 destructive action；
- cross-application contract、public API、user-visible Electron/Runtime state；
- rollback、resource exhaustion、timeout 和 recovery complexity。

人工可以上调风险；下调必须由人记录证据和理由，且不能低于仍未解决 finding 的最低 tier。Agent、Coordinator 或 Renderer 不能自行下调。Risk policy revision 和计算结果都是 Snapshot / Gate evidence 的一部分。

### 13.2 Code Review

Code Review 使用新 Session 和 `ReviewInputManifest`，至少检查 Diff、Spec、Harness、Test evidence、权限、错误处理和跨应用影响。Review result 与 finding 进入 Run Record、Artifact lineage 和 Defect loop。

### 13.3 Test Case / Test Run

Test Case revision 定义 requirement/package coverage、preconditions、UI actions、expected UI assertions、authoritative Runtime assertions、fixture、evidence retention 和 cleanup。Test Run 固定 build、Repository commits、Snapshot Revision、Execution Profile、Company Directory fingerprint、Runtime fixture、时间和环境。

测试结论只有在 UI 与 authoritative Runtime 都满足时才能 PASS；按钮存在、文案正确或颜色变化不能单独通过。

### 13.4 真实 Electron 交互测试 Fixture

用户可见变更必须满足以下启动拓扑：

```text
Playwright / Electron test driver
        │ real BrowserWindow
        ▼
real Electron renderer ── preload bridge ── Company Runtime process
                                                   │
                                  ScriptedExecutionAdapter
                                  ScriptedInteractionExecutionAdapter
                                  Scripted Agent/Sandbox events
```

Fixture 规则：

- 每个 Test Run 创建临时 Company Directory、临时 Repository/Worktree 和一次性 IPC token。
- 启动真实 Electron main、renderer、preload 和 Company Runtime；不用 mock renderer 或绕过 preload。
- Electron authoritative E2E 只在 Company Runtime 的执行端口注入 `ScriptedExecutionAdapter` 与 `ScriptedInteractionExecutionAdapter`：Company Runtime、SQLite、Pipeline Runtime、Interaction Turn、Audit、Event Outbox、Electron main 和 preload IPC 都是真实实现。
- Company Runtime entry 默认加载 Production Adapters。测试 supervisor 只能在 test build 中通过 `--fixture-config <0600 temp-file>` 启用 scripted mode；validated config 固定 fixture ID、临时 Company Directory marker/fingerprint、两个 allowlisted Adapter IDs、script hashes 和一次性 IPC token。Renderer/ACP/普通环境变量不能选择 Adapter；production packaged build 不包含 enable capability，看到该 flag/config 必须 fail closed。
- 两个 scripted Adapter 与 Production Adapter 共用 `ExecutionEventSink`，脚本可以依次报告 message/tool call/tool result/permission request/checkpoint/completion/failure facts；只有真实 Company Runtime 能据此创建 Permission、Artifact、Audit、Runtime Event 和状态转换，Adapter 不能直接写状态。
- `ScriptedRuntimeTransport` 直接脚本化 `CompanyRuntimeInterface` request/response/event，只允许用于 Renderer、preload client 和协议映射的快速契约单测；它绕过真实 Company Runtime，因此不得作为用户可见行为、恢复、权限、Lineage 或质量门的验收证据。
- Fixture 提供 fake clock、可重复 ID、Provider/Sandbox capability profile、seeded catalog 和清理钩子。
- Test driver 通过真实用户手势操作 renderer，不用 `executeJavaScript` 直接调用 bridge/Runtime 代替行为。每个 UI action 关联 `commandId`；每个断言关联 Runtime event sequence、Query `asOfSequence`/view hash 和截图/日志 evidence。
- 本机真实 Agent、真实 provider credentials 和用户 Company Directory 不得被 Fixture 静默使用。

### 13.5 Security review

每个 immutable Delivery Candidate Input 至少执行轻量 Security review：权限、secret reference、环境转发、Sandbox/Worktree boundary、依赖和敏感日志。Medium risk 加入针对性动态/静态检查；High/Critical 必须由独立 Session 执行深度 review，检查最小权限、攻击面、迁移/回滚和 cross-app trust boundary。Critical finding 阻塞 candidate，不能用 `CONDITIONAL_PASS` 自动放行。

### 13.6 Operability review

每个 immutable Delivery Candidate Input 至少执行轻量 Operability review：启动、日志、Runtime Event、超时、Lease、恢复、资源、备份和回滚证据。高风险变更增加长时运行、崩溃恢复、负载、升级和跨应用运行契约验证。缺少可恢复证据时结果为 `CONDITIONAL_PASS` 或 `FAIL`，不能只因为 build 通过而放行。

## 14. Delivery candidate 和 Human release decision

### 14.1 Candidate 组装

Integration Generation、required Test Runs 与回归完成后，Delivery Module 先创建 immutable `Delivery Candidate Input`，固定 generation/per-repository commits、Artifact/contract/test refs、Snapshot、risk summary 和 evidence hash。Verification、Security 和 Operability Gate Result 绑定该 exact input ID/hash，而不是引用尚未创建的 Candidate。

Delivery Module 在以下条件全部满足时从该 Input 创建 candidate：

- Product Baseline、Project/Application Spec 和全部 Work Package lineage 完整；
- 每个 package 有 self-check 和独立 CR `PASS`；Code Review 的 `CONDITIONAL_PASS` 不允许进入 Integration 或 Candidate；
- 所有 Repository Integration branch 有 exact commit，聚合 CR 和跨应用契约通过；
- 必需 Test Run、Electron interaction evidence、Security review 和 Operability review 的 Gate Result 均为 `PASS`；
- 所有 `CONDITIONAL_PASS` obligation 已完成并经 fresh re-review 转为 `PASS`；无未关闭 Defect 或 accepted-risk 以外的 Gate blocker；
- Artifact、Snapshot、Harness、Session、Runtime Event 和失败证据可追溯。

Candidate payload 是 canonical manifest + hash，包含 Candidate Input ID/hash、`PASS` Integration Generation、每仓库 integrated commit、Artifact Version IDs、全部 `PASS` review/test/security/operability Gate Result IDs、risk summary、evidence locations 和 source Snapshot Revision。创建后不可修改；Input 或证据变化先产生新 Candidate Input 并重新执行受影响 Gate，随后生成新 candidate。

### 14.2 人工发布门

Human release decision 只接受 `candidateId` + candidate hash + verified human actor + decision；同一 candidate 已有决定时返回原结果或 `RELEASE_DECISION_EXISTS`，不能追加冲突决定。允许：

- `accepted`：允许独立的 merge/export action；未来 Deployment Adapter 仍需单独授权。
- `rejected`：保留 candidate 和理由，创建回退反馈，Run 从 `waiting-human-release` 进入终态 `release-rejected`；任何后续工作使用 explicit Fork。
- `changes-requested`：指定责任 Defect/Work Package/阶段；若仍在 frozen Product Baseline/Repository/Pipeline 边界内，Run 进入 `blocked(reason=release-rework)`，经 recorded rework 回到 `running` 并组装新 Candidate。若越界，新的 confirmation/fork 创建 child Run 后，原 Run 进入 `superseded`。

`accepted` 在同一 decision Unit of Work 把 Run 转为 `completed`；任何 decision 都不能修改历史 Snapshot、Artifact、Review 或 Candidate。Candidate 不能自动部署生产环境。

## 15. Supervised autonomy、观察、暂停和介入

### 15.1 Read model

`RunSupervisionView` 由 Company Runtime 投影，按角色、AI member、Session、Work Package、Node Run 和 Attempt 展示：goal/input Snapshot refs、状态、当前权限、Tool Call/Result、Structured rationale、Artifact/Diff、commit、usage/cost、Lease、失败证据、下一可用 Command 和 event cursor。

Renderer 只显示 View，不拥有活动状态；刷新严格执行 old-generation barrier → Query/apply View → `viewSyncToken` Ack → open new generation，任何旧 callback 都必须在应用 View 前完成或失效。

### 15.2 控制命令

```ts
type SupervisionCommand =
  | { kind: "observe"; runId: string }
  | { kind: "pause"; runId: string; reason: string }
  | { kind: "cancel"; runId: string; reason: string }
  | { kind: "consult"; target: "run" | "node" | "member"; targetId: string }
  | {
      kind: "governed-intervention";
      nodeRunId: string;
      feedback: string;
      override?: RecoveryOverride;
    };
```

Observation 和 Consultation 不改变正式执行。Governed intervention 必须：

1. 记录 human actor、reason、target Session/Node、当前 Revision 和证据；
2. 暂停受影响 Node Run，拒绝旧 Attempt 的新副作用；
3. 将实质性目标/约束/权限变化 materialize 成 Node Feedback；
4. 继续时创建新 Snapshot Revision 或 Node Attempt；
5. 让 Runtime Event、Audit 和 lineage 明确显示前后关系。

每次 `session/prompt` 都先创建持久化 Interaction Turn 并返回 `turnId`，再异步执行：

- `consultation` / `product-discovery` Turn 不绑定 Node Attempt；Company Runtime 为其创建 target=`interaction-turn` 的 operation key 与 Execution Lease。其 `ExecutionRequest` 强制 `sideEffectPolicy="none"`：v1 只能选择 model-only Interaction Adapter，Runtime 先解析、裁剪、脱敏并 hash allowlisted immutable context，Adapter 不接收 cwd、Worktree/Sandbox、filesystem/shell/tool registry 或除模型 transport 外的 credential。Capability 必须记录 `mechanism="model-only"`、mechanism version 和 context schema hash；普通 Sandcastle `run()`/no-sandbox 调用不能声明满足该能力。无法硬隔离时返回 `CONSULTATION_ISOLATION_REQUIRED`，不能只靠 prompt。要采用输出必须发送独立 Proposal/Feedback/Memory Command。
- `sideEffectPolicy="none"` 的 sink fact policy 只接受 provider/session lifecycle、message、usage、checkpoint 和 terminal facts；`tool-call`、`tool-result`、`permission-request`、`artifact`、`commit` 或任何 effect-bearing payload 返回 `EXECUTION_ADAPTER_PROTOCOL`，使 Turn `failed` 且不产生正式 effect。模型 credential 只封装在可信 Model Transport，不能进入 request/context/Agent 环境。
- `run-collaboration` Turn 必须绑定当前 Node Run/Node Attempt，并共享该 Attempt 的 Snapshot、permission policy、operation key 和 Node Lease；其 Execution Facts 以 Node Attempt 为 lease target 并通过 `interactionTurnId` 关联可见对话，不能创建平行的未监管执行。
- 重复 prompt Command 返回同一 Turn；Runtime/Adapter 中断先按 operation key reconcile：已完成则收敛原 Turn，仍运行只在可重新附着时继续，unknown 则阻塞。确认终止后才创建新 Turn 或正式 Recovery Attempt，不续写未知执行。
- `CancelInteractionTurn` 只取消指定 Turn 并等待 Adapter/Node Attempt 收敛；关闭 Session 不得作为取消正在执行 Turn 的替代语义。

### 15.3 Pause / Cancel 语义

Pause 不回滚已产生的 commit、Artifact 或 event；底层 Agent 收到 AbortSignal。Provider terminal fact 或 strong fence 证明执行停止时 Attempt 才可进入 `interrupted`；停止结果未知时保持 `reconciling`。Cancel 终止新调度并请求 Adapter cancel，`cancelled` response 仍需 terminal/fence evidence；`unknown` 不得把 Attempt 伪装成 cancelled，也不得允许新 Attempt。Interaction Turn 与 Node Attempt 的取消事实分别记录，但正式协作 Turn 的终态必须与其绑定 Attempt 一致。

## 16. Runtime Event、AG-UI、ACP 和断线恢复

### 16.1 Event Envelope

```ts
interface EventEnvelope {
  registryVersion: number; // event name/required top-level field registry
  schemaVersion: number; // payload schema for this event type
  sequence: number; // Company Runtime 全局单调递增
  eventId: string; // UUID，消费者去重
  type: string; // dotted runtime event name
  companyId: string;
  projectId?: string;
  applicationId?: string;
  departmentId?: string;
  positionId?: string;
  aiMemberId?: string;
  companyAgentAdapterId?: string;
  skillId?: string;
  skillFlowId?: string;
  executionProfileId?: string;
  repositoryReferenceId?: string;
  productProposalId?: string;
  productBaselineId?: string;
  projectSpecRevisionId?: string;
  applicationSpecRevisionId?: string;
  technicalBaselineProposalId?: string;
  technicalBaselineId?: string;
  pipelineVersionId?: string;
  runId?: string;
  snapshotRevisionId?: string;
  nodeRunId?: string;
  nodeAttemptId?: string;
  nodeLeaseId?: string;
  executionLeaseId?: string;
  executionOperationKey?: string;
  executionFactId?: string;
  workPackageId?: string;
  workPackageVersionId?: string;
  workspaceAllocationId?: string;
  integrationGenerationId?: string;
  integrationOperationId?: string;
  sessionId?: string;
  interactionTurnId?: string;
  participantId?: string;
  topicId?: string;
  reviewFindingId?: string;
  qualityGateResultId?: string;
  artifactVersionId?: string;
  defectId?: string;
  permissionRequestId?: string;
  nodeApprovalRequestId?: string;
  nodeApprovalDecisionId?: string;
  testCaseRevisionId?: string;
  testRunId?: string;
  securityReviewId?: string;
  operabilityReviewId?: string;
  deliveryCandidateInputId?: string;
  deliveryCandidateId?: string;
  releaseDecisionId?: string;
  releaseOperationId?: string;
  memoryCandidateId?: string;
  memoryEntryId?: string;
  improvementProposalId?: string;
  improvementApplicationOperationId?: string;
  commandId?: string;
  timestamp: string;
  payload: unknown;
}
```

`sequence` 只由 Company Runtime 分配；事件不可更新。所有可作为页面、过滤器或恢复入口的一等对象都使用顶层关联 ID，不能只藏在 `payload`。高频 `message.delta` 可以批量写入，Permission、State、Artifact、Review、Defect、Test、Candidate 和 Error 事件不得丢失。Event Registry 与 payload schema 单独版本化；旧 reader 按 `type + schemaVersion` 读取，重命名必须发布新 type 并保留旧 reader，不能只改字符串。

### 16.2 事件族

```text
product.proposal.revised / product.proposal.awaiting-confirmation / product.baseline.confirmed
department-run.formalized / department-run.started / department-run.paused / department-run.resumed / department-run.blocked / department-run.recovering / department-run.failed / department-run.cancelled / department-run.release-rejected / department-run.superseded / department-run.completed
node-run.started / node-run.waiting / node-run.paused / node-run.skipped / node-run.succeeded / node-run.failed
node-attempt.leased / node-attempt.renewed / node-attempt.reconciling / node-attempt.interrupted / node-attempt.completed
snapshot.revision.promoted / spec.revised / readiness.completed / technical-baseline-proposal.created / technical-baseline.accepted
review.scheduled / review.finding.created / review.discussion.round
review.revision.created / review.recheck.completed / quality-gate.completed
work-package.assigned / workspace-allocation.planned / workspace-allocation.ready / workspace-allocation.failed / work-package.started / work-package.self-check
code-review.completed / integration.generation.started / integration.started / integration.completed / integration.generation.failed / integration.generation.completed
defect.created / defect.assigned / defect.reopened / defect.closed
test.case.created / test.run.started / test.evidence.recorded / test.run.completed
security-review.completed / operability-review.completed
delivery-candidate.input-frozen / delivery-candidate.assembled / release-decision.recorded / release-operation.reconciling / release-operation.completed / release-operation.failed
permission.requested / permission.decided / intervention.recorded
approval.requested / approval.decided
statistics.recorded / improvement-proposal.created / improvement-proposal.decided / improvement-application.completed
memory.candidate.created / memory.reviewed / memory.accepted / memory.rejected
artifact.version.created / artifact.superseded / usage.recorded / commit.created
interaction.turn.started / interaction.turn.reconciling / message.delta / tool.call / tool.result / interaction.turn.completed / interaction.turn.failed / interaction.turn.cancelled / interaction.turn.interrupted
runtime.error
```

上表是最低事件族，不替代 Slice 0 的逐-type Event Registry；任何新 producer 必须先登记 required scopes/schema/retention/mapping。`cursor.accepted`、`runtime.resync.required`、subscription closed/heartbeat 是 transport control frame，不写 Runtime Event Outbox；Ack 结果只存在于 CommandResult、Audit 和 Cursor row。Sandcastle core 已发布的 `run.*` / `iteration.*` 名称保持原义；Company 领域使用 `department-run.*` / `node-run.*` / `node-attempt.*`。

### 16.3 AG-UI Adapter 和 Custom Event

AG-UI 只消费 Runtime Events：

| Runtime Event                                                                                | AG-UI 映射                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `department-run.*`                                                                           | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` 或 status event               |
| `node-run.*`, `node-attempt.*`                                                               | `STEP_STARTED`, `STEP_FINISHED`, `STEP_FAILED`；`skipped` 是 Custom 状态 |
| `message.delta`                                                                              | `TEXT_MESSAGE_CONTENT`                                                   |
| `tool.call`                                                                                  | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`                     |
| `tool.result`                                                                                | `TOOL_CALL_RESULT`；结构化结果 canonical JSON 序列化为 string，保留 ref  |
| `usage.recorded`, `commit.created`                                                           | 标准 Usage/Custom event                                                  |
| Snapshot / Artifact / Permission / Review / Test / Defect / Candidate / Intervention / Error | `CUSTOM`，名称为 `sandcastle.<domain>.<verb>`                            |

Custom Event payload 必须包含原始 `eventId`, `sequence`, scope IDs、registryVersion、schemaVersion 和 evidence refs；AG-UI Adapter 失败只影响消费者，不回滚 Runtime。

### 16.4 ACP Session

ACP Facade 通过 stdio 或受认证 local IPC 连接现有 Company Runtime，并严格使用含 `jsonrpc: "2.0"` 的 request/response/notification envelope。Sandcastle Facade 在 ACP 中扮演 Agent，编辑器/宿主扮演 Client：

| 方向           | ACP                                          | Runtime 映射                                                                     |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Client → Agent | `initialize`                                 | Runtime health、capabilities、Company Agent Adapter/Sandbox summary              |
| Client → Agent | `session/new`                                | `OpenInteractionSession`，显式绑定 AI member/context                             |
| Client → Agent | `session/load`（v1）/ `session/resume`（v2） | 若协商 capability 支持，恢复既有 Session；replayFrom 映射 Run Record/Cursor      |
| Client → Agent | `session/prompt`                             | 接受 Command 创建持久化 Interaction Turn；ACP 响应在 Turn 终止时返回 stop reason |
| Client → Agent | `session/cancel` notification                | `CancelInteractionTurn`；只有显式授权时才升级为 Node cancel                      |
| Agent → Client | `session/update` notification                | 从 Runtime Event 映射消息、Tool、Plan、Usage 和 Custom domain updates            |
| Agent → Client | `session/request_permission` request         | 创建/关联 Runtime Permission Request；Client JSON-RPC response 映射 Decision     |

Company Runtime 的 prompt Command 立即持久化并返回 `turnId` 给 Facade；Facade 保持原 ACP request pending，在执行期间发送 `session/update`，Turn 收敛后才返回 ACP `session/prompt` result。Facade 必须同时拥有 inbound request handler、outbound notification writer 和 pending request correlation map；不能把 `session/update` 实现为 Client pull method，也不能把 `session/request_permission` 当作 Client 主动发来的 decide Command。ACP Client 不等于 AI member；连接 principal 只能执行 capability/permission matrix 授权的 Session 与 Permission 操作，不得修改 Pipeline、Snapshot、Worktree、Artifact 状态或 Human release decision。

### 16.5 Cursor 和断线恢复

订阅协议：

1. 初始加载或 resync 先建立 client-side barrier：preload 将旧 generation 标为 invalid、停止 credits、要求 Electron main 丢弃其未发送队列，并等待当前 callback settle；`closeEventStream` 只有该 barrier 完成后才 resolve。Renderer reload 时 main 直接撤销旧 window generation。Barrier 后旧 frame 不得再触达或修改 View。
2. Query 返回 `{ view, asOfSequence, viewSyncToken }`；Client 只在 barrier 后应用完整 View，再用 token 执行 `ack-runtime-events(sequence=asOfSequence)`。Runtime 唯一消费 token、supersede server-side generation，并把 `asOfSequence` 作为新流 barrier sequence。相同 Command 重放原结果；不同 Command 重用 token 返回 `VIEW_SYNC_TOKEN_USED`。
3. 受信 transport 分配稳定 `consumerId`。Client 请求打开无过滤订阅但不提交 cursor；Runtime 只从服务端 durable last acknowledged sequence 开始，每次 `open` 原子递增 generation、重置 delivered boundary 并 supersede 旧 handle。Runtime 先返回 `{ subscriptionGeneration, barrierSequence }` 的 `cursor.accepted` control frame，再交付更大 sequence。
4. 每个 main→preload→renderer frame 都携带 subscription ID/generation；main 和 preload 都只转发当前 generation，Renderer callback wrapper 也丢弃非当前 generation。Subscription handle 按 generation 推进 `lastDeliveredSequence`；普通 Ack 必须携带 active generation，旧 generation 的 read/frame/Ack 返回或映射为 `SUBSCRIPTION_SUPERSEDED`。
5. Runtime 在 `runtime_event_cursors` 保存 owner principal、active generation、last acknowledged/delivered sequence、last seen 和 expiry；Client 也持久化最近 Ack 作为恢复提示，但服务端记录是清理和补发的权威。过期 consumer 只能由 policy/明确 retire Command 移除。View token 密钥轮换使未消费 token 失效，Client 重新 Query。
6. 若事件已压缩，返回 `CURSOR_EXPIRED` + `runtime.resync.required`；Client 重做 barrier→Query→View sync Ack→open。重复事件按 `eventId` 丢弃，任何 generation 内都只 Ack 最高连续 sequence。
7. Text Delta 可以压缩为 Message Content Artifact，但状态、权限、审计、质量门、Defect、Candidate 和失败证据事件长期保留。Outbox lag 以最新 global sequence 与最慢 active cursor 计算。

## 17. 权限、风险、Lease、幂等和失败恢复

### 17.1 最小权限

Permission Policy 的计算输入为 verified actor principal、Position、Work Package scope、Repository/Application、Sandbox、操作类型、风险 tier、Snapshot 和 Secret Reference。默认拒绝；安全的只读操作可按 Execution Profile 预授权，其余 `ask` 并写 Permission Request/Decision。Envelope 的 actor 只是经 transport 验证后的事实，业务 payload 中同名字段没有授权效果。

- Product manager：写 Product Proposal；在正式 Run 中被分派时可写 Project Spec draft 和产品 finding resolution，不能确认自己的 Baseline。
- Coordinator：编排、分派、升级、组装 Candidate；无代码写和 CR/Release 批准权。
- Software architect：读取 promoted Project Spec/readiness，写 Application Spec drafts / Technical Baseline Proposal revisions 和 technical finding resolution；无 accepted Technical Baseline、Developer Worktree、CR、Integration 或 Release 决定权。
- Developer：只写自己 allocation 的 isolated execution tree 并声明 commit/patch/Artifact；不能写 host/shared refs，source branch 只由 Runtime importer 推进。
- Reviewer/Tester/Security/Operability：只读实现上下文，写各自报告和 finding，不写 Developer Worktree。
- ACP Client、Renderer 和 Test driver 只能通过已声明 Command；不能借助 Session/Tool payload 获得更高权限。
- 只有 Pipeline Runtime 写 Run/Node 状态；只有 verified human principal 写 Product Baseline confirmation 和 Human release decision。
- Secret Reference 只解析到 provider scope；Token、完整环境变量、签名 URL 不进入 Event、Snapshot、Artifact 或日志。

### 17.2 Lease

Claim execution target 使用事务条件：Node Attempt 必须可执行、依赖满足且 Run 未暂停/取消；standalone Interaction Turn 必须为 queued、通过 side-effect capability check 且 Session 有效。任一 target/operation 同时只能有一个 active execution 或 reconciliation Lease。写入 lease id/kind、worker、expiry、epoch/fence token 和唯一 operation key 后才启动 Worker；Work Package operation key 还进入 Workspace Allocation。Worker 定期续租并写 checkpoint；续租失败立即停止新副作用。

```ts
interface ExecutionLeaseContext {
  leaseId: string;
  leaseKind: "execution" | "reconciliation";
  operationKey: string;
  target:
    | { kind: "node-attempt"; id: string }
    | { kind: "interaction-turn"; id: string };
  executionEpoch: number;
  fenceToken: string;
}

interface AdapterExecutionFact {
  adapterSchemaVersion: number;
  factId: string;
  ordinal: number;
  kind:
    | "provider-started"
    | "agent-session"
    | "message"
    | "tool-call"
    | "tool-result"
    | "permission-request"
    | "checkpoint"
    | "artifact"
    | "commit"
    | "usage"
    | "not-started"
    | "completed"
    | "failed"
    | "cancelled";
  schemaVersion: number;
  payload: unknown;
  evidenceRefs: string[];
}

interface ExecutionFactEnvelope extends AdapterExecutionFact {
  operationKey: string;
  target: ExecutionLeaseContext["target"];
  leaseId: string;
  leaseKind: ExecutionLeaseContext["leaseKind"];
  executionEpoch: number;
  fenceToken: string;
  canonicalPayloadHash: string;
}

interface ExecutionEventSink {
  record(fact: AdapterExecutionFact): Promise<{
    status: "accepted" | "duplicate" | "stale";
    executionFactId: string;
    effectIds: string[];
  }>;
}

interface ExecutionCompletion {
  operationKey: string;
  terminalExecutionFactId: string; // persisted execution_facts row, not Adapter factId
  status: "succeeded" | "failed" | "cancelled";
  evidenceRefs: string[];
}

type ReconcileResult =
  | {
      status: "not-started";
      terminalExecutionFactId: string;
      evidenceRefs: string[];
    }
  | { status: "running"; providerExecutionRef: string }
  | {
      status: "succeeded" | "failed" | "cancelled";
      terminalExecutionFactId: string;
      evidenceRefs: string[];
    }
  | { status: "unknown"; evidenceRefs: string[] };

interface ExecutionAdapter {
  readonly capabilities: {
    reattachRunningOperation: boolean;
    strongExecutionFence: boolean;
    enforceNoSideEffects:
      | false
      | {
          mechanism: "model-only" | "sandbox-policy";
          mechanismVersion: string;
          policySchemaHash: string;
        };
  };
  execute(
    request: ExecutionRequest,
    sink: ExecutionEventSink,
    signal: AbortSignal,
  ): Promise<ExecutionCompletion>;
  cancel(operationKey: string): Promise<"cancelled" | "not-found" | "unknown">;
  fence(
    operationKey: string,
  ): Promise<
    | { status: "fenced"; evidenceRef: string }
    | { status: "unsupported" | "unknown" }
  >;
  reconcile(
    input: {
      operationKey: string;
      reconciliationLease: ExecutionLeaseContext;
    },
    sink: ExecutionEventSink,
  ): Promise<ReconcileResult>;
  reattach(
    request: ExecutionRequest,
    providerExecutionRef: string,
    sink: ExecutionEventSink,
    signal: AbortSignal,
  ): Promise<ExecutionCompletion>;
}
```

`sandbox-policy` 只保留协议扩展位；v1 对 `sideEffectPolicy="none"` 的 capability validation 只接受 `mechanism="model-only"`。

`ExecutionRequest` 至少固定完整 `ExecutionLeaseContext`、Company Agent Adapter ID、permission scope、`sideEffectPolicy`、completion signal、timeout 和 target-specific immutable context：Node target 包含 Workspace allocation/Work Package/Attempt/Snapshot/Sandbox capability，standalone Turn 包含 Interaction Session、model-only mechanism 和 immutable context hash。Production Adapter 必须启用 Session capture。`ExecutionEventSink` 由 Runtime 绑定并私有持有 lease context：Adapter 只能提交 `AdapterExecutionFact`，不能自报 operation/target/lease/fence，Runtime 才组装并持久化 `ExecutionFactEnvelope`。

`sink.record()` 每次只走一个 SQLite Unit of Work：canonicalize/hash → 检查 `(operationKey,factId)` 与 `(operationKey,executionEpoch,ordinal)` → 校验 active target/lease/fence → append Fact → CAS domain state/Artifact/Permission → Audit/Outbox → 保存 receipt。相同 identity/hash 重放返回首次 receipt，不产生第二次状态或 Event；相同 identity 但不同 hash 返回 `EXECUTION_FACT_CONFLICT`，保留冲突 evidence 并使 target `reconciling`/blocked；旧 fence 返回并保存 `stale` 诊断，不能完成新 Attempt/Turn。Terminal fact 使用 CAS，每个 operation/epoch 最多一个。

`execute`/`reattach` 返回值不是第二条完成通道：它只能引用该 bound sink 已接受的 terminal fact；缺失、stale、冲突或 status 不一致都触发 Adapter protocol failure 并进入 reconcile。`reconcile` 必须在 active reconciliation Lease 下使用新的 bound sink；其 `not-started/succeeded/failed/cancelled` 结果同样只能引用该 sink 已接受的 terminal fact。`not-started` fact 必须包含 Provider receipt/evidence，证明该 operation key 从未开始外部执行；裸枚举不能终结 target。`ProductionExecutionAdapter`/`ScriptedExecutionAdapter` 与两个 Interaction Adapter 使用同样的 operation-key、sink、cancel、reconcile 和 reattach 语义；Scripted 实现不得把 reconcile 永远伪造为安全。

Lease 过期或 Runtime 崩溃时：

1. 原子使 execution Lease 过期并将 Node Attempt 或 standalone Turn 从 `running` 转为 `reconciling`，保存 Worktree、Interaction/Agent Session refs、log、commit、completion signal 和 checkpoint；不能先写终态。
2. Recovery worker 为同一 target/operation claim 唯一、短期 reconciliation Lease，建立绑定该新 epoch/fence 的 sink，再调用 `reconcile` 并交叉检查 Provider process、git tip、Artifact journal/hash 和 external side-effect evidence。
3. `succeeded/failed/cancelled` 只有在 reconciliation sink 接受对应 terminal fact 后才收敛原 target。`running` 要求 Adapter 支持 reattach；Runtime 先释放 reconciliation Lease、发放新 execution Lease，并把含新 context 的 `ExecutionRequest` 与新 sink 交给 `reattach`，成功接管后才转回 `running`。
4. 只有 reconciliation sink 已接受带 Provider receipt/evidence 的 `not-started` terminal fact，Runtime 才能在同一 Unit of Work 把原 target 终结为 `interrupted`；Node 可按策略创建新 Retry，standalone Turn 可接受新的 prompt Command。`unknown` 保持 `reconciling`/blocked；human 只能提供或触发外部终止证据，不能仅“接受风险”放行重复执行。只有 accepted provider terminal fact，或 `strongExecutionFence` 返回可验证 evidence 且后续 reconcile 不再 running，才能进入 `interrupted/cancelled` 并允许新执行。

### 17.3 幂等性

- Command receipt 以 `commandId` 查找，以 canonical request hash 防复用；hash 包含 schemaVersion、verified actor/consumer context、expectedRevision 和 command body。相同 ID/context/hash 重放持久化 success 或 deterministic rejection 与 effect IDs，任何差异返回 `COMMAND_ID_REUSE`；当前 revision 不得先于 receipt lookup 再校验。
- Node Attempt 用 `runId/nodeRunId/attemptId`；完成、失败、释放要求持有当前 lease。
- Integration 用 operationId + expected Integration-branch tip；重复调用返回首次结果，Integration tip 变化返回 `INTEGRATION_CONFLICT`。Release 使用独立 operationId + accepted decision + discriminated destination preconditions。
- Artifact Version 以 content hash + logical producer context 去重，语义变化使用新 version。
- Event Consumer 以 eventId 去重，以 sequence 检测丢失；Adapter 重试不产生第二份业务状态。

### 17.4 Failure evidence 和恢复

所有失败至少保存 Company failure kind（`infrastructure | agent | task | quality | permission | unknown`）、phase、code/message、recoverable、Worktree、Session id/file ref、Run log、commit refs、completion signal、Snapshot/Attempt/Turn 和下一步允许的 action；它不扩展 Sandcastle core `run.error` 的四值 public kind。只有经 Adapter reattach 证明仍在运行的 operation 可继续原 Attempt/Turn；终态后的 Retry/Recovery 永远创建新 Attempt/Turn，边界变化创建新 Run。

## 18. Memory、统计和 Improvement proposal

### 18.1 Memory promotion

Runtime/Agent 只能通过 `propose-memory` 从 exact Run Record/Artifact/Review evidence 创建 scope 为 `project | ai-member` 的 Memory Candidate revision；原始 Transcript、私有思维链、secret、未脱敏 Tool Result 和其他 Project 内容不得自动进入。状态为：

```text
draft → review → accepted | rejected
```

`decide-memory` 绑定 exact candidate revision/hash、独立 review evidence 和 verified human actor；每个 revision 最多一个 append-only decision。Producer/被提议 AI member 不能批准自己的 candidate。`accepted` 物化 immutable Memory Entry；`rejected` 不删除候选证据。Project Memory 只能在同 Project 选择，AI-member Memory 仍受目标 Project/Position permission policy 过滤，任何跨 Project promotion 都需新的 candidate/decision。

Future Run/Session 不读取 mutable latest Memory。创建 Snapshot Revision 时，Runtime 通过 `run_memory_selections` 固定 accepted Memory Entry revisions、selection reason 和 policy hash；未入 Snapshot 的 Memory 不得影响正式 Node Attempt。Desktop 与 ACP 只通过同一 `propose-memory` / `decide-memory` Command 和 Query View 操作，不能从聊天文本直接写 accepted entry。事件至少包括 `memory.candidate.created`、`memory.reviewed`、`memory.accepted`、`memory.rejected`；测试必须证明重复 promotion 幂等、scope 隔离、redaction 和未接受内容不被加载。

### 18.2 Statistics

Statistics Module 只读取 Run Record、Audit、Event、Artifact、Defect 和 Gate 结果，按 Project、Department、AI member、Model、Repository、Work Package、Pipeline Version 和时间窗口聚合：

- Baseline 确认轮次/耗时；Review finding、冲突、讨论轮次、复核通过率；
- readiness blocker、并行度、返工、CR 缺陷率、集成冲突；
- Test 通过率、Electron UI/Runtime 不一致率、Security/Operability 高风险关闭率；
- Run 失败/恢复、Lease interruption、等待时间、Token、成本、人工介入和 candidate 接受率。

### 18.3 Improvement proposal

Improvement proposal 必须包含 evidence query、根因假设、建议改动（Harness/Spec/template/Skill Flow）、影响范围、预期指标、验证计划、灰度/回滚路径和人工 approver。状态为：

```text
draft → proposed → awaiting-human → approved | rejected
approved → applying → applied | apply-failed
applied → validated | rollback-requested → rolled-back
```

Proposal revision、Human decision 和 `improvement_application_operation` 都是 append-only。批准只授权一次显式 apply Command；apply 创建新的 Harness/Spec/template/Skill Flow revision，但不修改当前 Run，也不自动 publish/activate。Rollback 创建新的恢复 revision 并保留 applied revision；后续 Snapshot 只有在独立发布/选择后才引用它。Runtime 不根据单次失败隐式改变规则，before/after 指标必须可比较。

## 19. 错误和恢复命令

稳定错误码至少包括：

| 类别       | 错误码                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation | `BASELINE_INCOMPLETE`, `SPEC_CONTRACT_MISMATCH`, `PIPELINE_INVALID`, `RISK_POLICY_BLOCKED`                                                                                                                                                                  |
| Conflict   | `VERSION_CONFLICT`, `COMMAND_ID_REUSE`, `COMMAND_IN_PROGRESS`, `APPROVAL_DECISION_EXISTS`, `EXECUTION_FACT_CONFLICT`, `INTEGRATION_CONFLICT`, `RELEASE_DECISION_EXISTS`, `RELEASE_DESTINATION_CONFLICT`                                                     |
| Permission | `PERMISSION_REQUIRED`, `PERMISSION_DENIED`, `SECRET_REFERENCE_UNAVAILABLE`                                                                                                                                                                                  |
| Execution  | `AGENT_FAILED`, `SANDBOX_FAILED`, `NODE_TIMEOUT`, `COMPLETION_SIGNAL_MISSING`, `SKILL_VERSION_UNAVAILABLE`                                                                                                                                                  |
| Recovery   | `LEASE_EXPIRED`, `ATTEMPT_INTERRUPTED`, `CHECKPOINT_MISSING`, `SESSION_NOT_RESUMABLE`, `RECONCILE_UNKNOWN`                                                                                                                                                  |
| Evidence   | `ARTIFACT_INTEGRITY_FAILED`, `EVIDENCE_INCOMPLETE`, `CURSOR_EXPIRED`, `CURSOR_AHEAD`, `SNAPSHOT_INTEGRITY_FAILED`                                                                                                                                           |
| Storage    | `STORE_BUSY`, `STORE_CORRUPT`, `MIGRATION_FAILED`, `SNAPSHOT_HASH_MISMATCH`                                                                                                                                                                                 |
| Protocol   | `COMPANY_RUNTIME_UNAVAILABLE`, `ACP_SESSION_NOT_FOUND`, `IPC_AUTH_FAILED`, `EXECUTION_ADAPTER_PROTOCOL`, `PROVIDER_ISOLATION_REQUIRED`, `CONSULTATION_ISOLATION_REQUIRED`, `HANDLER_VERSION_UNAVAILABLE`, `SUBSCRIPTION_SUPERSEDED`, `VIEW_SYNC_TOKEN_USED` |

错误返回稳定 code、safe message、相关 IDs、recoverability 和允许 Command；不把 raw secret、完整环境或未脱敏 Tool Result 放进错误 payload。

## 20. IPC、Query View 和 Renderer 边界

Electron main 通过 `MessageChannelMain` 建立 response stream：一端消费 Company Runtime 的有界 subscription batches，另一端经 `webContents.postMessage` 交给 preload。每个 delivery frame 包含 `subscriptionId + subscriptionGeneration + barrierSequence + event/control`；main/preload 维护同一 current generation。`closeEventStream` 是 barrier：停止 credit、丢弃排队 frame、等待 active callback settle 后才返回。preload 不暴露 `ipcRenderer`、MessagePort 或原始 Runtime socket；Ack 仍走统一 Command。

Main 只接受已登记 BrowserWindow 的 main frame、exact packaged/dev origin 和当前 `webContents`；subframe、跨 origin、导航后的 stale sender、销毁窗口和猜测 subscription ID 全部拒绝。Window 禁止任意 navigation/new-window，启用严格 CSP、`contextIsolation` 和 renderer sandbox；reload/destroy 原子撤销 Port/generation。Frame schema 设置版本、最大字节数、batch/credit/backpressure 上限并拒绝 unknown fields。真实 Electron security E2E 必须覆盖 hostile iframe、stale Port、oversized frame、reload race 和错误 sender，不能只验证 happy path。

Preload 只暴露：

```ts
window.sandcastle = {
  execute(input: {
    commandId: string;
    expectedRevision?: number;
    command: CompanyCommand;
  }): Promise<CommandResult>; // actor/consumer metadata 由 main 注入
  query(query): Promise<{
    view: unknown;
    asOfSequence: number;
    viewSyncToken: string;
  }>;
  openEventStream(
    onFrame: (
      frame: {
        subscriptionId: string;
        subscriptionGeneration: number;
        barrierSequence: number;
        value: EventEnvelope | EventStreamControlFrame;
      },
    ) => void | Promise<void>,
  ): Promise<{
    subscriptionId: string;
    subscriptionGeneration: number;
    barrierSequence: number;
  }>;
  closeEventStream(input: {
    subscriptionId: string;
    subscriptionGeneration: number;
  }): Promise<void>;
  selectCompanyDirectory(): Promise<DirectoryRef>;
  openArtifact(ref): Promise<void>;
};
```

Renderer View 至少包括 `CompanyOverviewView`、`ProjectDetailView`、`ProductDiscoveryView`、`SpecView`、`PipelineView`、`RunSupervisionView`、`ReviewTopicView`、`WorkPackageView`、`QualityGateView`、`DeliveryCandidateView` 和 `InteractionWorkspaceView`。View 只含稳定 IDs、plain enum 和脱敏引用；`asOfSequence` 只存在于统一 QueryResult envelope。Renderer 不拼接 SQL，不计算状态转换，不拥有 Lease、consumerId 或 actor identity。

## 21. 目标代码布局和已有实现接缝

实现优先落在现有 `apps/desktop/runtime`，不把 Electron/SQLite 引入根 `src/` 公共包：

```text
apps/desktop/
├─ main/                         Electron shell / Runtime supervisor / MessagePort relay
├─ preload/                      narrow typed bridge / validated event callbacks
├─ runtime/
│  ├─ interface.ts               command/query/event schemas
│  ├─ server.ts / entry.ts       Company Runtime process
│  ├─ storage/                   SQLite, migrations, UoW context, journals, backups, locks
│  ├─ catalog/                   Company, Department, Position, Agent, Skill
│  ├─ project/                   Project, Repository, Application, Spec, Technical Baseline
│  ├─ pipeline/                  closed nodeType, handlerKind, Runtime, Lease/reconcile
│  ├─ review/                    Review topic, finding, discussion, recheck, Gate Result
│  ├─ workspaces/                Work Package, allocation, Integration Generation/operation
│  ├─ quality/                   CR, Test, Security, Operability, Defect
│  ├─ delivery/                  Candidate and Human release seam
│  ├─ interaction.ts             Session, Turn, Permission, Intervention
│  ├─ memory/                    candidate, review, promotion, Snapshot selection
│  ├─ artifactRegistry.ts        immutable Artifact, write journal and lineage
│  ├─ events/                    registry, outbox, cursor, AG-UI adapter
│  ├─ acp.ts / acpEntry.ts       bidirectional local ACP facade
│  ├─ adapters/                   Production/Scripted Execution + InteractionExecution adapters
│  └─ testing/                   ScriptedRuntimeTransport and real Electron fixtures
└─ renderer/                     read-model UI only
```

当前 `catalog`, `project`, `pipeline`, `artifactRegistry`, `interaction`, `storage`, `agUiAdapter` 和 `acp` 是迁移起点，不代表已经满足 Draft 3 契约；现有逐 Command channel、轮询、简化 Event/ACP 和 execution-only script seam 必须按 Slice 0–2 收敛。现有 `adapters/scriptedExecutionAdapter` 承载 `ScriptedExecutionAdapter`；还需 `ScriptedInteractionExecutionAdapter`。`testing/scriptedRuntime` 只是 transport-level fake。

## 22. 实施切片和依赖顺序

### Slice 0：契约和存储骨架

- 定义 IDs、Command/Query/Event Envelope、verified actor、Unit of Work context、error codes、schema migration、Company Directory lock、audit/outbox/cursor/dedup 和 Artifact write journal。
- 在任何领域 producer 写 Outbox 前冻结 Event Registry v1：每个 type 的 required top-level scope IDs、payload schema、terminal/error semantics、retention class 及 AG-UI/ACP mapping intent。后续 Slice 只能在先提交 registry/schema migration 与 contract tests 后增加事件，不能先写临时 payload 再由 Adapter 猜测。
- 建立单一 typed IPC tunnel、MessagePort event stream 与 Scripted transport；验证 Runtime 单写者、崩溃重启、migration/backup、Ack 不自激和 diagnostic/draining lifecycle。

### Slice 1：Catalog、Baseline、Spec、Harness

- Product proposal/baseline hard gate 原子创建 Run/r1；Project Spec→Product Review→readiness→Application Specs/Technical Baseline 的 Gate promotion；Project/Application refs、contracts、Harness/Skill snapshots。
- 只做配置和版本冻结，不启动 Agent。

### Slice 2：Pipeline Runtime 核心

- ADR 0031 闭集 nodeType + handlerKind registry、Node graph validation、Node Run/Attempt、Ready Queue、Lease、Pause/Cancel/Retry/Recovery/Fork。
- `ProductionExecutionAdapter`/`ScriptedExecutionAdapter` 与两个 `InteractionExecutionAdapter` 完成 operation key、ExecutionEventSink、cancel/reconcile/reattach 和 idempotency contract；Interaction Turn 绑定正式 Node Attempt 或无副作用 consultation。

### Slice 3：Review Module

- Product/Technical/Code Review Topic、independent finding、bounded discussion、revision、fresh re-review、immutable Gate Result 和 PASS-only promotion。

### Slice 4：Work Package 和 Integration

- Dependency graph、fan-out、assignment、branch/Worktree/Sandbox/Session allocation、Provider capability checks、independent CR、per-repository Integration Generation/branch、partial-failure rebuild 和 Integration defect。

### Slice 5：Quality Gates、Candidate Input 和真实 Electron Fixture

- Test Case/Test Run、Runtime/UI correlation、`ScriptedExecutionAdapter` + `ScriptedInteractionExecutionAdapter` + 真实 Company Runtime、temporary Company Directory、immutable Candidate Input、Security/Operability risk tiers and PASS gates。

### Slice 6：Delivery 和 Supervision

- Candidate Input/manifest/hash、Human release decision 与 Run transitions、idempotent multi-repository release operation、RunSupervisionView、observe/pause/cancel/consult/intervention。

### Slice 7：Protocol、Memory、Statistics 和稳定性

- 基于 Slice 0 registry 实现 AG-UI standard/custom Adapter、双向 ACP Session/update/permission/replay、跨版本 readers、Memory candidate/review/promotion/scope isolation，及 statistics rollups、Improvement apply/rollback、event compaction、failure diagnostics、long-run recovery；本 Slice 不重新定义 Slice 1–6 已发布事件。

每个 Slice 都要有 co-located module tests、migration fixture 和至少一个真实 Company Runtime end-to-end boundary test；`ScriptedRuntimeTransport` client contract tests 从 Slice 0 起执行，两个 Scripted Execution Adapter Runtime contract tests 从 Slice 2 起执行，后续 Slice 均作为回归门。Slice 只有在其前置 lineage 和 state/event contracts 已冻结后开始。

## 23. 测试边界和故障场景

### 23.1 Module Interface tests

- Company Runtime：verified actor、Command result replay、expected revision、permission、Unit of Work、ADR 0038 trigger context、Ack-only audit、Renderer reload 不影响 Run。
- Pipeline Runtime：confirmation/fork atomic Run/r1、闭集 nodeType/exact handler version、所有 Run/Node/Attempt/standalone Turn 状态转换、Join/Condition skipped、两种 lease target 的 expiry→reconciling→reattach/terminal、Fact duplicate/stale/conflict/fence、cancel/recovery。
- Spec/Readiness：Project Spec→Product PASS→readiness PASS→Application Specs/Technical Baseline Proposal PASS→accepted Baseline promotion、多 Repository、契约版本不兼容和 dirty policy。
- Review：discriminated exact input manifest、独立 finding 不被讨论覆盖、预算/round stop、fresh re-review、immutable Gate Result、conditional 不 promotion、Code PASS 绑定 exact package/commit/diff。
- Workspace/Integration：Worktree/Session uniqueness、private Git database、`gitRefWriteIsolation`/Runtime importer、host source/Integration/Release ref protection、Integration Generation partial failure、conflict ownership、operation idempotency。
- Quality：Test evidence、UI/Runtime correlation、risk-depth selection、Security/Operability gating。
- Memory：candidate source/redaction、independent review/human decision、scope isolation、Snapshot selection、未接受内容不可加载。
- Artifact：journal 各崩溃点、fsync/rename/finalize、startup reconcile、hash/lineage/supersede/integrity failure。
- Interaction/Event：两种 Turn lease/Node Attempt 绑定、model-only consultation 无副作用、permission、无过滤 cursor replay、single active subscription generation、View token single-use、Ack 不入 Outbox、duplicate delivery、Adapter failure isolation。

### 23.2 契约测试

- 四个 Production/Scripted Execution/InteractionExecution Adapters 共享 operation key、ExecutionEventSink、cancel/reconcile/reattach 行为契约。
- 每个 SQLite migration 从空库和上一版本逐级执行；备份恢复后 `quick_check` 和事件 sequence 连续。
- versioned Runtime Event → AG-UI standard/custom/TOOL_CALL_RESULT mapping 和 Runtime Event → outbound ACP update/request 使用固定 fixture。
- Company Runtime client、preload、Electron main、ACP facade 共享 Zod/plain-schema contract。
- Worktree Provider 的 bind-mount、isolated、no-sandbox capability matrix 共享测试样例，验证 branch strategy 仍是每次执行输入，并阻塞 writable shared Git refs、Session/hidden-context 或 credential 隔离缺失；至少一个本地 isolated profile 通过 Runtime-only source-branch import。

### 23.3 集成和 Electron tests

- 真实 Electron renderer + preload MessagePort + Company Runtime + temp Company Directory 完成 Product → Work Package → Candidate 的 scripted happy path；driver 只使用真实用户手势。
- Renderer reload/disconnect 后 Query `{ view, asOfSequence, viewSyncToken }` + sync Ack + 无过滤 Cursor replay 得到一致状态；重复 Ack 不产生新 Event，无 token 不能越过 last delivered。
- Electron security E2E 拒绝 subframe/wrong-origin sender、stale Port/generation、navigation/new-window 和 oversized frame，并验证 reload/destroy 后无旧 callback 修改 View。
- Agent/Runtime/SQLite 在 Node Running、Lease expired、Artifact write failure、provider crash 和 permission timeout 时保存可恢复 evidence。
- 并行同 Repository Work Packages 永不拿到相同可写 Worktree/Session；cache 冲突验证串行化，hidden-context/session 无法隔离验证阻塞。
- CR fail、Integration conflict、cross-app contract failure、Test defect、Security high finding 和 Operability recovery failure 都回到正确责任点。
- ACP 与 Desktop 对同一 Session、Interaction Turn、Permission、Run 和 Event Cursor 得到同一状态；验证 Agent→Client update/request_permission 方向、correlation 和 resume/load。

### 23.4 测试禁止事项

- 不用 Renderer mock 代替真实 Electron 交互路径。
- 不启动本机真实 Agent/Provider 作为默认测试前置条件。
- 不从 UI 文案、颜色、按钮存在或 Agent 自述推断质量门通过。
- 不直接写 SQLite 当前状态来构造“通过”结果；测试通过 Command、Scripted Adapter 和公开 Query/Event Seam。

## 24. 性能、诊断和容量假设

以下是 Slice 0/7 必须用基准测试验证的初始预算，不是已经由 PRD 确认的验收事实；实测不满足时先记录 profile/evidence，再由评审调整目标：

- Company Overview Query：10,000 Runs / 100,000 event summaries 时目标 P95 < 200ms。
- Command commit（不含 Agent 执行）目标 P95 < 100ms；状态/权限 Event 本机目标 P95 < 250ms。
- 初始默认活动 Node 4；按 Company、Provider、Department、Run、Repository capability 取最小并发，并用负载/资源证据校准。
- SQLite WAL、foreign keys、5s busy timeout；所有写入集中在 Runtime 单进程。
- 高频 text delta 50–100ms 批处理，Raw output 文件化；不可把无限 transcript 写入单个 SQLite row。
- Diagnostics 输出 command/run/node/session/event IDs、SQLite latency、outbox lag、queue、lease、provider status、worktree cleanup 和 failure evidence path，不输出 secrets。

## 25. 主要风险与控制

| 风险                            | 控制                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Company/Pipeline 状态分裂       | Company Runtime 单写者；Pipeline Runtime 是唯一 Node/Run 状态转换者；旧 Store 不参与。                  |
| 并行 Agent 互相覆盖             | 每包独立 branch/Worktree/Sandbox/Session；cache 冲突可串行，Session/hidden context 无法隔离则阻塞。     |
| Lease 过期导致副作用重复        | operation key + reconciliation lease；先 `reconciling`，仅 proven running 可 reattach，终态不静默回队。 |
| Review 变成无限群聊             | 固定 participant、scope、budget、maxRounds、moderator 和 stop condition。                               |
| Agent 自己批准工作              | 独立 Session、角色权限分离、CR/Test/Security/Operability 和 Human release 不可自批。                    |
| UI 显示与 Runtime 不一致        | QueryResult view-sync token + 无过滤 Event Cursor + MessagePort；Fixture 同时断言 UI 和 Runtime。       |
| 多仓库契约漂移                  | Project-level Contract、immutable Integration Generation、producer-first checks 和 Test evidence。      |
| 安全边界扩张                    | Position/Package/Repository/Sandbox/risk 最小权限、Secret Reference、默认拒绝。                         |
| Event Outbox 增长               | active cursor lag 驱动 compaction；高频事件压缩为 Artifact，状态/审计/质量门/失败证据长期保留。         |
| Improvement 隐式改规则          | proposal 只读统计产生；人工批准后新 revision，before/after 可比较。                                     |
| Electron / SQLite 原生 ABI 风险 | Slice 0 在 macOS/Windows/Linux 验证打包和迁移；失败进入诊断而不写入。                                   |

## 26. 技术方案完成定义

进入生产实现前，本文对应的设计审查必须确认：

1. Company Runtime 是 Company SQLite 的唯一写者，Pipeline Runtime 是 Run/Node 状态权威。
2. Product Baseline 确认原子创建 Run/r1；Project Spec、readiness、Application Specs 和 Technical Baseline 只由 PASS Gate promotion 固定。
3. 所有 Agent 执行可观察、可暂停、可取消、可咨询、可介入、可回放；Renderer 不拥有状态。
4. ADR 0031 闭集 nodeType 与 handlerKind registry 已冻结；每个正式 Work Package 都有独立 branch、Worktree、isolated Git/Sandbox、Session、Node Attempt 和 evidence，Agent 无法写 host/shared refs。
5. 独立 CR PASS、Integration Generation/branch/defect、真实 Electron Test Run、全 PASS Security/Operability 和 Human release seam 都有明确状态和证据契约。
6. Runtime Event Registry、AG-UI standard/custom Event、双向 ACP Session 和无过滤 Cursor replay 能在断线后恢复，Ack 不产生第二套事件。
7. Command result replay、Lease reconcile、Artifact journal、最小权限、schema migration、`ScriptedExecutionAdapter`/`ScriptedInteractionExecutionAdapter` 和 `ScriptedRuntimeTransport` 的测试边界已可直接拆成 tickets。

## 27. 后续实施文档

编码前应从本文拆出以下独立规格，而不是再创建另一套领域模型：

1. SQLite schema / migration、Unit of Work context、Artifact journal 和 lineage index 规格；
2. Company Command / Query / Event TypeScript contract、typed IPC tunnel 和 MessagePort stream；
3. Pipeline graph、closed nodeType/handlerKind registry、状态转换和 Lease/reconcile 表；
4. Review Topic / Finding / bounded Discussion / re-review contract；
5. Work Package、Provider capability、Worktree、Integration Generation/operation contract；
6. Test Case/Test Run、`ScriptedExecutionAdapter`/`ScriptedInteractionExecutionAdapter`、Electron Fixture、Runtime/UI correlation contract；
7. Security/Operability risk policy 和 minimum-permission matrix；
8. Delivery candidate manifest、Human release 和 future Deployment Adapter seam；
9. versioned AG-UI mapping、ACP outbound update/permission、cursor/replay/compaction contract；
10. Statistics、Improvement proposal、approval/apply/rollback operation contract。
