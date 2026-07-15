import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-interaction-"));

describe("Runtime Interaction", () => {
  it("persists a Session, Messages, and an owned Permission decision", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      const participant = database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      });
      const message = database.interaction.addMessage({
        sessionId: session.id,
        participantId: participant.id,
        kind: "text",
        content: "Please explain the delivery risk.",
      });
      const permission = database.interaction.requestPermission({
        sessionId: session.id,
        scope: "repository.write",
      });
      const decided = database.interaction.decidePermission({
        permissionId: permission.id,
        expectedStatus: "pending",
        decision: "approved",
      });
      const inspected = database.interaction.inspectSession(session.id);
      const closed = database.interaction.closeSession(session.id);

      assert.equal(message.content, "Please explain the delivery risk.");
      assert.equal(decided.status, "approved");
      assert.equal(inspected.session.mode, "consultation");
      assert.equal(inspected.participants[0]?.id, participant.id);
      assert.equal(inspected.messages[0]?.id, message.id);
      assert.equal(inspected.permissions[0]?.status, "approved");
      assert.equal(inspected.permissions[0]?.scope, "repository.write");
      assert.equal(closed.status, "closed");
      assert.throws(
        () =>
          database.interaction.addMessage({
            sessionId: session.id,
            participantId: participant.id,
            kind: "text",
            content: "Late message",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "INTERACTION_SESSION_STATE_INVALID",
      );
      assert.equal(database.pipelineRuntime.listRuns().length, 0);
    } finally {
      database.close();
    }
  });
});
