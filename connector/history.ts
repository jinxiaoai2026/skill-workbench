import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Connector } from "./registry.ts";
import { inferSkillReads } from "../src/core/usage.ts";
import { scanNativeInvocations } from "./native-invocations.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function scanHistory(
  c: Connector,
  codexHome: string,
): {
  examined: number;
  inferred: number;
  explicit?: number;
  supported: boolean;
} {
  const file = join(codexHome, "thread_history_1.sqlite");
  if (!existsSync(file)) return { examined: 0, inferred: 0, supported: false };
  const db = new DatabaseSync(file, { readOnly: true });
  let examined = 0,
    inferred = 0;
  try {
    const explicit = scanNativeInvocations(c, db);
    // Timestamp overlap plus deterministic IDs handles equal timestamps and replay.
    const cursor = Number(c.setting("history-cursor") || Date.now());
    const pending = JSON.parse(c.setting("history-pending") || "[]") as {
      thread: string;
      id: string;
    }[];
    const pendingSQL = pending
      .map(() => "(thread_id=? AND item_id=?)")
      .join(" OR ");
    const rows = db
      .prepare(
        "SELECT thread_id,turn_id,item_id,item_json,created_at_ms,started_at_ms FROM thread_items WHERE (created_at_ms>=?" +
          (pendingSQL ? " OR " + pendingSQL : "") +
          ") AND item_type='commandExecution' ORDER BY created_at_ms,item_id LIMIT 5000",
      )
      .all(cursor - 1000, ...pending.flatMap((p) => [p.thread, p.id])) as any[];
    let max = cursor;
    for (const r of rows) {
      examined++;
      max = Math.max(max, r.created_at_ms);
      let item: any;
      try {
        item = JSON.parse(r.item_json);
      } catch {
        continue;
      }
      const index = pending.findIndex(
        (p) => p.thread === r.thread_id && p.id === r.item_id,
      );
      if (index >= 0) pending.splice(index, 1);
      if (item.status === "inProgress") {
        pending.push({ thread: r.thread_id, id: r.item_id });
        continue;
      }
      if (item.status !== "completed" || item.exitCode !== 0) continue;
      for (const s of inferSkillReads(String(item.command || ""), c.skills())) {
        const key = hash([r.thread_id, r.turn_id, s.skillId].join(":"));
        c.enqueue({
          eventId: key,
          invocationId: "read-" + key,
          skillId: s.skillId,
          occurredAt: new Date(
            r.started_at_ms || r.created_at_ms,
          ).toISOString(),
          type: "start",
          evidence: "inferred",
          source: "history-read",
          sessionRef: hash(r.thread_id).slice(0, 20),
          turnRef: hash(r.turn_id || "").slice(0, 20),
        });
        inferred++;
      }
    }
    c.setting("history-pending", JSON.stringify(pending));
    c.setting("history-cursor", String(max));
    return { examined, inferred, explicit, supported: true };
  } finally {
    db.close();
  }
}
