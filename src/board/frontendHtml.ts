/**
 * The workflow board frontend, embedded as a single self-contained HTML string.
 *
 * Embedding (rather than shipping a separate asset) means the board works
 * identically under `tsx` in development and from the bundled `dist/main.js`,
 * with no build step and no extra files in the published package. React is
 * loaded from an ESM CDN and `htm` provides JSX-like templating without a
 * compiler.
 */
export const BOARD_FRONTEND_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sandcastle Board</title>
    <style>
      :root {
        --bg: #0f1115;
        --panel: #181b22;
        --panel-2: #1f232c;
        --border: #2a2f3a;
        --text: #e6e9ef;
        --muted: #9aa3b2;
        --accent: #6ea8fe;
        --running: #f0b429;
        --succeeded: #34d399;
        --failed: #f87171;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 20px; border-bottom: 1px solid var(--border);
        position: sticky; top: 0; background: var(--bg); z-index: 5;
      }
      header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
      header .dot { color: var(--muted); font-size: 12px; }
      button {
        background: var(--accent); color: #0b1020; border: 0; border-radius: 6px;
        padding: 8px 14px; font-weight: 600; cursor: pointer;
      }
      button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
      .layout { display: grid; grid-template-columns: 1fr 460px; gap: 0; height: calc(100vh - 53px); }
      .board { overflow: auto; padding: 18px; }
      .columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
      .column h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 10px; }
      .count { color: var(--muted); font-weight: 500; }
      .card {
        background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
        padding: 12px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s;
      }
      .card:hover { border-color: var(--accent); }
      .card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
      .card .name { font-weight: 600; margin-bottom: 4px; }
      .card .meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
      .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
      .badge.running { background: rgba(240,180,41,.15); color: var(--running); }
      .badge.succeeded { background: rgba(52,211,153,.15); color: var(--succeeded); }
      .badge.failed { background: rgba(248,113,113,.15); color: var(--failed); }
      .detail { border-left: 1px solid var(--border); background: var(--panel); overflow: auto; padding: 18px; }
      .detail h3 { margin: 0 0 4px; }
      .detail .sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
      .section { margin-bottom: 18px; }
      .section > .title { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--border); }
      th:first-child, td:first-child { text-align: left; }
      .stream { background: #0b0e13; border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-height: 360px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .stream .text { white-space: pre-wrap; }
      .stream .tool { color: var(--accent); }
      .stream .row { margin-bottom: 4px; }
      .empty { color: var(--muted); padding: 30px 0; text-align: center; }
      .repo-group { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; }
      .repo-group .head { padding: 8px 10px; display: flex; justify-content: space-between; }
      .toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin-right: 12px; }
      .toggle button { background: var(--panel-2); color: var(--muted); border: 0; border-radius: 0; padding: 6px 12px; font-weight: 600; }
      .toggle button.on { background: var(--accent); color: #0b1020; }
      .task-group { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 16px; }
      .task-group > .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
      .task-group .task-title { font-weight: 700; font-size: 15px; }
      .task-group .task-prompt { color: var(--muted); font-size: 12px; margin-bottom: 12px; white-space: pre-wrap; }
      .plan { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
      .plan .label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 8px 0 3px; }
      .plan .label:first-child { margin-top: 0; }
      .plan .body { white-space: pre-wrap; font-size: 13px; }
      .plan .repo-task { border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 6px; }
      .plan .repo-task .rname { font-weight: 600; }
      .plan .repo-task .rreason { color: var(--muted); font-size: 12px; }
      .repo-runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
      .repo-chip { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: border-color .15s; }
      .repo-chip:hover { border-color: var(--accent); }
      .repo-chip.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
      .repo-chip .rrepo { font-weight: 600; margin-bottom: 4px; }
      .repo-chip .rmeta { color: var(--muted); font-size: 11px; }
      .dot-status { display: inline-block; width: 8px; height: 8px; border-radius: 999px; margin-right: 6px; }
      .dot-status.running { background: var(--running); }
      .dot-status.succeeded { background: var(--succeeded); }
      .dot-status.failed { background: var(--failed); }
      .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 10; }
      .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; width: 520px; }
      .modal h3 { margin: 0 0 14px; }
      .modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
      .modal input, .modal textarea {
        width: 100%; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
        border-radius: 6px; padding: 8px; font: inherit;
      }
      .modal textarea { min-height: 120px; resize: vertical; }
      .modal .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React, { useState, useEffect, useCallback } from "https://esm.sh/react@18.3.1";
      import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
      import htm from "https://esm.sh/htm@3.1.1";
      const html = htm.bind(React.createElement);

      const api = (path, opts) => fetch(path, opts).then((r) => r.json());
      const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
      const STATUSES = ["running", "succeeded", "failed"];

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
          ["agent-text", "agent-tool-call", "iteration-started", "commit"].includes(r.event.type)
        );
        if (visible.length === 0) return html\`<div class="empty">No activity yet</div>\`;
        return html\`<div class="stream">\${visible.map((r) => {
          const e = r.event;
          if (e.type === "agent-text") return html\`<div class="row text" key=\${r.seq}>\${e.message}</div>\`;
          if (e.type === "agent-tool-call") return html\`<div class="row tool" key=\${r.seq}>→ \${e.name} \${e.formattedArgs}</div>\`;
          if (e.type === "iteration-started") return html\`<div class="row" key=\${r.seq} style="color:var(--muted)">— iteration \${e.iteration}/\${e.maxIterations} —</div>\`;
          if (e.type === "commit") return html\`<div class="row" key=\${r.seq} style="color:var(--succeeded)">✓ commit \${e.sha.slice(0,9)}</div>\`;
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

      function PlanView({ plan }) {
        if (!plan) return null;
        return html\`<div class="plan">
          \${plan.alignmentSummary ? html\`
            <div class="label">Alignment</div>
            <div class="body">\${plan.alignmentSummary}</div>\` : null}
          \${plan.technicalPlan ? html\`
            <div class="label">Technical plan</div>
            <div class="body">\${plan.technicalPlan}</div>\` : null}
          \${plan.repositories && plan.repositories.length > 0 ? html\`
            <div class="label">Per-repository tasks</div>
            \${plan.repositories.map((r) => html\`<div class="repo-task" key=\${r.name}>
              <div class="rname">\${r.name}</div>
              <div class="body">\${r.task}</div>
              \${r.reason ? html\`<div class="rreason">\${r.reason}</div>\` : null}
            </div>\`)}\` : null}
        </div>\`;
      }

      function TaskGroups({ tasks, runs, selectedId, onSelect }) {
        if (tasks.length === 0)
          return html\`<div class="empty">No tasks yet — create one to fan it out across repositories.</div>\`;
        return html\`<div>\${tasks.map((t) => {
          const taskRuns = runs.filter((r) => r.taskId === t.id);
          return html\`<div class="task-group" key=\${t.id}>
            <div class="head">
              <span class="task-title">\${t.title}</span>
              <span class="badge \${t.status === "succeeded" ? "succeeded" : t.status === "failed" ? "failed" : "running"}">\${t.status}</span>
            </div>
            <div class="task-prompt">\${t.prompt}</div>
            <\${PlanView} plan=\${t.plan} />
            \${taskRuns.length === 0
              ? html\`<div class="empty">Waiting for runs…</div>\`
              : html\`<div class="repo-runs">\${taskRuns.map((r) => html\`
                  <div class="repo-chip \${r.id === selectedId ? "active" : ""}" key=\${r.id} onClick=\${() => onSelect(r.id)}>
                    <div class="rrepo"><span class="dot-status \${r.status}"></span>\${r.repo || r.name}</div>
                    <div class="rmeta">\${r.branch}\${r.commits > 0 ? " · " + r.commits + " commit" + (r.commits === 1 ? "" : "s") : ""}</div>
                  </div>\`)}</div>\`}
          </div>\`;
        })}</div>\`;
      }

      function Detail({ run, refreshKey }) {
        if (!run) return html\`<div class="empty">Select a run to see its details</div>\`;
        return html\`<div>
          <h3>\${run.name}</h3>
          <div class="sub">\${run.agent}\${run.model ? " · " + run.model : ""} · \${run.sandbox} · \${run.branch}</div>
          <div class="section">
            <span class="badge \${run.status}">\${run.status}</span>
            \${run.repo ? html\`<span class="badge" style="background:var(--panel-2);color:var(--muted)">\${run.repo}</span>\` : null}
            \${run.completionSignal ? html\`<span style="color:var(--muted);margin-left:8px">completed in \${run.iterationsRun} iter</span>\` : null}
            \${run.error ? html\`<div style="color:var(--failed);margin-top:8px">\${run.error}</div>\` : null}
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
        const [selectedId, setSelectedId] = useState(null);
        const [showModal, setShowModal] = useState(false);
        const [refreshKey, setRefreshKey] = useState(0);
        const [view, setView] = useState("task");

        const load = useCallback(() => {
          api("/api/runs").then((r) => {
            setRuns(r);
            setSelectedId((cur) => cur ?? (r[0] ? r[0].id : null));
          });
          api("/api/tasks").then(setTasks);
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
            }
            if (c.kind === "task-updated") {
              setTasks((prev) => {
                const i = prev.findIndex((x) => x.id === c.task.id);
                if (i === -1) return [c.task, ...prev];
                const next = prev.slice(); next[i] = c.task; return next;
              });
            }
            if (c.kind === "run-event") setRefreshKey((k) => k + 1);
          });
          return () => es.close();
        }, []);

        const selected = runs.find((r) => r.id === selectedId) || null;

        return html\`<div>
          <header>
            <div>
              <h1>🏰 Sandcastle Board</h1>
              <span class="dot">\${runs.length} run\${runs.length === 1 ? "" : "s"} · \${tasks.length} task\${tasks.length === 1 ? "" : "s"}</span>
            </div>
            <div style="display:flex;align-items:center">
              <div class="toggle">
                <button class=\${view === "task" ? "on" : ""} onClick=\${() => setView("task")}>By task</button>
                <button class=\${view === "status" ? "on" : ""} onClick=\${() => setView("status")}>By status</button>
              </div>
              <button onClick=\${() => setShowModal(true)}>New task</button>
            </div>
          </header>
          <div class="layout">
            <div class="board">
              \${view === "status"
                ? html\`<div class="columns">
                    \${STATUSES.map((status) => {
                      const items = runs.filter((r) => r.status === status);
                      return html\`<div class="column" key=\${status}>
                        <h2>\${status} <span class="count">\${items.length}</span></h2>
                        \${items.length === 0 ? html\`<div class="empty">—</div>\` : items.map((r) => html\`
                          <div class="card \${r.id === selectedId ? "active" : ""}" key=\${r.id} onClick=\${() => setSelectedId(r.id)}>
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
                : html\`<\${TaskGroups} tasks=\${tasks} runs=\${runs} selectedId=\${selectedId} onSelect=\${setSelectedId} />\`}
            </div>
            <div class="detail">
              <\${Detail} run=\${selected} refreshKey=\${refreshKey} />
            </div>
          </div>
          \${showModal ? html\`<\${NewTaskModal} onClose=\${() => setShowModal(false)} onCreated=\${load} />\` : null}
        </div>\`;
      }

      createRoot(document.getElementById("root")).render(html\`<\${App} />\`);
    </script>
  </body>
</html>`;
