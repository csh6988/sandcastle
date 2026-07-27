import type { WorkPackageGraphView } from "../runtime/interface.js";

export function WorkPackageGraphPanel({
  graph,
}: {
  readonly graph: WorkPackageGraphView;
}) {
  return (
    <section data-work-package-graph>
      <h4>Work Packages</h4>
      <p data-work-package-baseline>
        Technical Baseline {graph.technicalBaselineId} · {graph.packages.length}{" "}
        package(s)
      </p>
      <ol>
        {graph.packages.map((workPackage) => {
          const version = workPackage.versions.at(-1)!;
          const assignment = version.assignments.at(-1);
          return (
            <li key={workPackage.id} data-work-package={workPackage.id}>
              <strong>{workPackage.id}</strong> · {workPackage.state} ·{" "}
              {version.applicationId} / {version.repositoryReference}
              <p data-work-package-dependencies>
                {version.dependencies.length
                  ? `Depends on ${version.dependencies
                      .map(
                        (dependency) =>
                          `${dependency.predecessorWorkPackageVersionId} (${dependency.kind})`,
                      )
                      .join(", ")}`
                  : "No package dependencies"}
              </p>
              <p data-work-package-assignment>
                {assignment
                  ? `${assignment.aiMemberId} via ${assignment.agentAdapterId} · ${assignment.state} · ${assignment.allocation.state}`
                  : "Unassigned"}
              </p>
              <p data-work-package-evidence>
                {assignment?.selfCheck
                  ? `Self-check ${assignment.selfCheck.status} · ${assignment.selfCheck.reportHash}`
                  : "No self-check evidence"}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
