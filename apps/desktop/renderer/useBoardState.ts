import { useCallback, useEffect, useState } from "react";
import {
  fetchArtifacts,
  fetchCompany,
  fetchRoleProfiles,
  fetchTasks,
  type BoardArtifact,
  type BoardTask,
  type CompanyView,
} from "./boardApi.js";

export interface BoardState {
  readonly company: CompanyView | null;
  readonly tasks: BoardTask[];
  readonly roleProfiles: Record<string, unknown>;
  readonly selectedTask: BoardTask | null;
  readonly selectedTaskArtifacts: BoardArtifact[];
  readonly selectTask: (taskId: string) => void;
  readonly refresh: () => void;
  readonly boardReachable: boolean;
}

/**
 * Read-model over the board HTTP API: initial fetch plus the board's own SSE
 * stream (`/api/stream`) for live task updates. The spike never stores board
 * state of its own.
 */
export const useBoardState = (): BoardState => {
  const [company, setCompany] = useState<CompanyView | null>(null);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [roleProfiles, setRoleProfiles] = useState<Record<string, unknown>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskArtifacts, setSelectedTaskArtifacts] = useState<
    BoardArtifact[]
  >([]);
  const [boardReachable, setBoardReachable] = useState(true);

  const refresh = useCallback(() => {
    fetchTasks()
      .then((next) => {
        setTasks(next);
        setBoardReachable(true);
        setSelectedTaskId((current) => current ?? next[0]?.id ?? null);
      })
      .catch(() => setBoardReachable(false));
    fetchCompany()
      .then(setCompany)
      .catch(() => {});
    fetchRoleProfiles()
      .then((body) => setRoleProfiles(body.roleProfiles))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const stream = new EventSource("/api/stream");
    stream.addEventListener("change", (message) => {
      const change = JSON.parse((message as MessageEvent).data) as {
        kind: string;
        task?: BoardTask;
      };
      if (change.kind === "task-updated" && change.task) {
        const updated = change.task;
        setTasks((current) => {
          const index = current.findIndex((task) => task.id === updated.id);
          if (index === -1) return [updated, ...current];
          const next = current.slice();
          next[index] = updated;
          return next;
        });
      }
    });
    stream.onerror = () => setBoardReachable(false);
    stream.onopen = () => setBoardReachable(true);
    return () => stream.close();
  }, [refresh]);

  useEffect(() => {
    if (!selectedTaskId) {
      setSelectedTaskArtifacts([]);
      return;
    }
    let active = true;
    fetchArtifacts(selectedTaskId)
      .then((body) => {
        if (active) setSelectedTaskArtifacts(body.artifacts);
      })
      .catch(() => {
        if (active) setSelectedTaskArtifacts([]);
      });
    return () => {
      active = false;
    };
  }, [selectedTaskId, tasks]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  return {
    company,
    tasks,
    roleProfiles,
    selectedTask,
    selectedTaskArtifacts,
    selectTask: setSelectedTaskId,
    refresh,
    boardReachable,
  };
};
