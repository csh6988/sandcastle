import { useState } from "react";
import {
  CompanyOverviewPage,
  CompanyArtifactsPage,
  CompanyInteractionPage,
  AgentsPage,
  SkillsPage,
  DepartmentsPage,
  ProjectsPage,
  SettingsPage,
} from "./companyPages.js";
import {
  loadPreferredLanguage,
  messages,
  savePreferredLanguage,
  type Language,
} from "./i18n.js";

type CompanyNav =
  | "overview"
  | "projects"
  | "departments"
  | "agents"
  | "skills"
  | "artifacts"
  | "interaction"
  | "settings";

const NAV_ITEMS: ReadonlyArray<{
  id: CompanyNav;
  labelKey: keyof typeof messages.en;
}> = [
  { id: "overview", labelKey: "navOverview" },
  { id: "projects", labelKey: "navProjects" },
  { id: "departments", labelKey: "navDepartments" },
  { id: "agents", labelKey: "navAgents" },
  { id: "skills", labelKey: "navSkills" },
  { id: "artifacts", labelKey: "navArtifacts" },
  { id: "interaction", labelKey: "navInteraction" },
  { id: "settings", labelKey: "navSettings" },
];

export function App() {
  const [nav, setNav] = useState<CompanyNav>("overview");
  const [language, setLanguageState] = useState<Language>(() =>
    loadPreferredLanguage(window.localStorage, navigator.languages),
  );
  const t = messages[language];

  const setLanguage = (nextLanguage: Language) => {
    savePreferredLanguage(window.localStorage, nextLanguage);
    setLanguageState(nextLanguage);
  };

  return (
    <div className="shell">
      <nav className="company-nav">
        <div className="brand">
          <div className="brand-name">Sandcastle</div>
          <div className="brand-sub">{t.appSubtitle}</div>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            data-nav={item.id}
            className={`nav-item ${nav === item.id ? "on" : ""}`}
            onClick={() => setNav(item.id)}
            type="button"
          >
            {t[item.labelKey]}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">{t.appSubtitle}</span>
            <strong>{t.appTitle}</strong>
          </div>
          <div className="topbar-status">
            <span>
              {t.runtimeStatus} <strong>{t.runtimeConnected}</strong>
            </span>
          </div>
        </header>
        <main className="content">
          {nav === "overview" && <CompanyOverviewPage t={t} />}
          {nav === "projects" && <ProjectsPage t={t} />}
          {nav === "departments" && <DepartmentsPage t={t} />}
          {nav === "agents" && <AgentsPage t={t} />}
          {nav === "skills" && <SkillsPage t={t} />}
          {nav === "artifacts" && <CompanyArtifactsPage t={t} />}
          {nav === "interaction" && <CompanyInteractionPage t={t} />}
          {nav === "settings" && (
            <SettingsPage
              t={t}
              language={language}
              onLanguageChange={setLanguage}
            />
          )}
        </main>
      </div>
    </div>
  );
}
