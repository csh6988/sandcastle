import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectLanguage,
  departmentName,
  loadPreferredLanguage,
  messages,
  pipelineNodeName,
  positionName,
  positionResponsibility,
  savePreferredLanguage,
  statusName,
} from "../renderer/i18n.js";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("desktop renderer i18n", () => {
  it("detects Chinese from browser language preferences", () => {
    assert.equal(detectLanguage(["zh-CN", "en-US"]), "zh");
    assert.equal(detectLanguage(["en-US", "zh-TW"]), "zh");
    assert.equal(detectLanguage(["en-US"]), "en");
  });

  it("persists an explicit language choice ahead of system detection", () => {
    const storage = new MemoryStorage();

    assert.equal(loadPreferredLanguage(storage, ["zh-CN"]), "zh");

    savePreferredLanguage(storage, "en");

    assert.equal(loadPreferredLanguage(storage, ["zh-CN"]), "en");
  });

  it("localizes the built-in Department catalog by stable ids", () => {
    const t = messages.zh;

    assert.equal(
      departmentName(t, { id: "software-rnd", name: "Software R&D" }),
      "软件研发",
    );
    assert.equal(
      positionName(t, { id: "software-architect", name: "Software Architect" }),
      "软件架构师",
    );
    assert.equal(
      positionResponsibility(t, {
        id: "software-engineer",
        responsibility: "Implements and tests the approved delivery plan.",
      }),
      "按批准的交付方案实现并测试。",
    );
    assert.equal(
      pipelineNodeName(t, {
        id: "human-acceptance",
        name: "Human acceptance",
      }),
      "人工验收",
    );
    assert.equal(statusName(t, "published"), "已发布");
  });

  it("localizes Department execution and Artifact Contract terminology", () => {
    const t = messages.zh;

    assert.equal(t.activeProfile, "默认执行配置");
    assert.equal(t.inputArtifactContracts, "输入制品契约");
    assert.equal(t.outputArtifactContracts, "输出制品契约");
    assert.equal(t.addArtifactContract, "添加制品契约");
    assert.equal(t.executionProfiles, "执行配置");
    assert.equal(t.secretReferences, "密钥引用");
    assert.equal(t.providerRef, "提供方引用");
    assert.equal(t.sandboxRef, "沙箱引用");
    assert.equal(t.branchStrategy, "分支策略");
    assert.equal(t.retryMaxAttempts, "最大重试次数");
  });
});
