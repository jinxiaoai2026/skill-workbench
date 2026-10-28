import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.ts";
import { allowedSkill } from "../core/usage.ts";
import { validateCustomName } from "../core/skill-names.ts";
import { validateRepository, validateSkillPath } from "../core/catalog.ts";

const now = () => new Date().toISOString();
const safe = (r: any) => ({
  id: r.id,
  skillId: r.skill_id,
  deviceId: r.device_id,
  launchName: r.launch_name,
  status: r.status,
  message: r.message,
  updatedAt: r.updated_at,
});
export class SkillNameService {
  constructor(readonly db: DB) {}
  async enqueue(input: unknown) {
    const data = z
      .object({ skillId: z.string().uuid(), launchName: z.string() })
      .parse(input);
    return this.db.transaction((tx) =>
      this.enqueueWithin(tx, data.skillId, data.launchName),
    );
  }
  async enqueueWithin(db: DB, skillId: string, input: string) {
    const row = await db.get("SELECT * FROM skills WHERE id=?", [skillId]);
    if (!row?.device_id)
      throw new Error("此记录尚未连接本机文件，请先通过连接器同步");
    const source = JSON.parse(row.payload);
    const restoring = input === source.sourceName;
    const launchName = restoring ? input : validateCustomName(input);
    if (!allowedSkill(source) || !source.version)
      throw new Error("此技能尚未完成本机登记，暂时不能修改启动名称");
    const device = await db.get(
      "SELECT id FROM devices WHERE id=? AND revoked=0",
      [row.device_id],
    );
    if (!device) throw new Error("本机连接已撤销，请重新配对");
    await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
      row.device_id,
    ]);
    const pending = await db.all(
      "SELECT * FROM skill_name_jobs WHERE device_id=? AND status IN (?,?)",
      [row.device_id, "queued", "running"],
    );
    const active = pending.find((j) => j.skill_id === skillId);
    if (active) {
      if (active.launch_name === launchName) return safe(active);
      throw new Error("此技能的启动名称正在同步，请等待完成后再修改");
    }
    if (launchName === (source.codexName || source.name)) return null;
    const records = await db.all(
      "SELECT id,payload FROM skills WHERE device_id=?",
      [row.device_id],
    );
    if (
      !restoring &&
      (records.some(
        (r) =>
          r.id !== skillId &&
          [
            JSON.parse(r.payload).codexName,
            JSON.parse(r.payload).sourceName,
          ].some(
            (n) =>
              typeof n === "string" &&
              n.toLowerCase() === launchName.toLowerCase(),
          ),
      ) ||
        pending.some(
          (j) => j.launch_name.toLowerCase() === launchName.toLowerCase(),
        ))
    )
      throw new Error("同名启动名称已被占用，请换一个名称");
    const installs = await db.all(
      "SELECT * FROM install_jobs WHERE device_id=? AND status IN (?,?)",
      [row.device_id, "queued", "running"],
    );
    for (const job of installs) {
      if (
        source.sourceRepo === job.full_name &&
        source.sourcePath === job.skill_path
      )
        throw new Error("此技能有进行中的安装或改名任务，请等待完成");
      const payload = JSON.parse(job.payload);
      if (
        !restoring &&
        [job.name, payload.customName].some(
          (n) => n?.toLowerCase() === launchName.toLowerCase(),
        )
      )
        throw new Error("同名启动名称已被其他任务占用");
    }
    const id = randomUUID(),
      at = now();
    await db.run("INSERT INTO skill_name_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)", [
      id,
      row.device_id,
      skillId,
      launchName,
      source.version,
      "queued",
      "等待本机同步启动名称",
      null,
      null,
      at,
      at,
    ]);
    return safe({
      id,
      device_id: row.device_id,
      skill_id: skillId,
      launch_name: launchName,
      status: "queued",
      message: "等待本机同步启动名称",
      updated_at: at,
    });
  }
  async claim(deviceId: string) {
    return this.db.transaction(async (db) => {
      if (
        !(await db.get("SELECT id FROM devices WHERE id=? AND revoked=0", [
          deviceId,
        ]))
      )
        throw new Error("设备已撤销");
      await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
        deviceId,
      ]);
      const row = await db.get(
        "SELECT * FROM skill_name_jobs WHERE device_id=? AND (status=? OR (status=? AND lease_until<?)) ORDER BY created_at,id LIMIT 1",
        [deviceId, "queued", "running", now()],
      );
      if (!row) return null;
      const attemptToken = randomUUID();
      await db.run(
        "UPDATE skill_name_jobs SET status=?,message=?,attempt_token=?,lease_until=?,updated_at=? WHERE id=?",
        [
          "running",
          "本机正在同步启动名称",
          attemptToken,
          new Date(Date.now() + 300000).toISOString(),
          now(),
          row.id,
        ],
      );
      return {
        id: row.id,
        skillId: row.skill_id,
        launchName: row.launch_name,
        sourceVersion: row.source_version,
        attemptToken,
      };
    });
  }
  async complete(deviceId: string, id: string, input: unknown) {
    const result = z
      .object({
        status: z.enum(["succeeded", "failed"]),
        attemptToken: z.string().uuid(),
        launchName: z.string().optional(),
        sourceVersion: z.string().optional(),
        installation: z
          .object({
            fullName: z.string().transform(validateRepository),
            path: z.string().transform(validateSkillPath),
            ref: z.string().regex(/^[a-f0-9]{40}$/),
            installedName: z
              .string()
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
          })
          .optional(),
        message: z.string().max(1000).default(""),
      })
      .parse(input);
    return this.db.transaction(async (db) => {
      if (
        !(await db.get("SELECT id FROM devices WHERE id=? AND revoked=0", [
          deviceId,
        ]))
      )
        throw new Error("设备已撤销");
      await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
        deviceId,
      ]);
      const job = await db.get(
        "SELECT * FROM skill_name_jobs WHERE id=? AND device_id=?",
        [id, deviceId],
      );
      if (!job || job.attempt_token !== result.attemptToken)
        throw new Error("启动名称任务不存在、属于其他设备或执行已过期");
      if (job.status === "succeeded") return { ok: true };
      if (job.status !== "running") throw new Error("任务尚未被领取");
      if (result.status === "succeeded") {
        if (
          result.launchName !== job.launch_name ||
          result.sourceVersion !== job.source_version
        )
          throw new Error("实际启动名称或版本与任务不一致");
        const row = await db.get(
          "SELECT * FROM skills WHERE id=? AND device_id=?",
          [job.skill_id, deviceId],
        );
        if (!row) throw new Error("未找到此设备登记的技能");
        const record = JSON.parse(row.payload);
        record.codexName = job.launch_name;
        record.customName =
          job.launch_name === (record.sourceName || record.name)
            ? undefined
            : job.launch_name;
        record.updatedAt = now();
        await db.run("UPDATE skills SET payload=?,updated_at=? WHERE id=?", [
          JSON.stringify(record),
          now(),
          row.id,
        ]);
        if (
          result.installation &&
          record.sourceRepo === result.installation.fullName &&
          record.sourcePath === result.installation.path &&
          (await db.get(
            "SELECT name FROM installed_skills WHERE device_id=? AND full_name=? AND skill_path=? AND ref=? AND name=?",
            [
              deviceId,
              record.sourceRepo,
              record.sourcePath,
              result.installation.ref,
              result.installation.installedName,
            ],
          ))
        ) {
          if (record.customName)
            await db.run(
              "INSERT INTO skill_aliases VALUES(?,?,?,?,?) ON CONFLICT(device_id,full_name,skill_path) DO UPDATE SET custom_name=excluded.custom_name,updated_at=excluded.updated_at",
              [
                deviceId,
                record.sourceRepo,
                record.sourcePath,
                record.customName,
                now(),
              ],
            );
          else
            await db.run(
              "DELETE FROM skill_aliases WHERE device_id=? AND full_name=? AND skill_path=?",
              [deviceId, record.sourceRepo, record.sourcePath],
            );
        }
      }
      await db.run(
        "UPDATE skill_name_jobs SET status=?,message=?,lease_until=?,updated_at=? WHERE id=?",
        [
          result.status,
          result.message ||
            (result.status === "succeeded"
              ? "启动名称已同步"
              : "启动名称未修改，原名称仍可使用"),
          null,
          now(),
          id,
        ],
      );
      return { ok: true };
    });
  }
  async status(id: string) {
    const row = await this.db.get("SELECT * FROM skill_name_jobs WHERE id=?", [
      id,
    ]);
    if (!row) throw new Error("启动名称任务不存在");
    return safe(row);
  }
}
