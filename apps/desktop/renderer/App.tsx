import { useState } from "react";
import {
  CompanyArtifactsPage,
  DepartmentsPage,
  ProjectsPage,
  RunsBoardPage,
  SettingsPage,
} from "./companyPages.js";
import type { DesktopProject } from "./boardApi.js";

type CompanyNav =
  | "projects"
  | "departments"
  | "runs"
  | "artifacts"
  | "settings";
type Language = "en" | "zh";

const NAV_ITEMS: ReadonlyArray<{ id: CompanyNav; label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "departments", label: "Departments" },
  { id: "runs", label: "Runs / Board" },
  { id: "artifacts", label: "Artifacts" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [nav, setNav] = useState<CompanyNav>("projects");
  const [language, setLanguage] = useState<Language>("en");
  const [projectContext, setProjectContext] = useState<DesktopProject | null>(
    null,
  );

  return (
    <div className="shell">
      <nav className="company-nav">
        <div className="brand">
          <div className="brand-name">Sandcastle</div>
          <div className="brand-sub">Local AI company</div>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${nav === item.id ? "on" : ""}`}
            onClick={() => setNav(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Local AI company</span>
            <strong>Sandcastle Desktop</strong>
          </div>
          <div className="topbar-status">
            <span>
              Project:{" "}
              <strong>{projectContext?.name ?? "None selected"}</strong>
            </span>
            <span>
              Board:{" "}
              <strong>
                {projectContext?.rd.currentBoardTaskId
                  ? `active ${projectContext.rd.currentBoardTaskId}`
                  : "idle"}
              </strong>
            </span>
          </div>
        </header>
        <main className="content">
          {nav === "projects" && (
            <ProjectsPage onProjectContextChange={setProjectContext} />
          )}
          {nav === "departments" && <DepartmentsPage />}
          {nav === "runs" && <RunsBoardPage project={projectContext} />}
          {nav === "artifacts" && (
            <CompanyArtifactsPage project={projectContext} />
          )}
          {nav === "settings" && (
            <SettingsPage language={language} onLanguageChange={setLanguage} />
          )}
        </main>
      </div>
    </div>
  );
}
