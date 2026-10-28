import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connector } from "../connector/registry.ts";
import { runManaged } from "../connector/runner.ts";
import { DatabaseSync } from "node:sqlite";
import { scanHistory } from "../connector/history.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-"));
  const dir = join(root, "skill");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: test-skill\ndescription: Test only\n---\nDo work.",
  );
  return { root, dir };
}
test("registry requires personal ownership, deduplicates canonical links and blocks system paths", () => {
  const { root, dir } = fixture();
  const c = new Connector(join(root, "state"));
  try {
    assert.throws(() => c.adopt(dir, "thirdParty"));
    const s = c.adopt(dir, "original");
    symlinkSync(dir, join(root, "alias"));
    assert.equal(c.adopt(join(root, "alias"), "original").id, s.id);
    assert.equal(c.skills().length, 1);
    const sys = join(root, ".system");
    mkdirSync(sys);
    writeFileSync(join(sys, "SKILL.md"), "name: x");
    assert.throws(() => c.adopt(sys, "original"));
  } finally {
    c.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("outbox survives restart, replay is idempotent and acknowledgement only removes acknowledged events", () => {
  const { root, dir } = fixture();
  let c = new Connector(join(root, "state"));
  try {
    const s = c.adopt(dir, "original");
    const e = {
      eventId: "evt",
      invocationId: "call",
      skillId: s.id,
      occurredAt: "2026-10-23T16:00:00Z",
      type: "start" as const,
      evidence: "confirmed" as const,
      source: "managed-entry" as const,
    };
    c.enqueue(e);
    c.enqueue(e);
    c.close();
    c = new Connector(join(root, "state"));
    assert.equal(c.pending().length, 1);
    assert.equal(c.pending()[0].occurredAt, e.occurredAt);
    c.ack(["other"]);
    assert.equal(c.pending().length, 1);
    c.ack(["evt"]);
    assert.equal(c.pending().length, 0);
  } finally {
    c.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("real managed process failure still records exactly one start and terminal failure", async () => {
  const { root, dir } = fixture();
  const c = new Connector(join(root, "state"));
  try {
    const s = c.adopt(dir, "original");
    const code = await runManaged(c, s.id, process.execPath, [
      "-e",
      "process.exit(3)",
    ]);
    assert.equal(code, 3);
    const events = c.pending();
    assert.equal(events.filter((e) => e.type === "start").length, 1);
    assert.equal(events.find((e) => e.type === "end")?.status, "failed");
    assert.equal(events[0].invocationId, events[1].invocationId);
  } finally {
    c.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("history scanner catches a command completing after later commands and does not duplicate replays", () => {
  const { root, dir } = fixture();
  const c = new Connector(join(root, "state"));
  const source = new DatabaseSync(join(root, "thread_history_1.sqlite"));
  try {
    const skill = c.adopt(dir, "original");
    c.setting("history-cursor", "10000");
    source.exec(
      "CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT,created_at_ms INTEGER,started_at_ms INTEGER,item_type TEXT)",
    );
    source
      .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)")
      .run(
        "thread",
        "turn",
        "slow",
        JSON.stringify({ status: "inProgress", command: "cat " + skill.path }),
        10000,
        10000,
        "commandExecution",
      );
    scanHistory(c, root);
    source.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)").run(
      "thread",
      "turn2",
      "newer",
      JSON.stringify({
        status: "completed",
        exitCode: 0,
        command: "echo ok",
      }),
      20000,
      20000,
      "commandExecution",
    );
    scanHistory(c, root);
    source.prepare("UPDATE thread_items SET item_json=? WHERE item_id=?").run(
      JSON.stringify({
        status: "completed",
        exitCode: 0,
        command: "cat " + skill.path,
      }),
      "slow",
    );
    scanHistory(c, root);
    scanHistory(c, root);
    assert.equal(c.pending().length, 1);
    assert.equal(c.pending()[0].evidence, "inferred");
  } finally {
    source.close();
    c.close();
    rmSync(root, { recursive: true, force: true });
  }
});
