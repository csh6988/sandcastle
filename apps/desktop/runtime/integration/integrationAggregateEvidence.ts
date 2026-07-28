import type { IntegrationGenerationManifest } from "./integrationRuntime.js";

export const aggregateEvidencePolicy = (input: {
  readonly generationManifest: IntegrationGenerationManifest;
  readonly manifestHash: string;
  readonly repositoryCommits: readonly {
    readonly repositoryId: string;
    readonly commit: string;
  }[];
}): {
  readonly required: readonly string[];
  readonly allowed: ReadonlySet<string>;
} => {
  const required = [
    `integration-generation:${input.generationManifest.generationId}`,
    `integration-manifest:${input.manifestHash}`,
    ...input.repositoryCommits.map(
      (entry) => `repository-commit:${entry.repositoryId}:${entry.commit}`,
    ),
  ].sort();
  const allowed = new Set<string>(required);
  for (const entry of input.generationManifest.packages) {
    allowed.add(
      `code-review-manifest:${entry.reviewContext.codeReviewManifestId}:${entry.reviewContext.codeReviewManifestHash}`,
    );
    allowed.add(`artifact:${entry.reviewContext.diffArtifactVersionId}`);
    for (const id of entry.reviewContext.specRevisionIds) {
      allowed.add(`spec:${id}`);
    }
    for (const id of entry.reviewContext.harnessSnapshotIds) {
      allowed.add(`harness:${id}`);
    }
    for (const ref of entry.reviewContext.selfCheckEvidenceRefs) {
      allowed.add(`self-check:${ref}`);
    }
  }
  for (const validation of input.generationManifest.requiredValidations) {
    allowed.add(`validation:${validation.id}:${validation.identityHash}`);
    for (const ref of validation.evidenceRefs) {
      allowed.add(`validation-evidence:${ref}`);
    }
  }
  for (const contract of input.generationManifest.contractVersions) {
    allowed.add(`contract:${contract.id}@${contract.version}:${contract.hash}`);
    for (const ref of contract.evidenceRefs) {
      allowed.add(`contract-evidence:${ref}`);
    }
  }
  return { required, allowed };
};
