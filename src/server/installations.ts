import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.ts";
import { getCatalog } from "./catalog.ts";
import { validateRepository, validateSkillPath } from "../core/catalog.ts";
import { validateCustomName } from "../core/skill-names.ts";
const now = () => new Date().toISOString();
const nameSchema = z.string().transform(validateCustomName);
const inputSchema = z.object({
  fullName: z.string(),
  path: z.string(),
  deviceId: z.string().min(1).max(100),
  customName: nameSchema.optional(),
});
type Request = z.infer<typeof inputSchema>;
export class InstallService {
  constructor(readonly db: DB) {}
  async enqueueBatch(input: unknown) {
    const data = z
      .object({
        fullName: z.string(),
        deviceId: z.string().min(1).max(100),
        skills: z
          .array(
            z.object({ path: z.string(), customName: nameSchema.optional() }),
          )
          .min(1)
          .max(300),
      })
      .parse(input);
    validateRepository(data.fullName);
    const paths = data.skills.map((s) => validateSkillPath(s.path));
    if (new Set(paths).size !== paths.length)
      throw new Error("批量选择中存在重复技能");
    const catalog = await getCatalog(this.db, data.fullName);
    const choices = data.skills.map((s) => {
      const skill = catalog.skills.find((c) => c.path === s.path);
      if (!skill) throw new Error("所选目录未发现可安装的 SKILL.md：" + s.path);
      return {
        ...s,
        name:
          skill.name === "root-skill"
            ? data.fullName.split("/")[1]
            : skill.name,
      };
    });
    return this.db.transaction(async (db) => {
      const device = await db.get(
        "SELECT id FROM devices WHERE id=? AND revoked=0",
        [data.deviceId],
      );
      if (!device) throw new Error("请选择仍有效的本地连接器");
      await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
        data.deviceId,
      ]);
      const items = [];
      for (const choice of choices) {
        const installed = await db.get(
          "SELECT name FROM installed_skills WHERE device_id=? AND full_name=? AND skill_path=?",
          [data.deviceId, data.fullName, choice.path],
        );
        if (installed) {
          items.push({
            path: choice.path,
            name: installed.name,
            status: "installed",
            message: "已添加，保留现有技能与调用名称",
          });
          continue;
        }
        // A blank name means keep an already queued request's chosen alias.
        const active =
          !choice.customName &&
          (await db.get(
            "SELECT * FROM install_jobs WHERE device_id=? AND full_name=? AND skill_path=? AND status IN (?,?) ORDER BY created_at DESC LIMIT 1",
            [data.deviceId, data.fullName, choice.path, "queued", "running"],
          ));
        const job =
          active ||
          (await this.queue(
            db,
            {
              fullName: data.fullName,
              deviceId: data.deviceId,
              path: choice.path,
              ...(choice.customName ? { customName: choice.customName } : {}),
            },
            choice.name,
            catalog.ref,
            "install",
          ));
        items.push({
          path: choice.path,
          name: choice.name,
          status: job.status,
          message: job.message,
          job: {
            id: job.id,
            name: job.name,
            status: job.status,
            message: job.message,
          },
        });
      }
      return { items };
    });
  }
  async jobStatuses(input: unknown) {
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(300) })
      .parse(input);
    const unique = [...new Set(ids)];
    const rows = await this.db.all(
      "SELECT id,device_id,full_name,skill_path,name,status,message,updated_at FROM install_jobs WHERE id IN (" +
        unique.map(() => "?").join(",") +
        ")",
      unique,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return unique.map((id) => byId.get(id)).filter(Boolean);
  }
  async enqueue(input: unknown) {
    const data = inputSchema.parse(input);
    validateRepository(data.fullName);
    validateSkillPath(data.path);
    const catalog = await getCatalog(this.db, data.fullName);
    const skill = catalog.skills.find((s) => s.path === data.path);
    if (!skill) throw new Error("该目录未发现可安装的 SKILL.md");
    return this.db.transaction(async (db) => {
      const installed = await db.get(
        "SELECT * FROM installed_skills WHERE device_id=? AND full_name=? AND skill_path=?",
        [data.deviceId, data.fullName, data.path],
      );
      if (installed && data.customName)
        return this.queue(db, data, installed.name, installed.ref, "alias");
      return this.queue(
        db,
        data,
        skill.name === "root-skill" ? data.fullName.split("/")[1] : skill.name,
        catalog.ref,
        "install",
      );
    });
  }
  async rename(input: unknown) {
    const data = inputSchema.extend({ customName: nameSchema }).parse(input);
    validateRepository(data.fullName);
    validateSkillPath(data.path);
    return this.db.transaction(async (db) => {
      const installed = await db.get(
        "SELECT * FROM installed_skills WHERE device_id=? AND full_name=? AND skill_path=?",
        [data.deviceId, data.fullName, data.path],
      );
      if (!installed) throw new Error("这台电脑尚未添加该技能");
      return this.queue(db, data, installed.name, installed.ref, "alias");
    });
  }
  private async queue(
    db: DB,
    data: Request,
    name: string,
    ref: string,
    kind: "install" | "alias",
  ) {
    const device = await db.get(
      "SELECT id FROM devices WHERE id=? AND revoked=0",
      [data.deviceId],
    );
    if (!device) throw new Error("请选择仍有效的本地连接器");
    // Serialize requests for the same device on both database adapters.
    await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
      data.deviceId,
    ]);
    const nameJobs = await db.all(
      "SELECT j.launch_name,s.payload FROM skill_name_jobs j JOIN skills s ON s.id=j.skill_id WHERE j.device_id=? AND j.status IN (?,?)",
      [data.deviceId, "queued", "running"],
    );
    for (const job of nameJobs) {
      const skill = JSON.parse(job.payload);
      if (skill.sourceRepo === data.fullName && skill.sourcePath === data.path)
        throw new Error("此技能的启动名称正在同步，请等待完成");
      if (
        [name, data.customName].some(
          (n) => n?.toLowerCase() === job.launch_name.toLowerCase(),
        )
      )
        throw new Error("同名启动名称已被其他任务占用");
    }
    const rows = await db.all(
      "SELECT * FROM install_jobs WHERE device_id=? AND status IN (?,?,?) ORDER BY created_at DESC",
      [data.deviceId, "queued", "running", "succeeded"],
    );
    const same = (r: any) =>
      r.full_name === data.fullName && r.skill_path === data.path;
    const pending = rows.filter((r) => r.status !== "succeeded");
    const active = pending.find(same);
    if (active) {
      if (JSON.parse(active.payload).customName === data.customName)
        return active;
      throw new Error("此技能还有进行中的任务，请等待完成后再修改名称");
    }
    {
      const normalized = [name, data.customName]
        .filter(Boolean)
        .map((n) => n!.toLowerCase());
      const occupied = await db.all(
        "SELECT i.full_name,i.skill_path,i.name,a.custom_name FROM installed_skills i LEFT JOIN skill_aliases a ON a.device_id=i.device_id AND a.full_name=i.full_name AND a.skill_path=i.skill_path WHERE i.device_id=?",
        [data.deviceId],
      );
      if (
        occupied.some(
          (r) =>
            !same(r) &&
            [r.name, r.custom_name].some(
              (n) => n && normalized.includes(n.toLowerCase()),
            ),
        ) ||
        pending.some(
          (r) =>
            !same(r) &&
            [r.name, JSON.parse(r.payload).customName].some(
              (n) => n && normalized.includes(n.toLowerCase()),
            ),
        )
      )
        throw new Error("同名技能或调用名称已存在，请换一个名称");
    }
    const savedAlias = await db.get(
      "SELECT custom_name FROM skill_aliases WHERE device_id=? AND full_name=? AND skill_path=?",
      [data.deviceId, data.fullName, data.path],
    );
    const old = rows.find(
      (r) =>
        same(r) &&
        r.ref === ref &&
        JSON.parse(r.payload).customName === data.customName &&
        (!data.customName || savedAlias?.custom_name === data.customName),
    );
    if (old) return old;
    const id = randomUUID();
    const payload = { id, ...data, ref, name, kind };
    const created = now();
    await db.run("INSERT INTO install_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [
      id,
      data.deviceId,
      data.fullName,
      data.path,
      ref,
      name,
      "queued",
      "等待本机连接器执行",
      JSON.stringify(payload),
      created,
      created,
      null,
    ]);
    return {
      id,
      device_id: data.deviceId,
      full_name: data.fullName,
      skill_path: data.path,
      ref,
      name,
      custom_name: data.customName,
      status: "queued",
      message: "等待本机连接器执行",
    };
  }
  async claim(deviceId: string) {
    return this.db.transaction(async (db) => {
      const device = await db.get(
        "SELECT id FROM devices WHERE id=? AND revoked=0",
        [deviceId],
      );
      if (!device) throw new Error("设备已撤销");
      const row = await db.get(
        "SELECT * FROM install_jobs WHERE device_id=? AND (status=? OR (status=? AND lease_until<?)) ORDER BY created_at LIMIT 1",
        [deviceId, "queued", "running", now()],
      );
      if (!row) return null;
      const payload = {
        ...JSON.parse(row.payload),
        attemptToken: randomUUID(),
      };
      await db.run(
        "UPDATE install_jobs SET status=?,message=?,updated_at=?,lease_until=?,payload=? WHERE id=?",
        [
          "running",
          "本地连接器正在安装",
          now(),
          new Date(Date.now() + 300000).toISOString(),
          JSON.stringify(payload),
          row.id,
        ],
      );
      return payload;
    });
  }
  async complete(deviceId: string, id: string, input: unknown) {
    const result = z
      .object({
        attemptToken: z.string().uuid(),
        status: z.enum(["succeeded", "failed"]),
        message: z.string().max(1000).default(""),
        installedName: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/)
          .optional(),
        customName: nameSchema.optional(),
        manifestHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(input);
    return this.db.transaction(async (db) => {
      const device = await db.get(
        "SELECT id FROM devices WHERE id=? AND revoked=0",
        [deviceId],
      );
      if (!device) throw new Error("设备已撤销");
      const row = await db.get(
        "SELECT * FROM install_jobs WHERE id=? AND device_id=?",
        [id, deviceId],
      );
      if (!row) throw new Error("安装任务不存在或不属于此设备");
      if (JSON.parse(row.payload).attemptToken !== result.attemptToken)
        throw new Error("安装任务已重新领取，不能提交过期执行结果");
      if (row.status === "succeeded") return { ok: true };
      if (row.status !== "running") throw new Error("任务尚未被领取");
      if (result.status === "succeeded" && !result.installedName)
        throw new Error("缺少实际安装名称");
      const payload = JSON.parse(row.payload);
      if (
        result.status === "succeeded" &&
        (result.installedName !== row.name ||
          result.customName !== payload.customName)
      )
        throw new Error("实际安装名称或调用名称与任务不一致");
      if (result.status === "succeeded" && payload.kind !== "alias")
        await db.run(
          "INSERT INTO installed_skills VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id,full_name,skill_path) DO UPDATE SET ref=excluded.ref,name=excluded.name,manifest_hash=excluded.manifest_hash,installed_at=excluded.installed_at",
          [
            deviceId,
            row.full_name,
            row.skill_path,
            row.ref,
            result.installedName,
            result.manifestHash || null,
            now(),
          ],
        );
      if (result.status === "succeeded" && result.customName)
        await db.run(
          "INSERT INTO skill_aliases VALUES(?,?,?,?,?) ON CONFLICT(device_id,full_name,skill_path) DO UPDATE SET custom_name=excluded.custom_name,updated_at=excluded.updated_at",
          [deviceId, row.full_name, row.skill_path, result.customName, now()],
        );
      await db.run(
        "UPDATE install_jobs SET status=?,message=?,updated_at=?,lease_until=? WHERE id=?",
        [result.status, result.message || "已完成", now(), null, id],
      );
      return { ok: true };
    });
  }
}
