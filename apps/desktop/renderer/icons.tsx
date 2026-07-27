import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconName =
  | "overview"
  | "project"
  | "department"
  | "member"
  | "pipeline"
  | "run"
  | "artifact"
  | "approval"
  | "skill"
  | "snapshot"
  | "memory"
  | "start"
  | "ai-task"
  | "human-approval"
  | "condition"
  | "parallel"
  | "complete"
  | "planner"
  | "architect"
  | "builder"
  | "tester"
  | "evaluator"
  | "search"
  | "zoom-in"
  | "zoom-out"
  | "close"
  | "refresh"
  | "edit"
  | "pause"
  | "resume"
  | "cancel"
  | "settings"
  | "send"
  | "back";

export type IconSize = 16 | 20 | 24;

const iconPaths: Record<IconName, ReactNode> = {
  overview: (
    <>
      <path d="M4.5 11.5 12 5l7.5 6.5v7a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M9 20v-5.5h6V20" />
      <circle cx="12" cy="10.5" r="1.7" className="icon-accent-fill" />
    </>
  ),
  project: (
    <>
      <path
        d="M4 7.5h6l1.7 2H20v9.25A1.25 1.25 0 0 1 18.75 20H5.25A1.25 1.25 0 0 1 4 18.75z"
        className="icon-soft-fill"
      />
      <path d="M4 7.5h6l1.7 2H20v9.25A1.25 1.25 0 0 1 18.75 20H5.25A1.25 1.25 0 0 1 4 18.75zM7 13h10M7 16h6" />
    </>
  ),
  department: (
    <>
      <path
        d="m12 3.5 8 4.6v8.8l-8 4.6-8-4.6V8.1z"
        className="icon-soft-fill"
      />
      <circle cx="12" cy="8.5" r="2.1" className="icon-accent-fill" />
      <circle cx="8.3" cy="15" r="1.7" />
      <circle cx="15.7" cy="15" r="1.7" />
      <path d="M12 10.6v2m-2.2.7L8.3 15m5.9-1.7 1.5 1.7" />
    </>
  ),
  member: (
    <>
      <rect
        x="5"
        y="6"
        width="14"
        height="12"
        rx="4"
        className="icon-soft-fill"
      />
      <path d="M12 6V3.5m-2 0h4M5 12H3m18 0h-2" />
      <circle cx="9.2" cy="11.7" r="1.2" className="icon-accent-fill" />
      <circle cx="14.8" cy="11.7" r="1.2" className="icon-accent-fill" />
      <path d="M9.5 15h5" />
    </>
  ),
  pipeline: (
    <>
      <rect
        x="3.5"
        y="9"
        width="5"
        height="5"
        rx="1.5"
        className="icon-soft-fill"
      />
      <rect
        x="15.5"
        y="4"
        width="5"
        height="5"
        rx="1.5"
        className="icon-accent-fill"
      />
      <rect
        x="15.5"
        y="15"
        width="5"
        height="5"
        rx="1.5"
        className="icon-soft-fill"
      />
      <path d="M8.5 11.5h3c2.2 0 4-1.8 4-4m-7 4h3c2.2 0 4 1.8 4 4" />
    </>
  ),
  run: (
    <>
      <path d="M3 15h5l3-7 3.2 9 2.4-5H21" />
      <circle cx="3" cy="15" r="1.5" className="icon-accent-fill" />
      <circle cx="21" cy="12" r="1.5" className="icon-accent-fill" />
    </>
  ),
  artifact: (
    <>
      <path
        d="m12 3.5 8 4.2v8.6l-8 4.2-8-4.2V7.7z"
        className="icon-soft-fill"
      />
      <path d="m4 7.7 8 4.3 8-4.3M12 12v8.5" />
      <path d="m8 5.6 8 4.3" className="icon-highlight" />
    </>
  ),
  approval: (
    <>
      <path
        d="m12 3.5 7.5 3v5.8c0 4.7-3 7.6-7.5 9.7-4.5-2.1-7.5-5-7.5-9.7V6.5z"
        className="icon-soft-fill"
      />
      <path d="m8.2 12.3 2.4 2.4 5.5-6.2" />
    </>
  ),
  skill: (
    <>
      <path
        d="m12 3.5 2.2 4.7 5.2.6-3.8 3.6 1 5.1-4.6-2.6-4.6 2.6 1-5.1-3.8-3.6 5.2-.6z"
        className="icon-soft-fill"
      />
      <circle cx="12" cy="11.6" r="2.1" className="icon-accent-fill" />
    </>
  ),
  snapshot: (
    <>
      <path
        d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v10a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17.5z"
        className="icon-soft-fill"
      />
      <path d="M8 5V3.5m8 1.5V3.5M8.5 10h7M8.5 14h4" />
      <circle cx="16.5" cy="16.5" r="3.5" className="icon-accent-fill" />
      <path d="M16.5 14.7v2l1.3.9" className="icon-on-accent" />
    </>
  ),
  memory: (
    <>
      <path
        d="M8.2 5.2A4 4 0 0 1 15 4.4a3.7 3.7 0 0 1 5 3.5 3.6 3.6 0 0 1-1.3 2.8A4.8 4.8 0 0 1 15 19H8a5 5 0 0 1-2.5-9.3A4 4 0 0 1 8.2 5.2Z"
        className="icon-soft-fill"
      />
      <path d="M9 7.5v8m4-9v10m4-7v5M6.5 10.5h12M7 14h10" />
    </>
  ),
  start: <path d="m9 6 9 6-9 6z" className="icon-accent-fill" />,
  "ai-task": (
    <>
      <rect
        x="5"
        y="6"
        width="14"
        height="12"
        rx="4"
        className="icon-soft-fill"
      />
      <path d="M12 6V3.5m-2 0h4" />
      <circle cx="9.2" cy="12" r="1.3" className="icon-accent-fill" />
      <circle cx="14.8" cy="12" r="1.3" className="icon-accent-fill" />
    </>
  ),
  "human-approval": (
    <>
      <rect
        x="4"
        y="6"
        width="16"
        height="13"
        rx="2.5"
        className="icon-soft-fill"
      />
      <path d="m7.5 12.5 2.5 2.5 6.5-7" />
    </>
  ),
  condition: (
    <>
      <path d="m12 3.5 8.5 8.5-8.5 8.5L3.5 12z" className="icon-soft-fill" />
      <path d="M12 7.5v5m0 3.3v.2" />
    </>
  ),
  parallel: (
    <>
      <path d="M3 12h5m8 0h5M8 12c4 0 4-6 8-6M8 12c4 0 4 6 8 6" />
      <circle cx="8" cy="12" r="1.5" className="icon-accent-fill" />
      <circle cx="16" cy="6" r="1.5" className="icon-accent-fill" />
      <circle cx="16" cy="18" r="1.5" className="icon-accent-fill" />
    </>
  ),
  complete: (
    <>
      <path d="M6 21V4" />
      <path d="M7 5h12l-3.5 4L19 13H7z" className="icon-soft-fill" />
    </>
  ),
  planner: (
    <>
      <rect
        x="5"
        y="6"
        width="14"
        height="12"
        rx="4"
        className="icon-soft-fill"
      />
      <circle cx="9.2" cy="12" r="1.2" className="icon-accent-fill" />
      <circle cx="14.8" cy="12" r="1.2" className="icon-accent-fill" />
      <path d="M12 6V3.5m-2 0h4M4.5 18.5l-2 2m15-2 2 2" />
    </>
  ),
  architect: (
    <>
      <rect
        x="4"
        y="5.5"
        width="13"
        height="12"
        rx="3.5"
        className="icon-soft-fill"
      />
      <path d="M8 11h2m2 0h2M10.5 5.5V3" />
      <path d="M16 8h4v11h-8v-2" />
      <path d="m14 14 1.5 1.5 2.8-3.5" />
    </>
  ),
  builder: (
    <>
      <rect
        x="4"
        y="5.5"
        width="13"
        height="12"
        rx="3.5"
        className="icon-soft-fill"
      />
      <circle cx="8" cy="11.5" r="1.2" className="icon-accent-fill" />
      <circle cx="13" cy="11.5" r="1.2" className="icon-accent-fill" />
      <path d="m16 15 5-5m-2-2 3 3-2 2-3-3z" />
    </>
  ),
  tester: (
    <>
      <path d="M7 4h10v16H7z" className="icon-soft-fill" />
      <path d="M9.5 9h5m-5 4h5m-5 4h3" />
      <path d="m15 16 1.5 1.5 3-3.5" />
    </>
  ),
  evaluator: (
    <>
      <path
        d="m12 3.5 7 2.8v5.6c0 4.4-2.8 7.2-7 9.1-4.2-1.9-7-4.7-7-9.1V6.3z"
        className="icon-soft-fill"
      />
      <path d="m8.3 12.2 2.3 2.3 5-5.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" className="icon-soft-fill" />
      <path d="m15.5 15.5 4.5 4.5" />
    </>
  ),
  "zoom-in": (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" className="icon-soft-fill" />
      <path d="m15.5 15.5 4.5 4.5M10.5 7.5v6m-3-3h6" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" className="icon-soft-fill" />
      <path d="m15.5 15.5 4.5 4.5m-8.5-9.5h6" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  refresh: (
    <>
      <path d="M19 8V4l-2.4 2.4A8 8 0 1 0 20 12" />
      <path d="M19 4h-4" />
    </>
  ),
  edit: (
    <>
      <path d="m5 16-.7 3.7L8 19l10.5-10.5-3-3z" className="icon-soft-fill" />
      <path d="m13.8 7.2 3 3M4.3 19.7 8 19" />
    </>
  ),
  pause: (
    <>
      <rect
        x="6"
        y="5"
        width="4"
        height="14"
        rx="1.5"
        className="icon-soft-fill"
      />
      <rect
        x="14"
        y="5"
        width="4"
        height="14"
        rx="1.5"
        className="icon-soft-fill"
      />
    </>
  ),
  resume: <path d="m8 5 11 7-11 7z" className="icon-soft-fill" />,
  cancel: (
    <>
      <circle cx="12" cy="12" r="8.5" className="icon-soft-fill" />
      <path d="m8.5 8.5 7 7m0-7-7 7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" className="icon-accent-fill" />
      <path d="M12 3.5v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6-1.4 1.4M7.4 16.6 6 18m12 0-1.4-1.4M7.4 7.4 6 6" />
      <circle cx="12" cy="12" r="7" className="icon-soft-fill" />
    </>
  ),
  send: (
    <>
      <path
        d="m3.5 4.5 17 7.5-17 7.5 3-6.2L15 12l-8.5-1.3z"
        className="icon-soft-fill"
      />
    </>
  ),
  back: <path d="m15.5 5-7 7 7 7M9 12h11" />,
};

export function Icon({
  name,
  size = 20,
  className = "",
}: {
  readonly name: IconName;
  readonly size?: IconSize;
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={`factory-icon ${className}`.trim()}
      data-icon={name}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPaths[name]}
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  readonly icon: IconName;
  readonly label: string;
}) {
  return (
    <button
      {...props}
      aria-label={label}
      className={`icon-button ${className}`.trim()}
      data-icon-button
      title={label}
      type={props.type ?? "button"}
    >
      <Icon name={icon} size={20} />
    </button>
  );
}
