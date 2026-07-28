import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompanyCommandRegistry } from "../commandRegistry.js";
import { openIntegrationNodeHandler } from "./integrationNodeHandler.js";
import type {
  IntegrationGenerationView,
  IntegrationRuntime,
} from "./integrationRuntime.js";

const generation = (state: IntegrationGenerationView["state"]) =>
  ({
    id: "integration:run-1:g1",
    state,
    manifest: { nodeRunId: "integration-node-1" },
  }) as IntegrationGenerationView;

describe("Integration Node Handler", () => {
  it("creates one generation through the Command registry and resumes its durable operations", async () => {
    let views: readonly IntegrationGenerationView[] = [];
    const commands: unknown[] = [];
    const executed: string[] = [];
    const integrations = {
      inspect: () => views,
      executePending: (generationId: string) => {
        executed.push(generationId);
        return generation("running");
      },
      reconcilePending: () => 2,
    } as unknown as IntegrationRuntime;
    const commandRegistry = {
      execute: (command: unknown) => {
        commands.push(command);
        views = [generation("pending")];
        return {
          status: "succeeded",
          value: views[0],
          effectIds: [],
        };
      },
    } as unknown as CompanyCommandRegistry;
    const handler = openIntegrationNodeHandler({
      commandRegistry,
      integrations,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });
    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.equal(commands.length, 1);
    assert.deepEqual(executed, [
      "integration:run-1:g1",
      "integration:run-1:g1",
    ]);
    assert.equal(handler.reconcilePending(), 2);
  });
});
