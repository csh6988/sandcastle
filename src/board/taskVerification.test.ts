import { describe, expect, it } from "vitest";
import type { WorkspaceTaskRepositoryResult } from "../runWorkspaceTask.js";
import type { BoardRunRecord, BoardTaskRecord } from "./BoardStore.js";
import { renderTaskVerificationReport } from "./taskVerification.js";

const taskWithIssue = (issueBody: string): BoardTaskRecord => ({
  id: "task-1",
  title: "工单分配上限调整",
  prompt: "PRD",
  status: "running",
  createdAt: "2026-07-01T00:00:00.000Z",
  runIds: ["run-1"],
  plan: {
    repositories: [
      {
        name: "vocmngweb",
        task: "实现工单分配上限管控前端",
        issue: {
          title: "实现工单分配上限管控前端",
          body: issueBody,
        },
      },
    ],
  },
});

const succeededRun: BoardRunRecord = {
  id: "run-1",
  name: "vocmngweb",
  agent: "claude-code",
  sandbox: "docker",
  branch: "codex/board/task/vocmngweb",
  maxIterations: 1,
  status: "succeeded",
  createdAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:01:00.000Z",
  commits: 0,
  taskId: "task-1",
  repo: "vocmngweb",
};

const succeededResult: WorkspaceTaskRepositoryResult = {
  task: "实现工单分配上限管控前端",
  status: "success",
  branch: "codex/board/task/vocmngweb",
  commits: [],
  stdout:
    "npm run build passed\nFor browser verification, use e2e-testing when needed.\nSee https://rollupjs.org/configuration-options/#output-manualchunks\n<promise>COMPLETE</promise>",
};

describe("renderTaskVerificationReport", () => {
  it("does not mark PRD integration criteria passed from a successful build alone", () => {
    const issueBody = `Status: ready-for-agent

## Acceptance criteria

- [ ] 创建账号/编辑账号表单支持每日工单分配上限字段，范围 0-99999，非必填
- [ ] 字段可按权限单独控制，组长类角色可只具备修改分配量的能力时不暴露无关账号编辑能力
- [ ] 分配超限时展示后端返回的拦截/失败信息，不把失败批次标记成已分配
- [ ] 复用项目现有 API、表单、权限和弹窗模式，不新增平行实现

## Verification

- [ ] 运行项目 build 或对应前端构建命令
- [ ] 手动验证单人新增/编辑、批量修改、权限隐藏/禁用、分配超限提示四类路径
`;

    const { report, markdown } = renderTaskVerificationReport({
      task: taskWithIssue(issueBody),
      repositoryResults: { vocmngweb: succeededResult },
      runs: [
        {
          run: succeededRun,
          events: [
            {
              seq: 1,
              event: {
                type: "agent-text",
                message:
                  "npm run build passed\nFor browser verification, use e2e-testing when needed.\nSee https://rollupjs.org/configuration-options/#output-manualchunks\n<promise>COMPLETE</promise>",
                iteration: 1,
                timestamp: "2026-07-01T00:00:30.000Z",
              },
            },
            {
              seq: 2,
              event: {
                type: "run-finished",
                iterationsRun: 1,
                timestamp: "2026-07-01T00:01:00.000Z",
              },
            },
          ],
        },
      ],
      now: new Date("2026-07-01T00:02:00.000Z"),
    });

    expect(report.status).toBe("needs-verification");
    expect(report.repositories[0]?.issueStatus).toBe("needs-verification");
    expect(markdown).toContain("Status: needs-verification");
    expect(markdown).toContain("## Verification matrix");
    expect(markdown).toContain(
      "| vocmngweb | local-command | verified | 运行项目 build 或对应前端构建命令 |",
    );
    expect(markdown).toContain(
      "| vocmngweb | browser-backend-integration | unverified | 手动验证单人新增/编辑、批量修改、权限隐藏/禁用、分配超限提示四类路径 |",
    );
    expect(markdown).toContain(
      "| vocmngweb | code-static-check | verified | 复用项目现有 API、表单、权限和弹窗模式，不新增平行实现 |",
    );
    expect(markdown).toContain("No browser/backend integration evidence");
    expect(markdown).toContain(
      "Passing build/run evidence is not enough to mark PRD acceptance criteria complete.",
    );
  });

  it("classifies a pre-agent sandbox create failure as an infrastructure failure needing recovery", () => {
    const createFailure =
      "Provider 'docker' create failed: Image 'sandcastle:sandcastle' not found locally. Build it first with 'sandcastle docker build-image'.";
    const { report, markdown } = renderTaskVerificationReport({
      task: taskWithIssue(`Status: ready-for-agent

## Acceptance criteria

- [ ] 创建账号/编辑账号表单支持每日工单分配上限字段
`),
      repositoryResults: {
        vocmngweb: {
          task: "实现工单分配上限管控前端",
          status: "failed",
          branch: "codex/board/task/vocmngweb",
          commits: [],
          error: createFailure,
        },
      },
      runs: [
        {
          run: {
            ...succeededRun,
            status: "failed",
            error: createFailure,
            commits: 0,
          },
          events: [
            {
              seq: 1,
              event: {
                type: "iteration-started",
                iteration: 1,
                maxIterations: 1,
                timestamp: "2026-07-01T00:00:00.100Z",
              },
            },
            {
              seq: 2,
              event: {
                type: "run-failed",
                message: createFailure,
                timestamp: "2026-07-01T00:00:00.900Z",
              },
            },
          ],
        },
      ],
      now: new Date("2026-07-01T00:02:00.000Z"),
    });

    expect(report.status).toBe("needs-recovery");
    expect(report.repositories[0]?.issueStatus).toBe("needs-recovery");
    expect(report.repositories[0]?.infrastructureFailure).toBe(true);
    expect(report.infrastructureFailures[0]).toContain(
      "Provider 'docker' create failed",
    );
    expect(markdown).toContain("Status: needs-recovery");
    expect(markdown).not.toContain("No infrastructure failures detected.");
  });

  it("keeps a delivery failure with recorded agent work as verification-failed", () => {
    const { report } = renderTaskVerificationReport({
      task: taskWithIssue(`Status: ready-for-agent

## Acceptance criteria

- [ ] 创建账号/编辑账号表单支持每日工单分配上限字段
`),
      repositoryResults: {
        vocmngweb: {
          task: "实现工单分配上限管控前端",
          status: "failed",
          branch: "codex/board/task/vocmngweb",
          commits: [],
          stdout: "tests failed",
          error: "Agent idle for 600 seconds",
        },
      },
      runs: [],
      now: new Date("2026-07-01T00:02:00.000Z"),
    });

    expect(report.status).toBe("failed");
    expect(report.repositories[0]?.issueStatus).toBe("verification-failed");
    expect(report.repositories[0]?.infrastructureFailure).toBe(false);
  });
});
