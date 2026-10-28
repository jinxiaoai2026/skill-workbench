import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Connector } from "../connector/registry.ts";
import { scanHistory } from "../connector/history.ts";
import { openDB } from "../src/server/db.ts";
import { Service } from "../src/server/service.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-skill-"));
  const directory = join(root, "ppt-master");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "SKILL.md"),
    "---\nname: ppt-master\ndescription: Presentations\n---\nPrivate instructions.",
  );
  const connector = new Connector(join(root, "connector"));
  const skill = connector.adopt(directory, "imported", undefined, false, {
    customName: "PPT",
  });
  const history = new DatabaseSync(join(root, "thread_history_1.sqlite"));
  history.exec(
    "CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT,created_at_ms INTEGER,started_at_ms INTEGER,item_type TEXT)",
  );
  connector.setting(
    "native-invocation-position",
    JSON.stringify({ rowid: 0, activatedAt: 10000 }),
  );
  connector.setting("history-cursor", "10000");
  const message = (text: string, turn = "turn", id = turn, at = 11000) =>
    history.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)").run(
      "thread",
      turn,
      id,
      JSON.stringify({
        type: "userMessage",
        content: [{ type: "text", text, text_elements: [] }],
      }),
      at,
      at,
      "userMessage",
    );
  return {
    root,
    connector,
    skill,
    history,
    message,
    close() {
      connector.close();
      history.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("native custom and original names record one explicit invocation per turn without commands or prompt text", () => {
  const f = fixture();
  try {
    f.message(
      "请使用 $PPT 和 $ppt-master 完成季度汇报，private-customer-info",
      "first",
    );
    f.message("请用$PPT 再做一版", "second", "second", 12000);
    scanHistory(f.connector, f.root);
    scanHistory(f.connector, f.root);
    const events = f.connector.pending();
    assert.equal(events.length, 2);
    assert.ok(
      events.every(
        (e) =>
          e.skillId === f.skill.id &&
          e.evidence === "confirmed" &&
          String(e.source) === "native-explicit",
      ),
    );
    assert.ok(events.every((e) => e.status === "unknown"));
    assert.equal(events[0].occurredAt, "1970-01-01T00:00:11.000Z");
    assert.equal(
      JSON.stringify(events).includes("private-customer-info"),
      false,
    );
    assert.equal(JSON.stringify(events).includes("thread"), false);
    assert.equal(JSON.stringify(events).includes(f.skill.path), false);
    f.connector.ack(events.map((e) => e.eventId));
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 0);
  } finally {
    f.close();
  }
});

test("mentions, examples, escaped tokens, longer names and non-user messages do not inflate counts", () => {
  const f = fixture();
  try {
    const examples = [
      "PPT是什么",
      "`$PPT` 是示例",
      "```text\n$PPT 做汇报\n```",
      "> $PPT 做汇报",
      "\\$PPT literal",
      "$PPTX 做汇报",
      "$ppt-master-extra",
      "~~x~~\n~~~\n$PPT\n~~~",
      "````text\n```\n$PPT 做汇报\n```\n````",
      "```text\n``` not-a-closing-fence\n$PPT 做汇报\n```",
      "    $PPT 做汇报",
      "\t$PPT 做汇报",
    ];
    examples.forEach((v, i) => f.message(v, "exclude" + i));
    f.history
      .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)")
      .run(
        "thread",
        "assistant",
        "assistant",
        JSON.stringify({ type: "agentMessage", text: "$PPT" }),
        11000,
        11000,
        "agentMessage",
      );
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 0);
    f.message("$PPT 做真实汇报", "actual", "actual", 12000);
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 1);
  } finally {
    f.close();
  }
});

test("Chinese custom names work and ambiguous original names cannot select an arbitrary skill", () => {
  const f = fixture();
  try {
    f.connector.adopt(f.skill.path, "imported", f.skill.id, false, {
      customName: "演示汇报",
    });
    const other = join(f.root, "second-copy");
    mkdirSync(other);
    writeFileSync(
      join(other, "SKILL.md"),
      "---\nname: ppt-master\ndescription: Other copy\n---\nOther.",
    );
    f.connector.adopt(other, "original");
    f.message("$演示汇报 帮我制作", "cn");
    f.message("$ppt-master 帮我制作", "ambiguous", "ambiguous", 12000);
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 1);
    assert.equal(f.connector.pending()[0].skillId, f.skill.id);
  } finally {
    f.close();
  }
});

test("enabling native statistics starts now rather than backfilling old requests", () => {
  const f = fixture();
  try {
    f.connector.db
      .prepare("DELETE FROM settings WHERE key=?")
      .run("native-invocation-position");
    f.message("$PPT 历史任务");
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 0);
    f.message("$PPT 新任务", "new", "new", Date.now() + 1);
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 1);
  } finally {
    f.close();
  }
});

test("equal timestamps paginate beyond one scan and connector restart does not lose or duplicate requests", () => {
  const f = fixture();
  let restarted: Connector | undefined;
  try {
    const insert = f.history.prepare(
      "INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)",
    );
    f.history.exec("BEGIN");
    for (let i = 0; i < 5002; i++)
      insert.run(
        "thread",
        "turn-" + String(i).padStart(5, "0"),
        "item",
        JSON.stringify({
          type: "userMessage",
          content: [
            { type: "text", text: i >= 5000 ? "$PPT" : "ordinary text" },
          ],
        }),
        11000,
        11000,
        "userMessage",
      );
    f.history.exec("COMMIT");
    scanHistory(f.connector, f.root);
    restarted = new Connector(join(f.root, "connector"));
    scanHistory(restarted, f.root);
    scanHistory(restarted, f.root);
    assert.equal(restarted.pending().length, 2);
  } finally {
    restarted?.close();
    f.close();
  }
});

test("unsupported JSON history items are skipped without blocking later requests", () => {
  const f = fixture();
  try {
    f.history
      .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)")
      .run("thread", "bad", "bad", "null", 11000, 11000, "userMessage");
    f.message("$PPT 新任务", "valid", "valid", 12000);
    assert.doesNotThrow(() => scanHistory(f.connector, f.root));
    assert.equal(f.connector.pending().length, 1);
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 1);
  } finally {
    f.close();
  }
});

test("late history inserts with earlier timestamps and sort keys are still counted once", () => {
  const f = fixture();
  try {
    f.message("$PPT 第一项", "z-turn", "z-item", 12000);
    scanHistory(f.connector, f.root);
    f.message("$PPT 延迟落盘", "a-turn", "a-item", 11000);
    scanHistory(f.connector, f.root);
    scanHistory(f.connector, f.root);
    assert.equal(f.connector.pending().length, 2);
  } finally {
    f.close();
  }
});

test("native events sync into date-filtered counts, supersede same-turn reads and preserve raw evidence", async () => {
  const f = fixture(),
    db = await openDB(":memory:"),
    service = new Service(db);
  try {
    const pairing = await service.createPairing(),
      device = await service.pair({ code: pairing.code, name: "Mac" });
    f.message("$PPT 做汇报");
    scanHistory(f.connector, f.root);
    const direct = f.connector.pending()[0];
    assert.ok(direct, "scanner must provide an explicit event");
    const { path, syncContent, ...skill } = f.skill;
    const read = {
      ...direct,
      eventId: "read-id",
      invocationId: "read-id",
      evidence: "inferred" as const,
      source: "history-read" as const,
      status: undefined,
    };
    await service.ingest(device.deviceId, { skills: [skill], events: [read] });
    assert.equal(
      (
        await service.state({
          range: "custom",
          from: "1970-01-01",
          to: "1970-01-01",
        })
      ).usage.inferred,
      1,
    );
    const ack = await service.ingest(device.deviceId, {
      skills: [],
      events: [direct],
    });
    f.connector.ack(ack.acked);
    await service.ingest(device.deviceId, { skills: [], events: [direct] });
    const state = await service.state({
      range: "custom",
      from: "1970-01-01",
      to: "1970-01-01",
    });
    assert.equal(state.usage.confirmed, 1);
    assert.equal(state.usage.inferred, 0);
    assert.equal(state.skills[0].stats.period, 1);
    assert.equal(state.usage.events[0].source, "native-explicit");
    assert.equal(state.usage.events[0].status, "unknown");
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM events"))?.n, 2);
    assert.equal(
      (
        await service.state({
          range: "custom",
          from: "1970-01-02",
          to: "1970-01-02",
        })
      ).usage.confirmed,
      0,
    );
    assert.equal(
      (
        await service.state({
          range: "custom",
          from: "1970-01-01",
          to: "1970-01-01",
          deviceId: "other",
        })
      ).usage.confirmed,
      0,
    );
    await assert.rejects(() =>
      service.ingest(device.deviceId, {
        skills: [],
        events: [
          {
            ...direct,
            eventId: "forged",
            invocationId: "forged",
            evidence: "inferred",
          },
        ],
      }),
    );
    await assert.rejects(() =>
      service.ingest(device.deviceId, {
        skills: [],
        events: [
          { ...direct, eventId: "fake-end", type: "end", status: "succeeded" },
        ],
      }),
    );
    assert.equal(f.connector.pending().length, 0);
  } finally {
    await db.close();
    f.close();
  }
});
