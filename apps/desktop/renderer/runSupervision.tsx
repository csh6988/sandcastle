import { useState } from "react";
import type { RunSupervisionView } from "../runtime/interface.js";

export type RunSupervisionTab = "graph" | "timeline" | "activity";

export type RunSupervisionFrame = {
  readonly generation: number;
  readonly view: RunSupervisionView;
};

export type RunSupervisionState = {
  readonly generation: number;
  readonly view: RunSupervisionView | null;
};

export const applyRunSupervisionFrame = (
  state: RunSupervisionState,
  frame: RunSupervisionFrame,
): RunSupervisionState =>
  frame.generation < state.generation
    ? state
    : { generation: frame.generation, view: frame.view };

type RunSupervisionPanelProps = {
  readonly view: RunSupervisionView;
  readonly busy?: boolean;
  readonly diagnostic?: string | null;
  readonly initialTab?: RunSupervisionTab;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancelAttempt: (attemptId: string) => void;
  readonly onCancelTurn: (turnId: string) => void;
  readonly onDecidePermission: (
    permissionId: string,
    decision: "approved" | "denied",
  ) => void;
  readonly onIntervene: (input: {
    readonly nodeRunId: string;
    readonly reason: string;
    readonly feedback: string;
    readonly outcome: "feedback" | "new-attempt";
  }) => void;
};

export function RunSupervisionPanel({
  view,
  busy = false,
  diagnostic = null,
  initialTab = "graph",
  onPause,
  onResume,
  onCancelAttempt,
  onCancelTurn,
  onDecidePermission,
  onIntervene,
}: RunSupervisionPanelProps) {
  const [tab, setTab] = useState<RunSupervisionTab>(initialTab);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [outcome, setOutcome] = useState<"feedback" | "new-attempt">(
    "feedback",
  );

  return (
    <section data-run-supervision={view.run.id}>
      <header>
        <div>
          <span>Authoritative Run supervision</span>
          <strong data-supervision-run-status={view.run.status}>
            {view.run.status}
          </strong>
        </div>
        <div>
          <button
            data-supervision-command="pause"
            disabled={busy || !view.allowedCommands.pause}
            onClick={onPause}
            type="button"
          >
            Pause
          </button>
          <button
            data-supervision-command="resume"
            disabled={busy || !view.allowedCommands.resume}
            onClick={onResume}
            type="button"
          >
            Resume
          </button>
        </div>
      </header>
      {diagnostic ? (
        <div data-supervision-diagnostic="resync">{diagnostic}</div>
      ) : null}
      <nav aria-label="Run supervision views">
        {(["graph", "timeline", "activity"] as const).map((candidate) => (
          <button
            aria-pressed={tab === candidate}
            data-supervision-tab={candidate}
            key={candidate}
            onClick={() => setTab(candidate)}
            type="button"
          >
            {candidate === "activity" ? "Agent Activity" : candidate}
          </button>
        ))}
      </nav>
      {tab === "graph" ? (
        <div data-supervision-view="graph">
          <ol>
            {view.graph.nodes.map((node) => (
              <li data-node-run-status={node.status} key={node.nodeRunId}>
                <strong>{node.name}</strong> · {node.status}
                {node.attemptId &&
                view.allowedCommands.cancelAttemptIds.includes(
                  node.attemptId,
                ) ? (
                  <button
                    data-cancel-attempt={node.attemptId}
                    disabled={busy}
                    onClick={() => onCancelAttempt(node.attemptId!)}
                    type="button"
                  >
                    Cancel Attempt
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          <ul>
            {view.graph.edges.map((edge) => (
              <li key={`${edge.from}:${edge.to}`}>
                {edge.from} → {edge.to}
              </li>
            ))}
          </ul>
        </div>
      ) : tab === "timeline" ? (
        <ol data-supervision-view="timeline">
          {view.timeline.map((event) => (
            <li data-runtime-event={event.type} key={event.eventId}>
              #{event.sequence} · {event.type} · {event.createdAt}
            </li>
          ))}
        </ol>
      ) : (
        <div data-supervision-view="activity">
          {view.agentActivities.map((activity) => (
            <article
              data-agent-activity={activity.nodeRunId}
              data-agent-activity-status={activity.status}
              key={activity.nodeRunId}
            >
              <strong>{activity.aiMemberName}</strong>
              <span>
                {activity.positionName} · {activity.agentAdapterId} ·{" "}
                {activity.model}
              </span>
              <span>
                {activity.status} · {activity.nextAction}
              </span>
              <span>{activity.totalTokens} tokens</span>
            </article>
          ))}
        </div>
      )}
      <section data-supervision-interactions>
        {view.interactions.map((interaction) => (
          <article
            data-interaction-boundary={interaction.boundary}
            key={interaction.session.id}
          >
            <strong>
              {interaction.boundary === "consultation"
                ? "Consultation · informal"
                : "Run collaboration · execution-bound"}
            </strong>
            {interaction.turns.map((turn) => (
              <div data-turn-status={turn.status} key={turn.id}>
                {turn.status}
                {view.allowedCommands.cancelTurnIds.includes(turn.id) ? (
                  <button
                    data-cancel-turn={turn.id}
                    disabled={busy}
                    onClick={() => onCancelTurn(turn.id)}
                    type="button"
                  >
                    Cancel Turn
                  </button>
                ) : null}
              </div>
            ))}
            {interaction.permissions.map((permission) => (
              <div
                data-permission-status={permission.status}
                key={permission.id}
              >
                {permission.scope} · {permission.status}
                {view.allowedCommands.decidePermissionIds.includes(
                  permission.id,
                ) ? (
                  <>
                    <button
                      data-decide-permission={`${permission.id}:approved`}
                      disabled={busy}
                      onClick={() =>
                        onDecidePermission(permission.id, "approved")
                      }
                      type="button"
                    >
                      Approve
                    </button>
                    <button
                      data-decide-permission={`${permission.id}:denied`}
                      disabled={busy}
                      onClick={() =>
                        onDecidePermission(permission.id, "denied")
                      }
                      type="button"
                    >
                      Deny
                    </button>
                  </>
                ) : null}
              </div>
            ))}
          </article>
        ))}
      </section>
      {view.allowedCommands.interveneNodeRunIds.length > 0 ? (
        <section data-governed-intervention>
          <strong>Governed intervention</strong>
          <input
            aria-label="Intervention reason"
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
          <textarea
            aria-label="Intervention feedback"
            onChange={(event) => setFeedback(event.target.value)}
            value={feedback}
          />
          <select
            aria-label="Intervention outcome"
            onChange={(event) =>
              setOutcome(event.target.value as typeof outcome)
            }
            value={outcome}
          >
            <option value="feedback">Feedback</option>
            <option value="new-attempt">New Attempt</option>
          </select>
          {view.allowedCommands.interveneNodeRunIds.map((nodeRunId) => (
            <button
              data-intervene-node={nodeRunId}
              disabled={busy || reason.trim() === "" || feedback.trim() === ""}
              key={nodeRunId}
              onClick={() =>
                onIntervene({
                  nodeRunId,
                  reason: reason.trim(),
                  feedback: feedback.trim(),
                  outcome,
                })
              }
              type="button"
            >
              Intervene
            </button>
          ))}
        </section>
      ) : null}
    </section>
  );
}
