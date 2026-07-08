import type { DesktopProject } from "./boardApi.js";

export type WorkbenchStage = "prd" | "design" | "rd" | "review" | "artifacts";

export const workbenchStages: ReadonlyArray<{
  readonly id: WorkbenchStage;
  readonly label: string;
  readonly shortLabel: string;
}> = [
  { id: "prd", label: "PRD", shortLabel: "PRD" },
  { id: "design", label: "Design", shortLabel: "Design" },
  { id: "rd", label: "R&D Execution", shortLabel: "R&D" },
  { id: "review", label: "Review", shortLabel: "Review" },
  { id: "artifacts", label: "Artifacts", shortLabel: "Artifacts" },
];

export const currentStage = (project: DesktopProject): WorkbenchStage => {
  if (
    project.status === "accepted" ||
    project.status === "rejected" ||
    project.status === "changes-requested"
  ) {
    return project.status === "accepted" ? "artifacts" : "review";
  }
  if (project.status === "ready-for-review") return "review";
  if (project.status === "in-rd") return "rd";
  if (project.status === "design-ready") return "rd";
  if (project.status === "prd-confirmed") return "design";
  return "prd";
};

export const reviewStatusLabel = (project: DesktopProject): string => {
  if (
    project.review?.decision === "accepted" ||
    project.status === "accepted"
  ) {
    return "accepted";
  }
  if (
    project.review?.decision === "changes-requested" ||
    project.status === "changes-requested"
  ) {
    return "changes requested";
  }
  if (
    project.review?.decision === "rejected" ||
    project.status === "rejected"
  ) {
    return "rejected";
  }
  if (project.status === "ready-for-review") return "ready";
  return "waiting";
};

export const rdPipelineSteps = (project: DesktopProject): readonly string[] => {
  if (project.status === "ready-for-review") {
    return ["done", "done", "done", "active", "pending"];
  }
  if (
    project.status === "accepted" ||
    project.status === "changes-requested" ||
    project.status === "rejected"
  ) {
    return ["done", "done", "done", "done", "done"];
  }
  if (project.status === "in-rd") {
    return ["done", "done", "active", "pending", "pending"];
  }
  if (project.status === "design-ready") {
    return ["active", "pending", "pending", "pending", "pending"];
  }
  return ["pending", "pending", "pending", "pending", "pending"];
};
