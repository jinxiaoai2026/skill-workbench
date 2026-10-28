import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Connector, LocalSkill } from "./registry.ts";
import { allowedSkill } from "../src/core/usage.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Position = { rowid: number; activatedAt: number };

function explicitSkills(content: unknown, skills: LocalSkill[]) {
  if (!Array.isArray(content)) return [];
  const names = new Map<string, Set<string>>();
  for (const skill of skills.filter(allowedSkill)) {
    for (const name of [skill.name, skill.customName].filter(
      Boolean,
    ) as string[]) {
      const key = name.normalize("NFC").toLowerCase();
      const ids = names.get(key) || new Set<string>();
      ids.add(skill.id);
      names.set(key, ids);
    }
  }
  const selected = new Set<string>();
  for (const part of content) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    // Examples are not requests. Do not interpret code or quoted documentation.
    let fence: { character: string; length: number } | undefined;
    const text = part.text
      .split(/\r?\n/)
      .map((line: string) => {
        if (fence) {
          const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
          if (
            closing &&
            closing[1][0] === fence.character &&
            closing[1].length >= fence.length
          )
            fence = undefined;
          return "";
        }
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
          fence = { character: marker[1][0], length: marker[1].length };
          return "";
        }
        return /^(?: {4}| {0,3}\t)|^\s*>/.test(line) ? "" : line;
      })
      .join("\n")
      .replace(/(`+)[\s\S]*?\1/g, "");
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9_$\\])\$([\p{L}\p{N}_-]+)/gu,
    )) {
      const ids = names.get(match[1].normalize("NFC").toLowerCase());
      if (ids?.size === 1) selected.add([...ids][0]);
    }
  }
  return skills.filter((s) => selected.has(s.id));
}

/** Read only local user messages; never enqueue the text or local paths. */
export function scanNativeInvocations(c: Connector, db: DatabaseSync) {
  let position: Position;
  const saved = c.setting("native-invocation-position");
  if (!saved) {
    const latest = db
      .prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM thread_items")
      .get() as { n: number };
    c.setting(
      "native-invocation-position",
      JSON.stringify({ rowid: latest.n, activatedAt: Date.now() }),
    );
    return 0;
  }
  const parsed = JSON.parse(saved);
  if (
    !parsed ||
    !Number.isSafeInteger(parsed.rowid) ||
    parsed.rowid < 0 ||
    !Number.isSafeInteger(parsed.activatedAt)
  )
    throw new Error("原生调用统计游标无效，请检查本机连接器配置");
  position = parsed as Position;
  const rows = db
    .prepare(
      "SELECT rowid AS history_rowid,thread_id,turn_id,item_id,item_json,created_at_ms,started_at_ms FROM thread_items WHERE item_type='userMessage' AND rowid>? ORDER BY rowid LIMIT 5000",
    )
    .all(position.rowid) as any[];
  const skills = c.skills();
  let count = 0;
  for (const row of rows) {
    let item: any;
    try {
      item = JSON.parse(row.item_json);
    } catch {
      continue;
    }
    if (!item || typeof item !== "object" || item.type !== "userMessage")
      continue;
    const turn = row.turn_id || row.item_id;
    for (const skill of explicitSkills(item.content, skills)) {
      const key = hash(JSON.stringify([row.thread_id, turn, skill.id]));
      c.enqueue({
        eventId: "native-" + key,
        invocationId: "native-" + key,
        skillId: skill.id,
        occurredAt: new Date(
          row.started_at_ms || row.created_at_ms,
        ).toISOString(),
        type: "start",
        evidence: "confirmed",
        source: "native-explicit",
        status: "unknown",
        version: skill.version,
        sessionRef: hash(row.thread_id).slice(0, 20),
        turnRef: hash(turn).slice(0, 20),
      });
      count++;
    }
  }
  const last = rows.at(-1);
  if (last) position = { ...position, rowid: last.history_rowid };
  c.setting("native-invocation-position", JSON.stringify(position));
  return count;
}
