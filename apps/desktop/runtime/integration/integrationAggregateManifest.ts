import { createHash } from "node:crypto";
import type { IntegrationGenerationManifest } from "./integrationRuntime.js";

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right),
          ),
        )
      : entry,
  );

export const integrationManifestHash = (
  manifest: IntegrationGenerationManifest,
): string => createHash("sha256").update(canonicalJson(manifest)).digest("hex");

export const aggregateReviewManifestFor = (input: {
  readonly generationId: string;
  readonly manifestHash: string;
  readonly generationManifest: IntegrationGenerationManifest;
  readonly topicId: string;
  readonly repositoryCommits: readonly {
    readonly repositoryId: string;
    readonly commit: string;
  }[];
  readonly acceptanceCriteria?: readonly string[];
}) => {
  if (
    input.generationManifest.generationId !== input.generationId ||
    integrationManifestHash(input.generationManifest) !== input.manifestHash
  ) {
    throw new Error(
      "Aggregate Review input does not bind the exact canonical Integration Generation manifest.",
    );
  }
  const contexts = input.generationManifest.packages.map(
    (entry) => entry.reviewContext,
  );
  const acceptanceCriteria = [
    ...new Set(contexts.flatMap((entry) => entry.acceptanceCriteria)),
  ].sort();
  if (
    input.acceptanceCriteria &&
    canonicalJson(acceptanceCriteria) !==
      canonicalJson(input.acceptanceCriteria)
  ) {
    throw new Error(
      "Aggregate Review acceptance criteria drifted from frozen Code Review context.",
    );
  }
  return {
    scope: "aggregate" as const,
    topicId: input.topicId,
    supportingArtifactVersionIds: [
      ...new Set(contexts.map((entry) => entry.diffArtifactVersionId)),
    ].sort(),
    supportingSpecRevisionIds: [
      ...new Set(contexts.flatMap((entry) => entry.specRevisionIds)),
    ].sort(),
    harnessSnapshotIds: [
      ...new Set(contexts.flatMap((entry) => entry.harnessSnapshotIds)),
    ].sort(),
    acceptanceCriteria,
    excludedContext: [
      "hidden-prompts" as const,
      "prior-reviewer-opinions" as const,
      "private-transcripts" as const,
    ],
    integrationGenerationId: input.generationId,
    integrationManifestHash: input.manifestHash,
    repositoryCommits: input.repositoryCommits.map((entry) => ({ ...entry })),
  };
};
