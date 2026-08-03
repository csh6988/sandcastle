import { useRef, useState } from "react";
import type {
  AcceptedDeliveryCandidateAuthorityView,
  DeliveryCandidateView,
  ReleaseOperationEnvelopeCommand,
  ReleaseOperationView,
} from "../runtime/interface.js";

const hashSummary = (hash: string): string =>
  `${hash.slice(0, 12)}…${hash.slice(-8)}`;

const splitEvidenceRefs = (value: string): string[] => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ),
];

const isCommit = (value: string): boolean => /^[a-f0-9]{40}$/.test(value);

const isRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("/") &&
  value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");

type MergeDestination = {
  readonly targetBranch: string;
  readonly expectedTargetTip: string;
};

type ExportDestination = {
  readonly relativePath: string;
  readonly overwrite: "create-only" | "replace-if-exact-digest";
  readonly expectedDestinationDigest: string;
};

export function ReleaseOperationPanel({
  candidate,
  authority,
  operations,
  onCommand,
  createOperationId = () => globalThis.crypto.randomUUID(),
}: {
  readonly candidate: DeliveryCandidateView | null;
  readonly authority: AcceptedDeliveryCandidateAuthorityView | null;
  readonly operations: readonly ReleaseOperationView[];
  readonly onCommand: (
    command: ReleaseOperationEnvelopeCommand,
  ) => void | Promise<void>;
  readonly createOperationId?: () => string;
}) {
  const [kind, setKind] = useState<"merge" | "export">("merge");
  const [operationId, setOperationId] = useState(createOperationId);
  const [mergeDestinations, setMergeDestinations] = useState<
    Readonly<Record<string, MergeDestination>>
  >({});
  const [exportRoot, setExportRoot] = useState("");
  const [exportArtifacts, setExportArtifacts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [exportDestinations, setExportDestinations] = useState<
    Readonly<Record<string, ExportDestination>>
  >({});
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);
  const [reconcileEvidence, setReconcileEvidence] = useState<
    Readonly<Record<string, string>>
  >({});

  if (
    candidate?.projection !== "accepted" ||
    authority === null ||
    authority.candidateId !== candidate.id
  ) {
    return null;
  }

  const evidenceRefs = splitEvidenceRefs(evidence);
  const mergeItems = authority.repositoryCommits
    .map((repository, index) => {
      const destination = mergeDestinations[repository.repositoryReference] ?? {
        targetBranch: "",
        expectedTargetTip: "",
      };
      return {
        id: `merge:${String(index).padStart(4, "0")}`,
        repositoryReference: repository.repositoryReference,
        sourceCommit: repository.commit,
        destination,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const selectedArtifactIds = authority.artifactVersionIds.filter(
    (artifactId) => exportArtifacts.has(artifactId),
  );
  const exportItems = selectedArtifactIds
    .map((artifactVersionId) => {
      const destination = exportDestinations[artifactVersionId] ?? {
        relativePath: "",
        overwrite: "create-only" as const,
        expectedDestinationDigest: "",
      };
      return {
        id: `export:${artifactVersionId}`,
        artifactVersionId,
        destination: {
          canonicalRoot: exportRoot.trim(),
          expectedRootState: "preexisting-local-filesystem-root" as const,
          relativePath: destination.relativePath.trim(),
          overwrite:
            destination.overwrite === "create-only"
              ? ({ kind: "create-only" } as const)
              : {
                  kind: "replace-if-exact-digest" as const,
                  expectedDestinationDigest:
                    destination.expectedDestinationDigest.trim(),
                },
        },
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const isMergeReady =
    mergeItems.length > 0 &&
    mergeItems.every(
      (item) =>
        item.destination.targetBranch.trim().length > 0 &&
        isCommit(item.destination.expectedTargetTip.trim()),
    );
  const isExportReady =
    exportRoot.trim().startsWith("/") &&
    exportItems.length > 0 &&
    exportItems.every(
      (item) =>
        isRelativePath(item.destination.relativePath) &&
        (item.destination.overwrite.kind === "create-only" ||
          /^[a-f0-9]{64}$/.test(
            item.destination.overwrite.expectedDestinationDigest,
          )),
    );
  const canCreate =
    !inFlight &&
    confirmed &&
    reason.trim().length > 0 &&
    evidenceRefs.length > 0 &&
    (kind === "merge" ? isMergeReady : isExportReady);

  const submit = async (): Promise<void> => {
    if (!canCreate || inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    const authorization = { reason: reason.trim(), evidenceRefs };
    const operation =
      kind === "merge"
        ? {
            operationId,
            candidateId: candidate.id,
            expectedAcceptedAuthorityHash: authority.authorityHash,
            kind: "merge" as const,
            authorization,
            items: mergeItems.map((item) => ({
              ...item,
              destination: {
                targetBranch: item.destination.targetBranch.trim(),
                expectedTargetTip: item.destination.expectedTargetTip.trim(),
              },
            })),
          }
        : {
            operationId,
            candidateId: candidate.id,
            expectedAcceptedAuthorityHash: authority.authorityHash,
            kind: "export" as const,
            authorization,
            items: exportItems,
          };
    try {
      await onCommand({ type: "delivery.release-operation.create", operation });
      inFlightRef.current = false;
      setInFlight(false);
      setOperationId(createOperationId());
    } catch {
      inFlightRef.current = false;
      setInFlight(false);
    }
  };

  return (
    <section data-release-operation-panel aria-label="Release operations">
      <header>
        <h2>Release operations</h2>
        <p>Accepted Candidate {hashSummary(candidate.manifestHash)}</p>
        <p data-release-authority-hash>
          Accepted Delivery Candidate Authority{" "}
          {hashSummary(authority.authorityHash)}
        </p>
      </header>

      <fieldset>
        <legend>Release kind</legend>
        <label>
          <input
            data-release-kind="merge"
            type="radio"
            checked={kind === "merge"}
            onChange={() => setKind("merge")}
          />
          Merge every accepted Repository
        </label>
        <label>
          <input
            data-release-kind="export"
            type="radio"
            checked={kind === "export"}
            onChange={() => setKind("export")}
          />
          Export authorized Artifacts
        </label>
      </fieldset>

      {kind === "merge" ? (
        <fieldset data-release-merge-form>
          <legend>Merge destinations</legend>
          {authority.repositoryCommits.map((repository) => {
            const destination = mergeDestinations[
              repository.repositoryReference
            ] ?? { targetBranch: "", expectedTargetTip: "" };
            return (
              <div key={repository.repositoryReference}>
                <strong>{repository.repositoryReference}</strong> (
                {hashSummary(repository.commit)})
                <label>
                  Release target branch
                  <input
                    data-merge-target={repository.repositoryReference}
                    value={destination.targetBranch}
                    onInput={(event) =>
                      setMergeDestinations({
                        ...mergeDestinations,
                        [repository.repositoryReference]: {
                          ...destination,
                          targetBranch: event.currentTarget.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Expected target tip
                  <input
                    data-merge-tip={repository.repositoryReference}
                    value={destination.expectedTargetTip}
                    onInput={(event) =>
                      setMergeDestinations({
                        ...mergeDestinations,
                        [repository.repositoryReference]: {
                          ...destination,
                          expectedTargetTip: event.currentTarget.value,
                        },
                      })
                    }
                  />
                </label>
              </div>
            );
          })}
        </fieldset>
      ) : (
        <fieldset data-release-export-form>
          <legend>Export destinations</legend>
          <label>
            Absolute local destination root
            <input
              data-export-root
              value={exportRoot}
              onInput={(event) => setExportRoot(event.currentTarget.value)}
            />
          </label>
          {authority.artifactVersionIds.map((artifactVersionId) => {
            const selected = exportArtifacts.has(artifactVersionId);
            const destination = exportDestinations[artifactVersionId] ?? {
              relativePath: "",
              overwrite: "create-only" as const,
              expectedDestinationDigest: "",
            };
            return (
              <div key={artifactVersionId}>
                <label>
                  <input
                    data-export-artifact={artifactVersionId}
                    type="checkbox"
                    checked={selected}
                    onChange={() =>
                      setExportArtifacts((current) => {
                        const next = new Set(current);
                        selected
                          ? next.delete(artifactVersionId)
                          : next.add(artifactVersionId);
                        return next;
                      })
                    }
                  />
                  {artifactVersionId}
                </label>
                {selected ? (
                  <>
                    <label>
                      Relative path
                      <input
                        data-export-path={artifactVersionId}
                        value={destination.relativePath}
                        onInput={(event) =>
                          setExportDestinations({
                            ...exportDestinations,
                            [artifactVersionId]: {
                              ...destination,
                              relativePath: event.currentTarget.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Overwrite
                      <select
                        data-export-overwrite={artifactVersionId}
                        value={destination.overwrite}
                        onChange={(event) =>
                          setExportDestinations({
                            ...exportDestinations,
                            [artifactVersionId]: {
                              ...destination,
                              overwrite: event.target
                                .value as ExportDestination["overwrite"],
                            },
                          })
                        }
                      >
                        <option value="create-only">create-only</option>
                        <option value="replace-if-exact-digest">
                          replace-if-exact-digest
                        </option>
                      </select>
                    </label>
                    {destination.overwrite === "replace-if-exact-digest" ? (
                      <label>
                        Expected destination digest
                        <input
                          data-export-digest={artifactVersionId}
                          value={destination.expectedDestinationDigest}
                          onInput={(event) =>
                            setExportDestinations({
                              ...exportDestinations,
                              [artifactVersionId]: {
                                ...destination,
                                expectedDestinationDigest:
                                  event.currentTarget.value,
                              },
                            })
                          }
                        />
                      </label>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      )}

      <label>
        Reason
        <textarea
          data-release-reason
          value={reason}
          onInput={(event) => setReason(event.currentTarget.value)}
        />
      </label>
      <label>
        Evidence references (one per line)
        <input
          data-release-evidence
          value={evidence}
          onInput={(event) => setEvidence(event.currentTarget.value)}
        />
      </label>
      <label>
        <input
          data-release-confirm
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        I confirm these exact destinations and evidence.
      </label>
      <button
        data-release-create
        disabled={!canCreate}
        onClick={() => void submit()}
      >
        {inFlight ? "Creating release operation…" : "Create release operation"}
      </button>

      <section aria-label="Release operation progress">
        {operations.map((operation) => (
          <article key={operation.id} data-release-operation={operation.id}>
            <h3>
              {operation.id}: {operation.aggregateState}
            </h3>
            <p>
              {operation.counts.succeeded} succeeded; {operation.counts.failed}{" "}
              failed; {operation.counts.destinationConflict} conflicts;{" "}
              {operation.counts.unknown} unknown.
            </p>
            {operation.nextActions.includes("create-new-operation") ? (
              <p>Destination drift requires a new operation.</p>
            ) : null}
            {operation.items.map((item) => (
              <div key={item.id} data-release-item={item.id}>
                <strong>
                  {item.id}: {item.state}
                </strong>
                {item.receipt ? <span> {item.receipt.disposition}</span> : null}
                {item.state === "unknown" ? (
                  <label>
                    Reconcile evidence
                    <input
                      data-release-reconcile-evidence={operation.id}
                      value={
                        reconcileEvidence[`${operation.id}:${item.id}`] ?? ""
                      }
                      onInput={(event) =>
                        setReconcileEvidence({
                          ...reconcileEvidence,
                          [`${operation.id}:${item.id}`]:
                            event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                ) : null}
                {item.state === "unknown" &&
                operation.nextActions.includes("reconcile") ? (
                  <button
                    data-release-reconcile
                    disabled={
                      splitEvidenceRefs(
                        reconcileEvidence[`${operation.id}:${item.id}`] ?? "",
                      ).length === 0
                    }
                    onClick={() =>
                      void onCommand({
                        type: "delivery.release-operation.reconcile",
                        operationId: operation.id,
                        itemId: item.id,
                        expectedOperationHash: operation.canonicalRequestHash,
                        evidenceRefs: splitEvidenceRefs(
                          reconcileEvidence[`${operation.id}:${item.id}`] ?? "",
                        ),
                      })
                    }
                  >
                    Reconcile unknown item
                  </button>
                ) : null}
              </div>
            ))}
          </article>
        ))}
      </section>
    </section>
  );
}
