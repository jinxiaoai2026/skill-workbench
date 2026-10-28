import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.ts";
import { GitHubQueryError } from "./github-query.ts";
import {
  validateRepository,
  validateSkillPath,
  type SkillCatalog,
} from "../core/catalog.ts";
import { manifestSchema } from "../core/skill-manifest.ts";

const successSchema = z
  .object({
    attemptToken: z.string().uuid(),
    status: z.literal("succeeded"),
    ref: z.string().regex(/^[a-f0-9]{40}$/),
    omittedVariants: z.number().int().min(0).max(20000).default(0),
    skills: z
      .array(
        z
          .object({
            path: z
              .string()
              .transform(validateSkillPath)
              .refine(
                (p) =>
                  !/[\x00-\x1f\x7f]/.test(p) && !p.split("/").includes(".git"),
              ),
            name: z.string().min(1).max(100),
            fileCount: z.number().int().min(1).max(5000),
            totalBytes: z
              .number()
              .int()
              .min(0)
              .max(50 * 1024 * 1024)
              .nullable(),
            manifest: manifestSchema.strict(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
const failureSchema = z
  .object({
    attemptToken: z.string().uuid(),
    status: z.literal("failed"),
    errorCode: z.enum(["GIT_RATE_LIMITED", "GIT_NETWORK", "CATALOG_INVALID"]),
    message: z.string().min(1).max(500),
    retryAt: z.string().datetime().optional(),
  })
  .strict();
const pending = (now: number) =>
  new GitHubQueryError(
    "正在通过已连接的电脑检查技能文件，请稍候…",
    "CATALOG_PENDING",
    503,
    undefined,
    new Date(now + 1500).toISOString(),
  );
const limited = (until: number) =>
  new GitHubQueryError(
    "GitHub 下载暂时限流，连接器会按服务器要求暂停，请稍后重试。",
    "GITHUB_RATE_LIMITED",
    429,
    429,
    new Date(until).toISOString(),
  );
export class CatalogTasks {
  constructor(
    readonly db: DB,
    readonly now: () => number = Date.now,
  ) {}
  async init() {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS catalog_tasks(full_name TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,device_id TEXT NOT NULL,status TEXT NOT NULL,attempt_token TEXT,lease_until TEXT,payload TEXT NOT NULL,updated_at TEXT NOT NULL)`,
    );
  }
  async request(fullName: string): Promise<false> {
    validateRepository(fullName);
    await this.init();
    const now = this.now(),
      key = fullName.toLowerCase();
    const devices = await this.db.all(
      "SELECT id FROM devices WHERE revoked=0 ORDER BY id",
    );
    const capable: { id: string; at: number; pauseUntil: number }[] = [];
    let hold = 0;
    for (const device of devices) {
      const row = await this.db.get("SELECT value FROM meta WHERE key=?", [
        "catalog-device:" + device.id,
      ]);
      if (row) {
        const cap = JSON.parse(row.value);
        hold = Math.max(hold, cap.pauseUntil || 0);
        if (now - cap.at < 60000) capable.push({ ...cap, id: device.id });
      }
    }
    // Cooldowns outlive capability heartbeats, including offline devices.
    if (hold > now) throw limited(hold);
    if (!capable.length) return false;
    await this.db.transaction(async (db) => {
      // Atomic upsert serializes creation and refreshes across workers.
      await db.run(
        "INSERT INTO catalog_tasks VALUES(?,?,?,? ,NULL,NULL,?,?) ON CONFLICT(full_name) DO NOTHING",
        [
          key,
          randomUUID(),
          capable[0].id,
          "queued",
          "{}",
          new Date(now).toISOString(),
        ],
      );
      await db.run(
        "UPDATE catalog_tasks SET updated_at=updated_at WHERE full_name=?",
        [key],
      );
      const task = await db.get(
        "SELECT * FROM catalog_tasks WHERE full_name=?",
        [key],
      );
      if (
        task.status === "failed" &&
        now - Date.parse(task.updated_at) < 10000
      ) {
        const fail = JSON.parse(task.payload);
        if (fail.errorCode === "GIT_RATE_LIMITED")
          throw limited(Date.parse(fail.retryAt) || now + 60000);
        throw new GitHubQueryError(
          "本机暂未完成文件检查，请重新检查；已有技能和记录已保留。",
          "GITHUB_UNAVAILABLE",
          503,
          undefined,
          new Date(Date.parse(task.updated_at) + 10000).toISOString(),
        );
      }
      const active =
        task.status === "running" && Date.parse(task.lease_until) > now;
      const queued =
        task.status === "queued" &&
        now - Date.parse(task.updated_at) < 60000 &&
        capable.some((d) => d.id === task.device_id);
      if (!active && !queued)
        await db.run(
          "UPDATE catalog_tasks SET id=?,device_id=?,status='queued',attempt_token=NULL,lease_until=NULL,payload=?,updated_at=? WHERE full_name=?",
          [randomUUID(), capable[0].id, "{}", new Date(now).toISOString(), key],
        );
    });
    throw pending(now);
  }
  async claim(deviceId: string, pauseUntil = 0) {
    await this.init();
    const now = this.now();
    if (
      !Number.isSafeInteger(pauseUntil) ||
      pauseUntil < 0 ||
      pauseUntil > now + 7 * 86400000
    )
      throw new Error("无效的下载暂停时间");
    return this.db.transaction(async (db) => {
      await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
        deviceId,
      ]);
      const device = await db.get(
        "SELECT id FROM devices WHERE id=? AND revoked=0",
        [deviceId],
      );
      if (!device) throw new Error("设备凭证已撤销");
      const previous = await db.get("SELECT value FROM meta WHERE key=?", [
        "catalog-device:" + deviceId,
      ]);
      pauseUntil = Math.max(
        pauseUntil,
        previous ? JSON.parse(previous.value).pauseUntil || 0 : 0,
      );
      await db.run(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ["catalog-device:" + deviceId, JSON.stringify({ at: now, pauseUntil })],
      );
      if (pauseUntil > now) return null;
      // One active catalog read per device; unfinished leases are not reclaimed early.
      if (
        await db.get(
          "SELECT id FROM catalog_tasks WHERE device_id=? AND status='running' AND lease_until>?",
          [deviceId, new Date(now).toISOString()],
        )
      )
        return null;
      const task = await db.get(
        "SELECT * FROM catalog_tasks WHERE device_id=? AND (status='queued' OR (status='running' AND lease_until<=?)) ORDER BY updated_at LIMIT 1",
        [deviceId, new Date(now).toISOString()],
      );
      if (!task) return null;
      await db.run(
        "UPDATE catalog_tasks SET updated_at=updated_at WHERE full_name=?",
        [task.full_name],
      );
      // Re-read after obtaining the row lock on Postgres too.
      const locked = await db.get(
        "SELECT * FROM catalog_tasks WHERE full_name=?",
        [task.full_name],
      );
      if (
        !locked ||
        locked.device_id !== deviceId ||
        !(
          locked.status === "queued" ||
          (locked.status === "running" && Date.parse(locked.lease_until) <= now)
        )
      )
        return null;
      const attemptToken = randomUUID();
      await db.run(
        "UPDATE catalog_tasks SET status='running',attempt_token=?,lease_until=?,updated_at=? WHERE full_name=?",
        [
          attemptToken,
          new Date(now + 60000).toISOString(),
          new Date(now).toISOString(),
          task.full_name,
        ],
      );
      return { id: locked.id, fullName: locked.full_name, attemptToken };
    });
  }
  async complete(deviceId: string, id: string, input: unknown) {
    const data = z
      .discriminatedUnion("status", [successSchema, failureSchema])
      .parse(input);
    if (
      data.status === "succeeded" &&
      new Set(data.skills.map((s) => s.path)).size !== data.skills.length
    )
      throw new Error("技能路径重复");
    await this.init();
    const now = this.now(),
      stamp = new Date(now).toISOString();
    return this.db.transaction(async (db) => {
      // Use the same lock order as claims, including capability/cooldown updates.
      await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
        deviceId,
      ]);
      await db.run(
        "UPDATE catalog_tasks SET updated_at=updated_at WHERE id=?",
        [id],
      );
      const task = await db.get(
        "SELECT * FROM catalog_tasks WHERE id=? AND device_id=? AND status='running'",
        [id, deviceId],
      );
      if (
        !task ||
        task.attempt_token !== data.attemptToken ||
        Date.parse(task.lease_until) <= now ||
        !(await db.get("SELECT id FROM devices WHERE id=? AND revoked=0", [
          deviceId,
        ]))
      )
        throw new Error("目录任务已过期或不属于这台设备");
      if (data.status === "succeeded") {
        const existing = await db.get(
          "SELECT full_name FROM skill_catalogs WHERE lower(full_name)=?",
          [task.full_name],
        );
        const repository = existing?.full_name || task.full_name;
        const catalog: SkillCatalog = {
          fullName: repository,
          ref: data.ref,
          skills: data.skills.map(({ manifest, ...s }) => s),
          checkedAt: stamp,
          source: "device-git",
          ...(data.omittedVariants
            ? {
                warning: `已优先选择适配 Codex 的目录，省略 ${data.omittedVariants} 个其他工具的同名适配目录。`,
              }
            : {}),
        };
        for (const skill of data.skills)
          await db.run(
            "INSERT INTO skill_manifests VALUES(?,?,?,?,?) ON CONFLICT(full_name,ref,skill_path) DO NOTHING",
            [
              repository,
              data.ref,
              skill.path,
              JSON.stringify(skill.manifest),
              stamp,
            ],
          );
        await db.run(
          "INSERT INTO skill_catalogs VALUES(?,?,?) ON CONFLICT(full_name) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at",
          [repository, JSON.stringify(catalog), stamp],
        );
      } else if (data.errorCode === "GIT_RATE_LIMITED") {
        const previous = await db.get("SELECT value FROM meta WHERE key=?", [
          "catalog-device:" + deviceId,
        ]);
        const until = Math.max(
          now + 1000,
          Date.parse(data.retryAt || "") || now + 60000,
          previous ? JSON.parse(previous.value).pauseUntil || 0 : 0,
        );
        await db.run(
          "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [
            "catalog-device:" + deviceId,
            JSON.stringify({ at: now, pauseUntil: until }),
          ],
        );
      }
      await db.run(
        "UPDATE catalog_tasks SET status=?,payload=?,lease_until=NULL,updated_at=? WHERE id=?",
        [
          data.status,
          JSON.stringify(data.status === "failed" ? data : {}),
          stamp,
          id,
        ],
      );
      return { ok: true };
    });
  }
}
