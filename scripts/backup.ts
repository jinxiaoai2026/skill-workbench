import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runtimeConfig } from "../src/server/config.ts";
const config = runtimeConfig();
const directory = resolve(process.env.BACKUP_DIR || ".local/backups");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const filename =
  directory + "/" + new Date().toISOString().replace(/[:.]/g, "-");
if (config.database.startsWith("postgres")) {
  const result = spawnSync(
    "pg_dump",
    ["--format=custom", "--file", filename + ".dump"],
    {
      env: { ...process.env, PGDATABASE: config.database },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0)
    throw new Error(
      "pg_dump 失败，请确认已安装 PostgreSQL 客户端和备份访问权限",
    );
  console.log("PostgreSQL 备份已保存。");
} else {
  const db = new DatabaseSync(config.database);
  const target = filename + ".sqlite";
  db.prepare("VACUUM INTO ?").run(target);
  db.close();
  const restored = new DatabaseSync(target, { readOnly: true });
  const check = restored.prepare("PRAGMA integrity_check").get() as any;
  if (check.integrity_check !== "ok") throw new Error("备份完整性校验失败");
  console.log({
    backup: target,
    integrity: check.integrity_check,
    skills: (restored.prepare("SELECT COUNT(*) AS n FROM skills").get() as any)
      .n,
  });
  restored.close();
}
