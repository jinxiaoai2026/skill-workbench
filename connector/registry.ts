import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parse } from "yaml";
import { discoverSkills } from "./discovery.ts";
import {
  allowedSkill,
  type ManagedSkill,
  type UsageEvent,
} from "../src/core/usage.ts";
export type LocalSkill = ManagedSkill & {
  description: string;
  version: string;
  content?: string;
  syncContent: boolean;
  createdAt: string;
  upstream?: string;
  sourceRepo?: string;
  sourcePath?: string;
  customName?: string;
};
export class Connector {
  db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "connector.sqlite"));
    chmodSync(join(directory, "connector.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  setting(key: string, value?: string): string | undefined {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value);
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as any
    )?.value;
  }
  adopt(
    input: string,
    ownership: string,
    id?: string,
    syncContent = false,
    metadata: Pick<
      LocalSkill,
      "upstream" | "sourceRepo" | "sourcePath" | "customName"
    > = {},
  ): LocalSkill {
    const path = realpathSync(
      statSync(resolve(input)).isDirectory()
        ? join(resolve(input), "SKILL.md")
        : resolve(input),
    );
    if (!allowedSkill({ ownership, path }))
      throw new Error("只能登记用户 Skill，系统目录与插件缓存除外");
    if (existsSync(join(dirname(path), ".workbench-alias.json")))
      throw new Error("调用别名不单独登记，请同步原技能");
    const content = readFileSync(path, "utf8");
    if (content.length > 256000) throw new Error("SKILL.md 超过 256 KB");
    const old = this.db
      .prepare("SELECT payload FROM skills WHERE path=?")
      .get(path) as any;
    const previous: LocalSkill | undefined = old
      ? JSON.parse(old.payload)
      : id
        ? this.skills().find((s) => s.id === id)
        : undefined;
    const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const parsed = header && parse(header[1], { maxAliasCount: 20 });
    if (
      typeof parsed?.name !== "string" ||
      !parsed.name.trim() ||
      parsed.name.length > 100 ||
      typeof parsed.description !== "string" ||
      parsed.description.length > 4000
    )
      throw new Error("Skill 清单缺少有效的 name 或 description");
    const name = parsed.name.trim(),
      description = parsed.description;
    const skill: LocalSkill = {
      ...previous,
      ...metadata,
      id: previous?.id || id || randomUUID(),
      path,
      ownership,
      name,
      description,
      version: createHash("sha256").update(content).digest("hex").slice(0, 16),
      syncContent,
      createdAt: previous?.createdAt || new Date().toISOString(),
      content: syncContent ? content : undefined,
    };
    this.db
      .prepare(
        "INSERT INTO skills VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,payload=excluded.payload",
      )
      .run(skill.id, path, JSON.stringify(skill));
    return skill;
  }
  discover(roots?: string[]) {
    return discoverSkills(this, roots);
  }
  skills(): LocalSkill[] {
    return (
      this.db.prepare("SELECT payload FROM skills ORDER BY id").all() as any[]
    ).map((r) => JSON.parse(r.payload));
  }
  refresh(id?: string): LocalSkill[] {
    for (const skill of this.skills().filter((s) => !id || s.id === id)) {
      try {
        this.adopt(skill.path, skill.ownership, skill.id, skill.syncContent);
      } catch (e) {
        if (id) throw e;
        console.error(
          `Skill ${skill.name} 文件暂不可读，保留最近记录：${(e as Error).message}`,
        );
      }
    }
    return this.skills();
  }
  enqueue(event: UsageEvent) {
    if (!this.skills().some((s) => s.id === event.skillId && allowedSkill(s)))
      throw new Error("未登记的个人 Skill");
    this.db
      .prepare(
        "INSERT INTO outbox(event_id,payload) VALUES(?,?) ON CONFLICT(event_id) DO NOTHING",
      )
      .run(event.eventId, JSON.stringify(event));
  }
  pending(): UsageEvent[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM outbox WHERE acked=0 ORDER BY rowid LIMIT 200",
        )
        .all() as any[]
    ).map((r) => JSON.parse(r.payload));
  }
  ack(ids: string[]) {
    const s = this.db.prepare("UPDATE outbox SET acked=1 WHERE event_id=?");
    this.db.exec("BEGIN");
    try {
      for (const id of ids) s.run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
