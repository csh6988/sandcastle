import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeViewConnectionCoordinator } from "./runtimeViewConnectionCoordinator.js";

describe("Runtime View connection coordinator", () => {
  it("serializes an overlapping Reviews stage-ID change behind the old-generation close barrier", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const coordinator = createRuntimeViewConnectionCoordinator<{
      readonly stage: string;
      readonly close: () => Promise<void>;
    }>();

    const first = coordinator.replace(async (isCurrent) => {
      events.push("candidate-quality:start");
      markFirstStarted();
      await firstReady;
      events.push(`candidate-quality:current:${String(isCurrent())}`);
      return {
        stage: "candidate-quality",
        close: async () => {
          events.push("candidate-quality:close");
        },
      };
    });
    await firstStarted;
    first.cancel();
    const second = coordinator.replace(async (isCurrent) => {
      events.push(`delivery-candidate:start:${String(isCurrent())}`);
      return {
        stage: "delivery-candidate",
        close: async () => {
          events.push("delivery-candidate:close");
        },
      };
    });

    assert.deepEqual(events, ["candidate-quality:start"]);
    releaseFirst();
    await Promise.all([first.done, second.done]);

    assert.deepEqual(events, [
      "candidate-quality:start",
      "candidate-quality:current:false",
      "candidate-quality:close",
      "delivery-candidate:start:true",
    ]);
    assert.equal(coordinator.current()?.stage, "delivery-candidate");
    await coordinator.clear();
  });
});
