import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { Service } from "../src/server/service.ts";

test("file-read evidence has unknown execution status, including legacy rows, while managed execution keeps its lifecycle", async () => {
  const db = await openDB(":memory:"),
    service = new Service(db);
  try {
    const pairing = await service.createPairing();
    const device = await service.pair({
      code: pairing.code,
      name: "Test device",
    });
    const id = "55555555-5555-4555-8555-555555555555";
    const at = new Date().toISOString();
    const base = { skillId: id, occurredAt: at, type: "start", version: "v1" };
    await service.ingest(device.deviceId, {
      skills: [
        {
          id,
          name: "Report",
          description: "报告",
          ownership: "original",
          version: "v1",
        },
      ],
      events: [
        {
          ...base,
          eventId: "read",
          invocationId: "read",
          evidence: "inferred",
          source: "history-read",
        },
        {
          ...base,
          eventId: "explicit",
          invocationId: "explicit",
          evidence: "confirmed",
          source: "native-explicit",
          status: "unknown",
          sessionRef: "a".repeat(20),
          turnRef: "b".repeat(20),
        },
        {
          ...base,
          eventId: "managed",
          invocationId: "managed",
          evidence: "confirmed",
          source: "managed-entry",
        },
      ],
    });
    assert.equal(
      (
        await db.get(
          "SELECT status FROM invocations WHERE invocation_id='read'",
        )
      )?.status,
      "unknown",
    );
    await db.run(
      "UPDATE invocations SET status='running' WHERE invocation_id='read'",
    );
    const state = await service.state({ range: "today" });
    const status = Object.fromEntries(
      state.usage.events.map((e: any) => [e.invocation_id, e.status]),
    );
    assert.deepEqual(status, {
      read: "unknown",
      explicit: "unknown",
      managed: "running",
    });
    assert.equal(state.usage.inferred, 1);
    assert.equal(state.usage.confirmed, 2);
    await service.ingest(device.deviceId, {
      skills: [],
      events: [
        {
          ...base,
          eventId: "managed-end",
          invocationId: "managed",
          type: "end",
          evidence: "confirmed",
          source: "managed-entry",
          status: "succeeded",
        },
      ],
    });
    assert.equal(
      (await service.state({ range: "today" })).usage.events.find(
        (e: any) => e.invocation_id === "managed",
      )?.status,
      "succeeded",
    );
  } finally {
    await db.close();
  }
});
