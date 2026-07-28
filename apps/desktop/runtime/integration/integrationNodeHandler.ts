import type { CompanyCommandRegistry } from "../commandRegistry.js";
import type { ActorRef } from "../interface.js";
import type { IntegrationRuntime } from "./integrationRuntime.js";

export interface IntegrationNodeHandler {
  readonly executeReady: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
  readonly reconcilePending: () => number;
}

const actor: ActorRef = {
  type: "runtime-worker",
  id: "integration-node-handler",
  authenticatedBy: "runtime",
};

export const openIntegrationNodeHandler = (options: {
  readonly commandRegistry: CompanyCommandRegistry;
  readonly integrations: IntegrationRuntime;
}): IntegrationNodeHandler => ({
  executeReady: async ({ runId, nodeRunId }) => {
    let generation = options.integrations
      .inspect(runId)
      .find(
        (candidate) =>
          candidate.manifest.nodeRunId === nodeRunId &&
          !["failed", "passed"].includes(candidate.state),
      );
    if (!generation) {
      const generationNumber = options.integrations.inspect(runId).length + 1;
      const generationId = `integration:${runId}:g${generationNumber}`;
      const result = options.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `integration:${runId}:${nodeRunId}:g${generationNumber}:start`,
        actor,
        command: {
          type: "integration.generation.start",
          generationId,
          runId,
          nodeRunId,
        },
      });
      if (result.status !== "succeeded") return;
      generation = options.integrations
        .inspect(runId)
        .find((candidate) => candidate.id === generationId);
      if (!generation) return;
    }
    if (["pending", "running"].includes(generation.state)) {
      options.integrations.executePending(generation.id);
    }
  },
  reconcilePending: () => options.integrations.reconcilePending(),
});
