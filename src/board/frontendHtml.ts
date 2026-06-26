/**
 * The workflow board frontend, embedded as a single self-contained HTML string.
 *
 * Embedding (rather than shipping a separate asset) means the board works
 * identically under `tsx` in development and from the bundled `dist/main.js`,
 * with no build step and no extra files in the published package. React is
 * loaded from an ESM CDN and `htm` provides JSX-like templating without a
 * compiler.
 */
export const BOARD_FRONTEND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sandcastle Board</title>
    <link rel="stylesheet" href="https://esm.sh/@xterm/xterm@5.5.0/css/xterm.css" />
    <style>
      :root {
        --bg: #070a12;
        --panel: rgba(15, 23, 42, .78);
        --panel-solid: #101827;
        --panel-2: rgba(30, 41, 64, .82);
        --border: rgba(148, 163, 184, .18);
        --border-strong: rgba(125, 162, 255, .46);
        --text: #eef4ff;
        --muted: #8ea0c5;
        --accent: #8ab4ff;
        --accent-2: #21d4fd;
        --glow: rgba(82, 126, 255, .28);
        --running: #fbbf24;
        --warn: #fbbf24;
        --succeeded: #34d399;
        --failed: #fb7185;
      }
      * { box-sizing: border-box; }
      *::-webkit-scrollbar { width: 11px; height: 11px; }
      *::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, .22); border: 3px solid transparent; border-radius: 999px; background-clip: padding-box; }
      body {
        margin: 0;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background:
          radial-gradient(circle at 18% -10%, rgba(68, 101, 210, .36), transparent 34rem),
          radial-gradient(circle at 78% 4%, rgba(33, 212, 253, .16), transparent 28rem),
          linear-gradient(180deg, #0b1020 0%, var(--bg) 44%, #050711 100%);
        color: var(--text);
        min-height: 100vh;
      }
      header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 22px; border-bottom: 1px solid var(--border);
        position: sticky; top: 0; background: rgba(7, 10, 18, .82); backdrop-filter: blur(18px); z-index: 5;
        box-shadow: 0 12px 32px rgba(0, 0, 0, .22);
      }
      .brand { display: flex; align-items: center; gap: 12px; }
      .brand-mark {
        width: 38px; height: 38px; border-radius: 13px;
        display: grid; place-items: center;
        background: linear-gradient(135deg, #7c5cff, var(--accent-2));
        color: white; font-weight: 850; letter-spacing: -.04em;
        box-shadow: 0 12px 30px rgba(33, 212, 253, .2);
      }
      header h1 { font-size: 18px; margin: 0; letter-spacing: .2px; line-height: 1.1; }
      header .dot { color: var(--muted); font-size: 12px; }
      header .tagline { color: #bdd2ff; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; margin-bottom: 2px; }
      button {
        background: linear-gradient(135deg, #7c5cff, var(--accent-2)); color: white; border: 0; border-radius: 999px;
        padding: 9px 16px; font-weight: 750; cursor: pointer; box-shadow: 0 10px 26px rgba(33, 212, 253, .18);
        transition: transform .15s, box-shadow .15s, border-color .15s;
      }
      button:hover { transform: translateY(-1px); box-shadow: 0 14px 34px rgba(33, 212, 253, .24); }
      button:disabled { cursor: default; opacity: .6; transform: none; }
      button.secondary { background: rgba(15, 23, 42, .76); color: var(--text); border: 1px solid var(--border); box-shadow: none; }
      .layout { display: grid; grid-template-columns: minmax(320px, 1fr) 8px minmax(360px, var(--detail-width, 500px)); gap: 0; height: calc(100vh - 71px); }
      .board { overflow: auto; padding: 22px; }
      .overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
      .metric {
        background: linear-gradient(180deg, rgba(30, 41, 64, .9), rgba(15, 23, 42, .82));
        border: 1px solid var(--border); border-radius: 16px; padding: 14px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04), 0 12px 32px rgba(0, 0, 0, .18);
      }
      .metric .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
      .metric .value { font-size: 28px; font-weight: 850; margin-top: 2px; letter-spacing: -.04em; }
      .metric .hint { color: var(--muted); font-size: 12px; margin-top: 2px; }
      .columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
      .column h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); margin: 0 0 12px; }
      .count { color: var(--muted); font-weight: 500; }
      .card {
        background: linear-gradient(180deg, rgba(16, 24, 39, .88), rgba(12, 18, 31, .88)); border: 1px solid var(--border); border-radius: 14px;
        padding: 13px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s;
      }
      .card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
      .card.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(138, 180, 255, .34), 0 0 34px var(--glow); }
      .card .name { font-weight: 600; margin-bottom: 4px; }
      .card .meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
      .badge { font-size: 11px; padding: 3px 9px; border-radius: 999px; font-weight: 750; border: 1px solid rgba(255,255,255,.08); }
      .badge.running { background: rgba(251, 191, 36, .13); color: var(--running); border-color: rgba(251, 191, 36, .25); }
      .badge.succeeded { background: rgba(52, 211, 153, .13); color: var(--succeeded); border-color: rgba(52, 211, 153, .25); }
      .badge.failed { background: rgba(251, 113, 133, .13); color: var(--failed); border-color: rgba(251, 113, 133, .25); }
      .resize-handle { cursor: col-resize; background: linear-gradient(90deg, transparent, rgba(148, 163, 184, .18), transparent); position: relative; }
      .resize-handle::after { content: ""; position: absolute; inset: 0 2px; border-left: 1px solid rgba(148, 163, 184, .16); border-right: 1px solid rgba(148, 163, 184, .08); }
      .resize-handle:hover, .resize-handle.dragging { background: linear-gradient(90deg, transparent, rgba(138, 180, 255, .34), transparent); }
      .detail { border-left: 1px solid var(--border); background: rgba(8, 13, 24, .76); backdrop-filter: blur(16px); overflow: auto; padding: 22px; box-shadow: inset 1px 0 0 rgba(255,255,255,.03); min-width: 0; }
      .detail h3 { margin: 0 0 4px; font-size: 19px; letter-spacing: -.02em; }
      .detail .sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
      .section { margin-bottom: 18px; }
      .section > .title { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--border); }
      th:first-child, td:first-child { text-align: left; }
      .stream { background: #050814; border: 1px solid rgba(148, 163, 184, .16); border-radius: 13px; padding: 12px; max-height: 360px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; box-shadow: inset 0 1px 0 rgba(255,255,255,.03); }
      .stream .text { white-space: pre-wrap; }
      .stream .tool { color: var(--accent); }
      .stream .row { margin-bottom: 4px; }
      .terminal-frame { background: #050814; border: 1px solid rgba(148, 163, 184, .16); border-radius: 13px; padding: 8px; min-height: 390px; overflow: hidden; box-shadow: inset 0 1px 0 rgba(255,255,255,.03); }
      .terminal-frame .xterm { padding: 4px; }
      .empty { color: var(--muted); padding: 30px 0; text-align: center; }
      .notice { color: var(--muted); background: rgba(148, 163, 184, .08); border: 1px dashed var(--border); border-radius: 12px; padding: 11px; font-size: 12px; }
      .error-box { color: var(--failed); background: rgba(251, 113, 133, .08); border: 1px solid rgba(251, 113, 133, .25); border-radius: 12px; padding: 11px; margin-top: 10px; white-space: pre-wrap; }
      .repo-group { border: 1px solid var(--border); border-radius: 12px; margin-bottom: 8px; }
      .repo-group .head { padding: 8px 10px; display: flex; justify-content: space-between; }
      .toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; margin-right: 12px; padding: 3px; background: rgba(15, 23, 42, .74); }
      .toggle button { background: transparent; color: var(--muted); border: 0; border-radius: 999px; padding: 6px 12px; font-weight: 700; box-shadow: none; }
      .toggle button.on { background: rgba(138, 180, 255, .16); color: var(--text); }
      .task-group { background: linear-gradient(180deg, rgba(16, 24, 39, .9), rgba(10, 16, 29, .9)); border: 1px solid var(--border); border-radius: 18px; padding: 16px; margin-bottom: 16px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; box-shadow: inset 0 1px 0 rgba(255,255,255,.035), 0 12px 30px rgba(0,0,0,.14); }
      .task-group:hover { border-color: var(--border-strong); transform: translateY(-1px); }
      .task-group.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(138, 180, 255, .3), 0 0 38px var(--glow); }
      .task-group > .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
      .task-group .task-title { font-weight: 800; font-size: 15px; letter-spacing: -.01em; }
      .task-group .task-prompt { color: var(--muted); font-size: 12px; margin-bottom: 12px; white-space: pre-wrap; }
      .plan { background: rgba(30, 41, 64, .58); border: 1px solid var(--border); border-radius: 13px; padding: 11px 12px; margin-bottom: 12px; }
      .plan .label { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); margin: 8px 0 3px; }
      .plan .label:first-child { margin-top: 0; }
      .plan .body { white-space: pre-wrap; font-size: 13px; }
      .plan .repo-task { border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 6px; }
      .plan .repo-task .rname { font-weight: 600; }
      .plan .repo-task .rreason { color: var(--muted); font-size: 12px; }
      .repo-runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
      .repo-chip { background: rgba(30, 41, 64, .62); border: 1px solid var(--border); border-radius: 12px; padding: 9px 11px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; }
      .repo-chip:hover { border-color: var(--border-strong); transform: translateY(-1px); }
      .repo-chip.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(138, 180, 255, .3), 0 0 26px var(--glow); }
      .repo-chip .rrepo { font-weight: 600; margin-bottom: 4px; }
      .repo-chip .rmeta { color: var(--muted); font-size: 11px; }
      .detail-list { display: grid; gap: 8px; }
      .dot-status { display: inline-block; width: 8px; height: 8px; border-radius: 999px; margin-right: 6px; box-shadow: 0 0 14px currentColor; }
      .dot-status.running { background: var(--running); color: var(--running); }
      .dot-status.succeeded { background: var(--succeeded); color: var(--succeeded); }
      .dot-status.failed { background: var(--failed); color: var(--failed); }
      .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.62); display: flex; align-items: center; justify-content: center; z-index: 10; backdrop-filter: blur(10px); }
      .modal { background: var(--panel-solid); border: 1px solid var(--border-strong); border-radius: 18px; padding: 22px; width: 520px; box-shadow: 0 24px 80px rgba(0,0,0,.45), 0 0 48px var(--glow); }
      .modal h3 { margin: 0 0 14px; }
      .modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
      .modal input, .modal textarea {
        width: 100%; background: rgba(15, 23, 42, .9); border: 1px solid var(--border); color: var(--text);
        border-radius: 12px; padding: 9px 10px; font: inherit; outline: none;
      }
      .modal input:focus, .modal textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(138, 180, 255, .14); }
      .modal textarea { min-height: 120px; resize: vertical; }
      .modal .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
      @media (max-width: 980px) {
        header { align-items: flex-start; flex-wrap: wrap; gap: 14px; }
        .layout { grid-template-columns: 1fr; height: auto; min-height: calc(100vh - 71px); }
        .board { padding: 18px; }
        .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .detail { border-left: 0; border-top: 1px solid var(--border); min-height: 320px; }
      }
      @media (max-width: 560px) {
        .brand { align-items: flex-start; }
        .overview, .columns { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React, { useState, useEffect, useCallback } from "https://esm.sh/react@18.3.1";
      import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
      import htm from "https://esm.sh/htm@3.1.1";
      import { Terminal } from "https://esm.sh/@xterm/xterm@5.5.0";
      const html = htm.bind(React.createElement);

      const api = (path, opts) => fetch(path, opts).then((r) => r.json());
      const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
      const STATUSES = ["running", "succeeded", "failed"];
      const countStatus = (items, status) => items.filter((i) => i.status === status).length;

      function Stream({ runId }) {
        const [events, setEvents] = useState([]);
        useEffect(() => {
          let active = true;
          setEvents([]);
          api("/api/runs/" + runId + "/events").then((e) => { if (active) setEvents(e); });
          return () => { active = false; };
        }, [runId]);
        useEffect(() => {
          const es = new EventSource("/api/stream");
          es.addEventListener("change", (m) => {
            const c = JSON.parse(m.data);
            if (c.kind === "run-event" && c.runId === runId) {
              setEvents((prev) => [...prev, c.record]);
            }
          });
          return () => es.close();
        }, [runId]);
        const visible = events.filter((r) =>
          ["agent-text", "agent-tool-call", "agent-tool-result", "agent-idle-warning", "iteration-started", "commit"].includes(r.event.type)
        );
        if (visible.length === 0) return html\`<div class="empty">No activity yet</div>\`;
        return html\`<div class="stream">\${visible.map((r) => {
          const e = r.event;
          if (e.type === "agent-text") return html\`<div class="row text" key=\${r.seq}>\${e.message}</div>\`;
          if (e.type === "agent-tool-call") return html\`<div class="row tool" key=\${r.seq}>→ \${e.name} \${e.formattedArgs}</div>\`;
          if (e.type === "agent-tool-result") return html\`<div class="row text" key=\${r.seq} style=\${{ color: "var(--muted)" }}>← \${e.content}</div>\`;
          if (e.type === "agent-idle-warning") return html\`<div class="row" key=\${r.seq} style=\${{ color: "var(--warn)" }}>⚠ Agent idle for \${e.minutes} minute\${e.minutes === 1 ? "" : "s"}</div>\`;
          if (e.type === "iteration-started") return html\`<div class="row" key=\${r.seq} style=\${{ color: "var(--muted)" }}>— iteration \${e.iteration}/\${e.maxIterations} —</div>\`;
          if (e.type === "commit") return html\`<div class="row" key=\${r.seq} style=\${{ color: "var(--succeeded)" }}>✓ commit \${e.sha.slice(0,9)}</div>\`;
          return null;
        })}</div>\`;
      }

      function UsagePanel({ runId, refreshKey }) {
        const [usage, setUsage] = useState([]);
        useEffect(() => {
          api("/api/runs/" + runId + "/usage").then(setUsage);
        }, [runId, refreshKey]);
        if (usage.length === 0) return html\`<div class="empty">No token usage reported yet</div>\`;
        return html\`<table>
          <thead><tr><th>Model</th><th>Input</th><th>Cache</th><th>Output</th><th>Total</th></tr></thead>
          <tbody>\${usage.map((u) => html\`<tr key=\${u.model}>
            <td>\${u.model}</td>
            <td>\${fmtTokens(u.inputTokens)}</td>
            <td>\${fmtTokens(u.cacheCreationInputTokens + u.cacheReadInputTokens)}</td>
            <td>\${fmtTokens(u.outputTokens)}</td>
            <td><strong>\${fmtTokens(u.totalTokens)}</strong></td>
          </tr>\`)}</tbody>
        </table>\`;
      }

      function TerminalPanel({ taskId }) {
        const elRef = React.useRef(null);
        const termRef = React.useRef(null);
        const [status, setStatus] = useState("connecting");
        useEffect(() => {
          let closed = false;
          let ws = null;
          const term = new Terminal({
            cols: 100,
            rows: 24,
            cursorBlink: true,
            convertEol: true,
            theme: { background: "#050814", foreground: "#eef4ff" },
          });
          termRef.current = term;
          if (elRef.current) {
            term.open(elRef.current);
            term.focus();
            elRef.current.addEventListener("click", () => term.focus());
          }
          const connect = async () => {
            const info = await api("/api/tasks/" + taskId + "/terminal").catch(() => null);
            if (closed) return;
            if (!info || info.status === "not-started") {
              setStatus("not-started");
              term.writeln("No interactive terminal session is attached to this task.");
              return;
            }
            setStatus(info.status || "running");
            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(protocol + "//" + window.location.host + "/api/tasks/" + taskId + "/terminal/ws");
            ws.addEventListener("open", () => {
              setStatus("connected");
              fetch("/api/tasks/" + taskId + "/terminal/resize", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ cols: term.cols, rows: term.rows }),
              }).catch(() => {});
            });
            ws.addEventListener("message", (event) => term.write(event.data));
            ws.addEventListener("close", () => {
              if (!closed) setStatus("closed");
            });
            ws.addEventListener("error", () => {
              if (!closed) setStatus("error");
            });
            term.onData((data) => {
              if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
            });
          };
          connect();
          return () => {
            closed = true;
            if (ws) ws.close();
            term.dispose();
          };
        }, [taskId]);
        return html\`<div>
          <div class="sub">interactive terminal · \${status} · click the terminal, then type normally</div>
          <div class="terminal-frame" ref=\${elRef}></div>
        </div>\`;
      }

      function PlanView({ plan }) {
        if (!plan) return null;
        return html\`<div class="plan">
          \${plan.alignmentSummary ? html\`
            <div class="label">Alignment</div>
            <div class="body">\${plan.alignmentSummary}</div>\` : null}
          \${plan.technicalPlan ? html\`
            <div class="label">Technical plan</div>
            <div class="body">\${plan.technicalPlan}</div>\` : null}
          \${plan.workspace && plan.workspace.repositories && plan.workspace.repositories.length > 0 ? html\`
            <div class="label">Workspace</div>
            \${plan.workspace.repositories.map((r) => html\`<div class="repo-task" key=\${r.name}>
              <div class="rname">\${r.name}</div>
              <div class="rreason">\${r.cwd}\${r.kind ? " · " + r.kind : ""}</div>
            </div>\`)}\` : null}
          \${plan.repositories && plan.repositories.length > 0 ? html\`
            <div class="label">Per-repository tasks</div>
            \${plan.repositories.map((r) => html\`<div class="repo-task" key=\${r.name}>
              <div class="rname">\${r.name}</div>
              <div class="body">\${r.task}</div>
              \${r.reason ? html\`<div class="rreason">\${r.reason}</div>\` : null}
            </div>\`)}\` : null}
        </div>\`;
      }

      function Overview({ tasks, runs }) {
        const activeTasks = countStatus(tasks, "pending") + countStatus(tasks, "running");
        return html\`<div>
          <div class="section">
            <div class="title">Task overview</div>
            <div class="overview">
              <div class="metric"><div class="label">Tasks</div><div class="value">\${tasks.length}</div><div class="hint">\${activeTasks} active</div></div>
              <div class="metric"><div class="label">Runs</div><div class="value">\${runs.length}</div><div class="hint">\${countStatus(runs, "running")} running</div></div>
              <div class="metric"><div class="label">Succeeded</div><div class="value">\${countStatus(tasks, "succeeded")}</div><div class="hint">\${countStatus(runs, "succeeded")} runs</div></div>
              <div class="metric"><div class="label">Failed</div><div class="value">\${countStatus(tasks, "failed")}</div><div class="hint">\${countStatus(runs, "failed")} runs</div></div>
            </div>
          </div>
        </div>\`;
      }

      function TaskGroups({ tasks, runs, selectedRunId, selectedTaskId, onSelectRun, onSelectTask }) {
        if (tasks.length === 0)
          return html\`<div class="empty">No tasks yet — create one to fan it out across repositories.</div>\`;
        return html\`<div>\${tasks.map((t) => {
          const taskRuns = runs.filter((r) => r.taskId === t.id);
          const isSelected = t.id === selectedTaskId;
          return html\`<div class="task-group \${isSelected ? "active" : ""}" key=\${t.id} onClick=\${() => onSelectTask(t.id)}>
            <div class="head">
              <span class="task-title">\${t.title}</span>
              <span class="badge \${t.status === "succeeded" ? "succeeded" : t.status === "failed" ? "failed" : "running"}">\${t.status}</span>
            </div>
            <div class="task-prompt">\${t.prompt}</div>
            <\${PlanView} plan=\${t.plan} />
            \${t.error ? html\`<div class="error-box">\${t.error}</div>\` : null}
            \${taskRuns.length === 0
              ? html\`<div class="notice">\${t.status === "failed" ? "Task failed before any repository run started." : "Waiting for runs…"}</div>\`
              : html\`<div class="repo-runs">\${taskRuns.map((r) => html\`
                  <div class="repo-chip \${r.id === selectedRunId ? "active" : ""}" key=\${r.id} onClick=\${(e) => { e.stopPropagation(); onSelectRun(r.id); }}>
                    <div class="rrepo"><span class="dot-status \${r.status}"></span>\${r.repo || r.name}</div>
                    <div class="rmeta">\${r.branch}\${r.commits > 0 ? " · " + r.commits + " commit" + (r.commits === 1 ? "" : "s") : ""}</div>
                  </div>\`)}</div>\`}
          </div>\`;
        })}</div>\`;
      }

      function TaskDetail({ task, taskRuns, onSelectRun }) {
        const [decisionBusy, setDecisionBusy] = useState(null);
        const activityRun = taskRuns.find((r) => r.status === "running") || taskRuns[0] || null;
        const decide = async (decision) => {
          setDecisionBusy(decision);
          const res = await fetch("/api/tasks/" + task.id + "/resume", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision }),
          });
          setDecisionBusy(null);
          if (!res.ok) {
            const e = await res.json();
            alert(e.error || "Failed to resume task");
          }
        };
        return html\`<div>
          <h3>Task details</h3>
          <div class="sub">\${task.title}</div>
          <div class="section">
            <span class="badge \${task.status === "succeeded" ? "succeeded" : task.status === "failed" ? "failed" : "running"}">\${task.status}</span>
            <span style=\${{ color: "var(--muted)", marginLeft: "8px" }}>created \${new Date(task.createdAt).toLocaleString()}</span>
            \${task.finishedAt ? html\`<span style=\${{ color: "var(--muted)", marginLeft: "8px" }}>finished \${new Date(task.finishedAt).toLocaleString()}</span>\` : null}
            \${task.error ? html\`<div class="error-box">\${task.error}</div>\` : null}
          </div>
          \${task.workflow ? html\`<div class="section">
            <div class="title">Workflow</div>
            <div class="notice">
              \${task.workflow.status}\${task.workflow.message ? " · " + task.workflow.message : ""}\${task.workflow.retryCount ? " · retry " + task.workflow.retryCount : ""}
            </div>
            \${task.workflow.status === "awaiting-approval" ? html\`
              <div class="actions">
                <button class="secondary" disabled=\${decisionBusy !== null} onClick=\${() => decide("reject")}>\${decisionBusy === "reject" ? "Rejecting…" : "Reject plan"}</button>
                <button disabled=\${decisionBusy !== null} onClick=\${() => decide("approve")}>\${decisionBusy === "approve" ? "Approving…" : "Approve plan"}</button>
              </div>\` : null}
          </div>\` : null}
          <div class="section">
            <div class="title">Interactive terminal</div>
            <\${TerminalPanel} taskId=\${task.id} />
          </div>
          <div class="section">
            <div class="title">Prompt</div>
            <div class="stream"><div class="text">\${task.prompt}</div></div>
          </div>
          <div class="section">
            <div class="title">Plan</div>
            \${task.plan ? html\`<\${PlanView} plan=\${task.plan} />\` : html\`<div class="notice">No plan has been reported yet.</div>\`}
          </div>
          <div class="section">
            <div class="title">Repository runs</div>
            \${taskRuns.length === 0
              ? html\`<div class="notice">\${task.status === "failed" ? "Task failed before any repository run started." : "Waiting for runs…"}</div>\`
              : html\`<div class="detail-list">\${taskRuns.map((r) => html\`<div class="repo-chip" key=\${r.id} onClick=\${() => onSelectRun(r.id)}>
                  <div class="rrepo"><span class="dot-status \${r.status}"></span>\${r.repo || r.name}</div>
                  <div class="rmeta">\${r.status} · \${r.branch}</div>
                </div>\`)}</div>\`}
          </div>
          \${activityRun ? html\`<div class="section">
            <div class="title">Task activity</div>
            <div class="sub">\${activityRun.repo || activityRun.name} · \${activityRun.status}</div>
            <\${Stream} runId=\${activityRun.id} />
          </div>\` : null}
        </div>\`;
      }

      function Detail({ run, task, taskRuns, onSelectRun, refreshKey }) {
        if (!run && task) return html\`<\${TaskDetail} task=\${task} taskRuns=\${taskRuns} onSelectRun=\${onSelectRun} />\`;
        if (!run) return html\`<div class="empty">Select a task or run to see its details</div>\`;
        return html\`<div>
          <h3>\${run.name}</h3>
          <div class="sub">\${run.agent}\${run.model ? " · " + run.model : ""} · \${run.sandbox} · \${run.branch}</div>
          <div class="section">
            <span class="badge \${run.status}">\${run.status}</span>
            \${run.repo ? html\`<span class="badge" style=\${{ background: "var(--panel-2)", color: "var(--muted)" }}>\${run.repo}</span>\` : null}
            \${run.completionSignal ? html\`<span style=\${{ color: "var(--muted)", marginLeft: "8px" }}>completed in \${run.iterationsRun} iter</span>\` : null}
            \${run.error ? html\`<div style=\${{ color: "var(--failed)", marginTop: "8px" }}>\${run.error}</div>\` : null}
          </div>
          <div class="section">
            <div class="title">Tokens by model</div>
            <\${UsagePanel} runId=\${run.id} refreshKey=\${refreshKey} />
          </div>
          <div class="section">
            <div class="title">Live activity</div>
            <\${Stream} runId=\${run.id} />
          </div>
        </div>\`;
      }

      function NewTaskModal({ onClose, onCreated }) {
        const [title, setTitle] = useState("");
        const [prompt, setPrompt] = useState("");
        const [busy, setBusy] = useState(false);
        const submit = async () => {
          setBusy(true);
          const res = await fetch("/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, prompt }),
          });
          setBusy(false);
          if (res.ok) { onCreated(); onClose(); }
          else { const e = await res.json(); alert(e.error || "Failed"); }
        };
        return html\`<div class="modal-bg" onClick=\${onClose}>
          <div class="modal" onClick=\${(e) => e.stopPropagation()}>
            <h3>New task</h3>
            <label>Title</label>
            <input value=\${title} onInput=\${(e) => setTitle(e.target.value)} placeholder="Add dark mode" />
            <label>Prompt / PRD</label>
            <textarea value=\${prompt} onInput=\${(e) => setPrompt(e.target.value)} placeholder="Describe the work to assign to an agent..."></textarea>
            <div class="actions">
              <button class="secondary" onClick=\${onClose}>Cancel</button>
              <button disabled=\${busy} onClick=\${submit}>\${busy ? "Creating…" : "Create & assign"}</button>
            </div>
          </div>
        </div>\`;
      }

      function App() {
        const [runs, setRuns] = useState([]);
        const [tasks, setTasks] = useState([]);
        const [selected, setSelected] = useState(null);
        const [showModal, setShowModal] = useState(false);
        const [refreshKey, setRefreshKey] = useState(0);
        const [view, setView] = useState("task");
        const [detailWidth, setDetailWidth] = useState(() => Number(localStorage.getItem("sandcastle:detailWidth")) || 500);
        const [draggingDetail, setDraggingDetail] = useState(false);

        useEffect(() => {
          if (!draggingDetail) return;
          const onMove = (event) => {
            const next = Math.min(Math.max(window.innerWidth - event.clientX, 360), Math.max(window.innerWidth - 420, 420));
            setDetailWidth(next);
            localStorage.setItem("sandcastle:detailWidth", String(next));
          };
          const onUp = () => setDraggingDetail(false);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          return () => {
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
        }, [draggingDetail]);

        const load = useCallback(() => {
          Promise.all([api("/api/runs"), api("/api/tasks")]).then(([r, t]) => {
            setRuns(r);
            setTasks(t);
            setSelected((cur) => cur ?? (t[0] ? { type: "task", id: t[0].id } : r[0] ? { type: "run", id: r[0].id } : null));
          });
        }, []);
        useEffect(() => { load(); }, [load]);

        useEffect(() => {
          const es = new EventSource("/api/stream");
          es.addEventListener("change", (m) => {
            const c = JSON.parse(m.data);
            if (c.kind === "run-updated") {
              setRuns((prev) => {
                const i = prev.findIndex((x) => x.id === c.run.id);
                if (i === -1) return [c.run, ...prev];
                const next = prev.slice(); next[i] = c.run; return next;
              });
              setSelected((cur) => cur ?? { type: "run", id: c.run.id });
            }
            if (c.kind === "task-updated") {
              setTasks((prev) => {
                const i = prev.findIndex((x) => x.id === c.task.id);
                if (i === -1) return [c.task, ...prev];
                const next = prev.slice(); next[i] = c.task; return next;
              });
              setSelected((cur) => cur ?? { type: "task", id: c.task.id });
            }
            if (c.kind === "run-event") setRefreshKey((k) => k + 1);
          });
          return () => es.close();
        }, []);

        const selectedRunId = selected && selected.type === "run" ? selected.id : null;
        const selectedTaskId = selected && selected.type === "task" ? selected.id : null;
        const selectedRun = runs.find((r) => r.id === selectedRunId) || null;
        const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
        const selectedTaskRuns = selectedTask ? runs.filter((r) => r.taskId === selectedTask.id) : [];

        return html\`<div>
          <header>
            <div class="brand">
              <div class="brand-mark">S</div>
              <div>
                <div class="tagline">Managed agent console</div>
                <h1>Sandcastle Board</h1>
                <span class="dot">\${runs.length} run\${runs.length === 1 ? "" : "s"} · \${tasks.length} task\${tasks.length === 1 ? "" : "s"}</span>
              </div>
            </div>
            <div style=\${{ display: "flex", alignItems: "center" }}>
              <div class="toggle">
                <button class=\${view === "task" ? "on" : ""} onClick=\${() => setView("task")}>By task</button>
                <button class=\${view === "status" ? "on" : ""} onClick=\${() => setView("status")}>By status</button>
              </div>
              <button onClick=\${() => setShowModal(true)}>New task</button>
            </div>
          </header>
          <div class="layout" style=\${{ "--detail-width": detailWidth + "px" }}>
            <div class="board">
              <\${Overview} tasks=\${tasks} runs=\${runs} />
              \${view === "status"
                ? html\`<div class="columns">
                    \${STATUSES.map((status) => {
                      const items = runs.filter((r) => r.status === status);
                      return html\`<div class="column" key=\${status}>
                        <h2>\${status} <span class="count">\${items.length}</span></h2>
                        \${items.length === 0 ? html\`<div class="empty">—</div>\` : items.map((r) => html\`
                          <div class="card \${r.id === selectedRunId ? "active" : ""}" key=\${r.id} onClick=\${() => setSelected({ type: "run", id: r.id })}>
                            <div class="name">\${r.name}</div>
                            <div class="meta">
                              <span>\${r.agent}\${r.model ? " · " + r.model : ""}</span>
                              \${r.repo ? html\`<span>\${r.repo}</span>\` : null}
                              \${r.commits > 0 ? html\`<span>\${r.commits} commit\${r.commits === 1 ? "" : "s"}</span>\` : null}
                            </div>
                          </div>\`)}
                      </div>\`;
                    })}
                  </div>\`
                : html\`<\${TaskGroups} tasks=\${tasks} runs=\${runs} selectedRunId=\${selectedRunId} selectedTaskId=\${selectedTaskId} onSelectRun=\${(id) => setSelected({ type: "run", id })} onSelectTask=\${(id) => setSelected({ type: "task", id })} />\`}
            </div>
            <div class="resize-handle \${draggingDetail ? "dragging" : ""}" title="Drag to resize details" onMouseDown=\${() => setDraggingDetail(true)}></div>
            <div class="detail">
              <\${Detail} run=\${selectedRun} task=\${selectedTask} taskRuns=\${selectedTaskRuns} onSelectRun=\${(id) => setSelected({ type: "run", id })} refreshKey=\${refreshKey} />
            </div>
          </div>
          \${showModal ? html\`<\${NewTaskModal} onClose=\${() => setShowModal(false)} onCreated=\${load} />\` : null}
        </div>\`;
      }

      createRoot(document.getElementById("root")).render(html\`<\${App} />\`);
    </script>
  </body>
</html>`;
