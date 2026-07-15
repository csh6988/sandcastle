import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { openCompanyDatabase } from "../runtime/storage/sqlite.js";

const percentile95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ??
    0
  );
};

const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-capacity-"));
try {
  const initialized = openCompanyDatabase(companyDir);
  const project = initialized.catalog.createProject({
    name: "Capacity fixture",
    goal: "Measure local Runtime capacity",
  });
  initialized.close();

  const raw = new DatabaseSync(
    join(companyDir, ".sandcastle", "company.sqlite"),
  );
  raw.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
  const insertRun = raw.prepare(
    `INSERT INTO department_runs(
       id, project_id, department_id, status, created_at,
       pipeline_version_id, snapshot_revision_id, revision, updated_at
     ) VALUES (?, ?, 'software-rnd', 'completed', ?, 'software-rnd-pipeline-v1', NULL, 0, ?)`,
  );
  for (let index = 0; index < 10_000; index += 1) {
    const timestamp = `2026-07-15T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
    insertRun.run(`run-capacity-${index}`, project.id, timestamp, timestamp);
  }
  const insertEvent = raw.prepare(
    `INSERT INTO runtime_event_outbox(
       event_id, type, run_id, node_run_id, payload_json, created_at
     ) VALUES (?, 'run.completed', NULL, NULL, '{}', '2026-07-15T00:00:00.000Z')`,
  );
  for (let index = 0; index < 100_000; index += 1) {
    insertEvent.run(`event-capacity-${index}`);
  }
  raw.exec("COMMIT");
  raw.close();

  const database = openCompanyDatabase(companyDir);
  const overviewSamples: number[] = [];
  const eventSamples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const overviewStart = performance.now();
    const overview = database.catalog.overview();
    overviewSamples.push(performance.now() - overviewStart);
    const eventsStart = performance.now();
    database.pipelineRuntime.runtimeEvents({
      afterSequence: 99_000,
      limit: 1_000,
    });
    eventSamples.push(performance.now() - eventsStart);
    if (overview.metrics.completedRuns !== 10_000) {
      throw new Error(
        `Expected 10000 completed Runs, got ${overview.metrics.completedRuns}.`,
      );
    }
  }
  database.close();
  console.log(
    JSON.stringify({
      runs: 10_000,
      events: 100_000,
      overviewP95Ms: Number(percentile95(overviewSamples).toFixed(2)),
      eventPageP95Ms: Number(percentile95(eventSamples).toFixed(2)),
    }),
  );
} finally {
  rmSync(companyDir, { recursive: true, force: true });
}
