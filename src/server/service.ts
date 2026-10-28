import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.ts";
import { hash, token } from "./auth.ts";
import { dateRange, shanghaiDay, addDays, validDay } from "../core/dates.ts";
import { rankSnapshots, type Snapshot } from "../core/trending.ts";
import { relevance } from "../core/relevance.ts";
import { explanationHash } from "./explanations.ts";
import type { RepoEntry } from "../core/trending.ts";
import { allowedSkill } from "../core/usage.ts";
import { validateRepository, validateSkillPath } from "../core/catalog.ts";
import { validateCustomName } from "../core/skill-names.ts";
import { inferSkillCategory } from "../core/skill-categories.ts";
import { SkillNameService } from "./skill-names.ts";
const now = () => new Date().toISOString();
const skillSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(4000).default(""),
  ownership: z.enum(["original", "derived", "imported", "local"]),
  category: z.string().max(60).default("未分类"),
  categoryMode: z.enum(["auto", "manual"]).optional(),
  platforms: z.array(z.string().max(30)).max(10).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  version: z.string().max(100).default(""),
  upstream: z.string().max(1000).default(""),
  sourceRepo: z.string().transform(validateRepository).optional(),
  sourcePath: z.string().transform(validateSkillPath).optional(),
  customName: z.string().transform(validateCustomName).optional(),
  createdDate: z.string().max(10).default(""),
  archived: z.boolean().default(false),
  favorite: z.boolean().default(false),
  content: z.string().max(256000).optional(),
});
function categoryFields(skill: any) {
  const manual =
    skill.categoryMode === "manual" ||
    (!skill.categoryMode && skill.category && skill.category !== "未分类");
  return {
    category: manual ? skill.category : inferSkillCategory(skill),
    categoryMode: manual ? ("manual" as const) : ("auto" as const),
  };
}
const eventSchema = z.object({
  eventId: z.string().min(1).max(120),
  invocationId: z.string().min(1).max(120),
  skillId: z.string().uuid(),
  occurredAt: z
    .string()
    .refine(
      (s) =>
        /^\d{4}-\d{2}-\d{2}T/.test(s) &&
        Number.isFinite(Date.parse(s)) &&
        Date.parse(s) <= Date.now() + 300000,
      "无效事件时间",
    ),
  type: z.enum(["start", "end"]),
  evidence: z.enum(["confirmed", "inferred"]),
  source: z.enum(["managed-entry", "history-read", "native-explicit"]),
  status: z.enum(["succeeded", "failed", "cancelled", "unknown"]).optional(),
  version: z.string().max(100).optional(),
  sessionRef: z.string().max(100).optional(),
  turnRef: z.string().max(100).optional(),
});
export class Service {
  constructor(readonly db: DB) {}
  async saveSkill(input: unknown, id?: string) {
    return this.db.transaction(async (db) => {
      const old = id
        ? await db.get("SELECT * FROM skills WHERE id=?", [id])
        : undefined;
      if (id && !old) throw new Error("Skill 不存在");
      const previous = old ? JSON.parse(old.payload) : {};
      const data = skillSchema.parse({
        ...previous,
        ...(input as object),
        ...(old?.device_id
          ? {
              version: previous.version,
              sourceRepo: previous.sourceRepo,
              sourcePath: previous.sourcePath,
              customName: previous.customName,
              content: previous.content,
            }
          : {}),
        ...(id ? { id } : {}),
      });
      const key = id || data.id || randomUUID();
      const at = now();
      const raw = input as Record<string, unknown>;
      const categoryMode =
        raw.categoryMode ||
        (Object.hasOwn(raw, "category") &&
        raw.category &&
        raw.category !== "未分类"
          ? "manual"
          : previous.categoryMode);
      const overrides = [
        ...new Set([
          ...(previous._overrides || []),
          ...Object.keys(input as object).filter((k) =>
            ["name", "description", "ownership", "upstream"].includes(k),
          ),
        ]),
      ];
      const record = {
        ...data,
        id: key,
        codexName: previous.codexName || data.name,
        sourceName: previous.sourceName || data.name,
        sourceDescription: previous.sourceDescription || data.description,
        ...categoryFields({ ...previous, ...data, categoryMode }),
        _overrides: overrides,
        registeredAt: old ? JSON.parse(old.payload).registeredAt : at,
        updatedAt: at,
      };
      await db.run(
        "INSERT INTO skills VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
        [key, JSON.stringify(record), old?.device_id || null, at],
      );
      const requestedName =
        raw.launchName === undefined
          ? undefined
          : z.string().parse(raw.launchName).trim();
      const launchNameJob =
        requestedName !== undefined && requestedName !== record.codexName
          ? await new SkillNameService(db).enqueueWithin(db, key, requestedName)
          : null;
      return { ...record, launchNameJob };
    });
  }
  async devices() {
    return this.db.all(
      "SELECT id,name,revoked,last_seen,created_at FROM devices ORDER BY created_at DESC",
    );
  }
  async listArchives(query: Record<string, string> = {}) {
    const offset = Number(query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("无效归档页码");
    const params: unknown[] = [];
    let where = "";
    if (query.month) {
      if (!/^\d{4}-\d{2}$/.test(query.month)) throw new Error("无效月份");
      validDay(query.month + "-01");
      where = " WHERE from_day>=? AND from_day<?";
      const next = new Date(query.month + "-01");
      next.setUTCMonth(next.getUTCMonth() + 1);
      params.push(query.month + "-01", next.toISOString().slice(0, 10));
    }
    const total = Number(
      (await this.db.get("SELECT COUNT(*) AS n FROM archives" + where, params))
        ?.n || 0,
    );
    const items = await this.db.all(
      "SELECT id,period,from_day,to_day,algorithm,created_at FROM archives" +
        where +
        " ORDER BY created_at DESC,id DESC LIMIT 36 OFFSET ?",
      [...params, offset],
    );
    return { items, total, hasMore: offset + items.length < total };
  }
  async createPairing() {
    const code = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
    const expiresAt = new Date(Date.now() + 600000).toISOString();
    await this.db.run("INSERT INTO pairings VALUES(?,?,0)", [
      hash(code),
      expiresAt,
    ]);
    return { code, expiresAt };
  }
  async pair(input: unknown) {
    const { code, name } = z
      .object({
        code: z.string().max(40),
        name: z.string().trim().min(1).max(80),
      })
      .parse(input);
    return this.db.transaction(async (db) => {
      const p = await db.get("SELECT * FROM pairings WHERE code_hash=?", [
        hash(code.toUpperCase()),
      ]);
      if (!p || p.consumed || p.expires_at < now())
        throw new Error("配对码无效或已过期");
      const deviceId = randomUUID(),
        secret = token();
      await db.run("UPDATE pairings SET consumed=1 WHERE code_hash=?", [
        hash(code.toUpperCase()),
      ]);
      await db.run(
        "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)",
        [deviceId, name, hash(secret), now()],
      );
      return { deviceId, token: secret };
    });
  }
  async ingest(deviceId: string, input: unknown) {
    const batch = z
      .object({
        skills: z.array(skillSchema).max(300),
        events: z.array(eventSchema).max(200),
      })
      .parse(input);
    return this.db.transaction(async (db) => {
      const device = await db.get("SELECT revoked FROM devices WHERE id=?", [
        deviceId,
      ]);
      if (!device || device.revoked) throw new Error("设备已撤销");
      for (const skill of batch.skills) {
        if (!skill.id) throw new Error("同步 Skill 缺少 ID");
        const old = await db.get("SELECT * FROM skills WHERE id=?", [skill.id]);
        if (old?.device_id && old.device_id !== deviceId)
          throw new Error("此 Skill 属于其他设备");
        const previous = old ? JSON.parse(old.payload) : {};
        const merged = {
          ...skill,
          ...previous,
          id: skill.id,
          name: previous._overrides?.includes("name")
            ? previous.name
            : skill.customName || skill.name,
          description: previous._overrides?.includes("description")
            ? previous.description
            : skill.description,
          sourceName: skill.name,
          sourceDescription: skill.description,
          codexName: skill.customName || skill.name,
          customName: skill.customName,
          sourceRepo: skill.sourceRepo || previous.sourceRepo,
          sourcePath: skill.sourcePath || previous.sourcePath,
          upstream: previous._overrides?.includes("upstream")
            ? previous.upstream
            : skill.upstream || previous.upstream || "",
          version: skill.version,
          ownership: previous._overrides?.includes("ownership")
            ? previous.ownership
            : skill.ownership,
          content: skill.content,
          registeredAt: previous.registeredAt || now(),
          updatedAt: now(),
          ...categoryFields({
            ...skill,
            ...previous,
            name: skill.name,
            sourceName: skill.name,
            sourceDescription: skill.description,
          }),
        };
        await db.run(
          "INSERT INTO skills VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,device_id=excluded.device_id,updated_at=excluded.updated_at",
          [skill.id, JSON.stringify(merged), deviceId, now()],
        );
        if (skill.version)
          await db.run(
            "INSERT INTO skill_versions VALUES(?,?,?,?) ON CONFLICT(skill_id,version) DO NOTHING",
            [
              skill.id,
              skill.version,
              JSON.stringify({
                name: skill.name,
                description: skill.description,
                content: skill.content,
              }),
              now(),
            ],
          );
      }
      const acked: string[] = [];
      for (const event of batch.events) {
        if (
          (event.evidence === "confirmed") !==
            (event.source !== "history-read") ||
          (event.source === "history-read" && event.type !== "start") ||
          (event.source === "native-explicit" &&
            (event.type !== "start" ||
              event.status !== "unknown" ||
              !/^[a-f0-9]{20}$/.test(event.sessionRef || "") ||
              !/^[a-f0-9]{20}$/.test(event.turnRef || "")))
        )
          throw new Error("证据与来源不一致");
        const skill = await db.get("SELECT * FROM skills WHERE id=?", [
          event.skillId,
        ]);
        if (
          !skill ||
          !allowedSkill({ ownership: JSON.parse(skill.payload).ownership })
        )
          throw new Error("未登记的用户 Skill");
        if (skill.device_id && skill.device_id !== deviceId)
          throw new Error("此 Skill 属于其他设备");
        const id = deviceId + ":" + event.eventId,
          payload = JSON.stringify(event);
        const existing = await db.get("SELECT payload FROM events WHERE id=?", [
          id,
        ]);
        if (existing) {
          if (existing.payload !== payload) throw new Error("事件 ID 冲突");
          acked.push(event.eventId);
          continue;
        }
        const invocation = await db.get(
          "SELECT * FROM invocations WHERE device_id=? AND invocation_id=?",
          [deviceId, event.invocationId],
        );
        if (
          invocation &&
          (invocation.skill_id !== event.skillId ||
            invocation.evidence !== event.evidence ||
            invocation.source !== event.source)
        )
          throw new Error("调用 ID 关联信息冲突");
        const at = new Date(event.occurredAt).toISOString();
        if (
          event.type === "start" &&
          invocation?.started_at &&
          invocation.started_at !== at
        )
          throw new Error("调用开始时间冲突");
        await db.run("INSERT INTO events VALUES(?,?,?,?)", [
          id,
          deviceId,
          payload,
          now(),
        ]);
        await db.run(
          `INSERT INTO invocations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,invocation_id) DO UPDATE SET started_at=COALESCE(invocations.started_at,excluded.started_at),ended_at=COALESCE(excluded.ended_at,invocations.ended_at),status=CASE WHEN excluded.ended_at IS NOT NULL THEN excluded.status ELSE invocations.status END`,
          [
            deviceId,
            event.invocationId,
            event.skillId,
            event.evidence,
            event.source,
            event.type === "start" ? at : null,
            event.type === "end" ? at : null,
            event.source !== "managed-entry"
              ? "unknown"
              : event.type === "end"
                ? event.status || "unknown"
                : "running",
            event.version || "",
          ],
        );
        acked.push(event.eventId);
      }
      await db.run("UPDATE devices SET last_seen=? WHERE id=?", [
        now(),
        deviceId,
      ]);
      return { acked };
    });
  }
  async state(query: Record<string, string> = {}, exportAll = false) {
    const range = dateRange(
      query.range || "7d",
      new Date(),
      query.from,
      query.to,
      query.month,
    );
    const skills = (
      await this.db.all(
        "SELECT payload,device_id FROM skills ORDER BY updated_at DESC",
      )
    ).map((s) => {
      const record = JSON.parse(s.payload);
      return { ...record, ...categoryFields(record), deviceId: s.device_id };
    });
    const rawRows = await this.db.all(
      "SELECT i.*,d.name AS device FROM invocations i LEFT JOIN devices d ON d.id=i.device_id WHERE i.started_at IS NOT NULL ORDER BY i.started_at DESC",
    );
    // Keep the original evidence, but a read and explicit request in the same
    // turn are one usage, even if the read arrived first or after a restart.
    const starts = (await this.db.all("SELECT device_id,payload FROM events"))
      .map((row) => ({ device: row.device_id, event: JSON.parse(row.payload) }))
      .filter(
        ({ event }) =>
          event.type === "start" && event.sessionRef && event.turnRef,
      );
    const key = ({ device, event }: { device: string; event: any }) =>
      JSON.stringify([device, event.skillId, event.sessionRef, event.turnRef]);
    const explicit = new Set(
      starts.filter(({ event }) => event.source === "native-explicit").map(key),
    );
    const mergedReads = new Set(
      starts
        .filter(
          (entry) =>
            entry.event.source === "history-read" && explicit.has(key(entry)),
        )
        .map(({ device, event }) =>
          JSON.stringify([device, event.invocationId]),
        ),
    );
    // Instruction-file reads provide no process lifecycle or execution result.
    // Normalize older read rows for display without rewriting their evidence.
    const rows = rawRows
      .map((row) =>
        row.source === "history-read" ? { ...row, status: "unknown" } : row,
      )
      .filter(
        (row) =>
          !mergedReads.has(JSON.stringify([row.device_id, row.invocation_id])),
      );
    const filtered = rows.filter((r) => {
      const s = skills.find((s) => s.id === r.skill_id);
      return (
        r.started_at >= range.start &&
        r.started_at < range.end &&
        (!query.skillId || r.skill_id === query.skillId) &&
        (!query.deviceId || r.device_id === query.deviceId) &&
        (!query.platform || s?.platforms?.includes(query.platform)) &&
        (!query.category || s?.category === query.category)
      );
    });
    const totals = new Map<
      string,
      { total: number; period: number; inferred: number; last: string | null }
    >();
    for (const r of rows) {
      const t = totals.get(r.skill_id) || {
        total: 0,
        period: 0,
        inferred: 0,
        last: null,
      };
      if (r.evidence === "confirmed") {
        t.total++;
        if (r.started_at >= range.start && r.started_at < range.end) t.period++;
        if (!t.last) t.last = r.started_at;
      } else if (r.started_at >= range.start && r.started_at < range.end)
        t.inferred++;
      totals.set(r.skill_id, t);
    }
    const days = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1))
      days.push({ date: d, confirmed: 0, inferred: 0 });
    for (const r of filtered) {
      const d = days.find((d) => d.date === shanghaiDay(r.started_at));
      if (d) d[r.evidence === "confirmed" ? "confirmed" : "inferred"]++;
    }
    const snapshots = (
      await this.db.all(
        "SELECT payload FROM snapshots WHERE collected_at>=? AND collected_at<? ORDER BY collected_at DESC",
        [range.start, range.end],
      )
    ).map((s) => JSON.parse(s.payload) as Snapshot);
    const guides = new Map(
      (
        await this.db.all(
          "SELECT * FROM repo_explanations UNION ALL SELECT * FROM repo_explanation_versions",
        )
      ).map((r) => [r.full_name + "\0" + r.source_hash, r]),
    );
    const catalogs = new Map(
      (await this.db.all("SELECT * FROM skill_catalogs")).map((r) => [
        r.full_name,
        JSON.parse(r.payload),
      ]),
    );
    const missing = new Map<
      string,
      { fullName: string; description: string }
    >();
    const present = <T extends RepoEntry>(repo: T) => {
      const key = repo.fullName + "\0" + explanationHash(repo);
      const stored = guides.get(key);
      if (!stored)
        missing.set(key, {
          fullName: repo.fullName,
          description: repo.description || "",
        });
      const catalog = catalogs.get(repo.fullName);
      return {
        ...repo,
        guide:
          stored?.source_hash === explanationHash(repo)
            ? JSON.parse(stored.payload)
            : null,
        skillCatalog: catalog
          ? {
              count: catalog.skills.length,
              ref: catalog.ref,
              checkedAt: catalog.checkedAt,
              skills: catalog.skills.length === 1 ? catalog.skills : [],
            }
          : null,
      };
    };
    const ranked = rankSnapshots(snapshots, range.from, range.to).map((r) => ({
      ...present(r),
      relevance: relevance(r),
    }));
    const bookmarks = (
      await this.db.all("SELECT * FROM bookmarks ORDER BY created_at DESC")
    ).map((b) => ({ ...JSON.parse(b.payload), savedAt: b.created_at }));
    const covered = [
      ...new Set(
        snapshots
          .filter((s) => s.period === "daily")
          .map((s) => shanghaiDay(s.collectedAt)),
      ),
    ];
    const latest = await this.db.get(
      "SELECT collected_at FROM snapshots ORDER BY collected_at DESC LIMIT 1",
    );
    const earliest = await this.db.get(
      "SELECT collected_at FROM snapshots ORDER BY collected_at LIMIT 1",
    );
    const jobs = (
      await this.db.all(
        "SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 10",
      )
    ).map((j) => ({
      ...j,
      details: JSON.parse(j.payload),
      payload: undefined,
    }));
    const presentedSnapshots = snapshots
      .slice(0, 80)
      .map((s) => ({ ...s, entries: s.entries.map(present) }));
    const presentedBookmarks = bookmarks.map((r) => ({
      ...r,
      ...present({
        ...r,
        stars: 0,
        periodStars: 0,
        language: r.language || "",
      }),
    }));
    const librarySkills = skills.map((s) => {
      const input = {
        fullName:
          s.sourceRepo && s.sourcePath
            ? s.sourceRepo + "#" + s.sourcePath
            : "local-skill:" + s.id,
        description:
          "技能名称：" +
          (s.sourceName || s.name) +
          "\n技能用途：" +
          (s.sourceDescription ?? s.description),
      };
      const cached = guides.get(input.fullName + "\0" + explanationHash(input));
      const guide = cached ? JSON.parse(cached.payload) : null;
      const description = s.sourceDescription ?? s.description;
      const chinese = (description.match(/\p{Script=Han}/gu) || []).length;
      const latin = (description.match(/[A-Za-z]/g) || []).length;
      const needsChinese =
        description.trim() &&
        (!chinese || latin > chinese * 2) &&
        !s._overrides?.includes("description");
      if (!guide && needsChinese)
        missing.set(input.fullName + "\0" + explanationHash(input), input);
      return {
        ...s,
        name: s._overrides?.includes("name")
          ? s.name
          : s.customName || guide?.titleZh || s.name,
        description: s._overrides?.includes("description")
          ? s.description
          : guide?.summaryZh ||
            (needsChinese
              ? "中文用途说明正在生成，完成后会自动显示。"
              : s.description),
        stats: totals.get(s.id) || {
          total: 0,
          period: 0,
          inferred: 0,
          last: null,
        },
      };
    });
    if (missing.size) {
      const values = [...missing.values()];
      await this.db.run(
        "INSERT INTO explanation_requests VALUES " +
          values.map(() => "(?,?,?,?)").join(",") +
          " ON CONFLICT(full_name,source_hash) DO NOTHING",
        values.flatMap((r) => [
          r.fullName,
          explanationHash(r),
          JSON.stringify(r),
          now(),
        ]),
      );
    }
    return {
      range,
      skills: librarySkills,
      usage: {
        confirmed: filtered.filter((r) => r.evidence === "confirmed").length,
        inferred: filtered.filter((r) => r.evidence === "inferred").length,
        activeSkills: new Set(
          filtered
            .filter((r) => r.evidence === "confirmed")
            .map((r) => r.skill_id),
        ).size,
        days,
        events: filtered.slice(0, exportAll ? undefined : 200).map((r) => ({
          ...r,
          name: skills.find((s) => s.id === r.skill_id)?.name || "已归档 Skill",
        })),
        coverage:
          "确认次数包含 Codex 显式唤起和受管执行；显式唤起不代表任务成功，同轮读取线索合并",
      },
      trending: {
        ranked,
        coveredDays: covered.length,
        requestedDays: days.length,
        firstCollectedAt: earliest?.collected_at || null,
        lastCollectedAt: latest?.collected_at || null,
        snapshots: presentedSnapshots,
        algorithm: "trending-v1",
        sourceSet: "languages-v1",
      },
      devices: await this.devices(),
      bookmarks: presentedBookmarks,
      installedSkills: await this.db.all(
        "SELECT i.*,d.name AS device_name,a.custom_name FROM installed_skills i LEFT JOIN devices d ON d.id=i.device_id LEFT JOIN skill_aliases a ON a.device_id=i.device_id AND a.full_name=i.full_name AND a.skill_path=i.skill_path ORDER BY installed_at DESC",
      ),
      installationJobs: await this.db.all(
        "SELECT id,device_id,full_name,skill_path,ref,name,status,message,created_at,updated_at FROM install_jobs ORDER BY created_at DESC LIMIT 100",
      ),
      jobs,
      archives: await this.db.all(
        "SELECT id,period,from_day,to_day,algorithm,created_at FROM archives ORDER BY created_at DESC LIMIT 36",
      ),
    };
  }
}
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
