import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.ts";
import { explanationHash, explanationSchema } from "../core/explanations.ts";
import { validateRepository } from "../core/catalog.ts";
import { saveExplanationsWithin } from "./explanations.ts";
const inputSchema = z.object({
  fullName: z.string().refine((value) => {
    try {
      validateRepository(value);
      return true;
    } catch {
      return false;
    }
  }, "无效的 GitHub 仓库标识"),
  description: z.string().max(4000).default(""),
});
export async function queueExplanations(
  db: DB,
  repos: { fullName: string; description?: string }[],
) {
  const cached = new Set(
    (
      await db.all(
        "SELECT full_name,source_hash FROM repo_explanations UNION SELECT full_name,source_hash FROM repo_explanation_versions",
      )
    ).map((x) => x.full_name + "\0" + x.source_hash),
  );
  const pending = new Map<string, z.infer<typeof inputSchema>>();
  for (const repo of repos) {
    const parsed = inputSchema.safeParse(repo);
    if (!parsed.success) continue;
    const r = parsed.data,
      key = r.fullName + "\0" + explanationHash(r);
    if (!cached.has(key)) pending.set(key, r);
  }
  const values = [...pending.values()];
  for (let offset = 0; offset < values.length; offset += 200) {
    const batch = values.slice(offset, offset + 200);
    await db.run(
      "INSERT INTO explanation_requests VALUES " +
        batch.map(() => "(?,?,?,?)").join(",") +
        " ON CONFLICT(full_name,source_hash) DO NOTHING",
      batch.flatMap((r) => [
        r.fullName,
        explanationHash(r),
        JSON.stringify(r),
        new Date().toISOString(),
      ]),
    );
  }
  return values.length;
}
export async function queueRecentExplanations(db: DB) {
  const snapshots = await db.all(
    "SELECT s.payload FROM snapshots s JOIN (SELECT source,period,MAX(collected_at) AS at FROM snapshots GROUP BY source,period) latest ON s.source=latest.source AND s.period=latest.period AND s.collected_at=latest.at",
  );
  return queueExplanations(
    db,
    snapshots.flatMap((s) => JSON.parse(s.payload).entries),
  );
}
const resultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      attemptToken: z.string().uuid(),
      items: z
        .array(
          explanationSchema
            .extend({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      attemptToken: z.string().uuid(),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);
const expired = () =>
  Object.assign(new Error("中文任务已过期或不属于这台设备"), {
    statusCode: 409,
  });
type Executor =
  { mode: "paired-device"; deviceId: string } | { mode: "cloud-api" };
export class ExplanationJobs {
  constructor(
    readonly db: DB,
    readonly now: () => number = Date.now,
  ) {}
  async claim(deviceId: string) {
    return this.claimFor({ mode: "paired-device", deviceId }, 20);
  }
  async claimCloud(limit = 5, beforeClaim?: (db: DB) => Promise<boolean>) {
    return this.claimFor(
      { mode: "cloud-api" },
      Math.max(1, Math.min(5, limit)),
      beforeClaim,
    );
  }
  private async claimFor(
    executor: Executor,
    limit: number,
    beforeClaim?: (db: DB) => Promise<boolean>,
  ) {
    const now = this.now(),
      stamp = new Date(now).toISOString(),
      discoveryKey =
        executor.mode === "cloud-api"
          ? "chinese-cloud-discovery"
          : "chinese-device-discovery";
    const seeded = await this.db.get("SELECT value FROM meta WHERE key=?", [
      discoveryKey,
    ]);
    if (!seeded || now - Number(seeded.value) > 60000) {
      await queueRecentExplanations(this.db);
      await this.db.run(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [discoveryKey, String(now)],
      );
    }
    return this.db.transaction(async (db) => {
      if (executor.mode === "paired-device")
        await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
          executor.deviceId,
        ]);
      if (
        executor.mode === "paired-device" &&
        !(await db.get("SELECT id FROM devices WHERE id=? AND revoked=0", [
          executor.deviceId,
        ]))
      )
        throw expired();
      const hold = await db.get("SELECT value FROM meta WHERE key=?", [
        executor.mode === "cloud-api"
          ? "chinese-cloud-cooldown"
          : "chinese-device-cooldown",
      ]);
      if (hold && Number(hold.value) > now) return null;
      const old = await db.get(
        "SELECT owner FROM job_locks WHERE key=? AND expires_at<=?",
        ["chinese", stamp],
      );
      if (old)
        await db.run(
          "UPDATE job_runs SET ended_at=?,status='failed' WHERE id=? AND kind='chinese' AND status='running'",
          [stamp, old.owner],
        );
      await db.run("DELETE FROM job_locks WHERE key=? AND expires_at<=?", [
        "chinese",
        stamp,
      ]);
      const id = randomUUID();
      await db.run(
        "INSERT INTO job_locks VALUES(?,?,?) ON CONFLICT(key) DO NOTHING",
        ["chinese", id, new Date(now + 360000).toISOString()],
      );
      if (
        (await db.get("SELECT owner FROM job_locks WHERE key=?", ["chinese"]))
          ?.owner !== id
      )
        return null;
      const rows = await db.all(
        "SELECT q.* FROM explanation_requests q LEFT JOIN repo_explanations c ON c.full_name=q.full_name AND c.source_hash=q.source_hash LEFT JOIN repo_explanation_versions v ON v.full_name=q.full_name AND v.source_hash=q.source_hash WHERE c.full_name IS NULL AND v.full_name IS NULL AND q.full_name NOT LIKE 'local-skill:%' AND q.full_name NOT LIKE '%#%' ORDER BY q.requested_at,q.full_name",
      );
      const inputs: {
          fullName: string;
          description: string;
          sourceHash: string;
        }[] = [],
        names = new Set<string>();
      for (const row of rows) {
        let raw;
        try {
          raw = JSON.parse(row.payload);
        } catch {
          continue;
        }
        const parsed = inputSchema.safeParse(raw);
        if (!parsed.success) continue;
        const r = parsed.data;
        if (
          r.fullName !== row.full_name ||
          explanationHash(r) !== row.source_hash ||
          names.has(r.fullName)
        )
          continue;
        // After a failed batch, isolate those versions so one bad output cannot
        // keep poisoning its healthy neighbours. Fresh arrivals can pass them.
        const retry = Number(raw.retryCount || 0) > 0;
        if (retry && inputs.length) continue;
        names.add(r.fullName);
        inputs.push({ ...r, sourceHash: row.source_hash });
        if (retry || inputs.length === limit) break;
      }
      if (!inputs.length || (beforeClaim && !(await beforeClaim(db)))) {
        await db.run("DELETE FROM job_locks WHERE key=? AND owner=?", [
          "chinese",
          id,
        ]);
        return null;
      }
      const attemptToken = randomUUID(),
        details = {
          ...executor,
          attemptToken,
          inputs,
          completed: 0,
          total: inputs.length,
        };
      await db.run("INSERT INTO job_runs VALUES(?,?,?,?,?,?)", [
        id,
        "chinese",
        stamp,
        null,
        "running",
        JSON.stringify(details),
      ]);
      return { id, attemptToken, inputs };
    });
  }
  async complete(deviceId: string, id: string, input: unknown) {
    return this.completeFor({ mode: "paired-device", deviceId }, id, input);
  }
  async completeCloud(id: string, input: unknown) {
    return this.completeFor({ mode: "cloud-api" }, id, input);
  }
  private async completeFor(executor: Executor, id: string, input: unknown) {
    const data = resultSchema.parse(input),
      now = this.now(),
      stamp = new Date(now).toISOString();
    return this.db.transaction(async (db) => {
      if (executor.mode === "paired-device")
        await db.run("UPDATE devices SET last_seen=last_seen WHERE id=?", [
          executor.deviceId,
        ]);
      if (
        executor.mode === "paired-device" &&
        !(await db.get("SELECT id FROM devices WHERE id=? AND revoked=0", [
          executor.deviceId,
        ]))
      )
        throw expired();
      await db.run("UPDATE job_runs SET payload=payload WHERE id=?", [id]);
      const row = await db.get(
        "SELECT * FROM job_runs WHERE id=? AND kind='chinese'",
        [id],
      );
      if (!row) throw expired();
      const job = JSON.parse(row.payload);
      if (
        job.mode !== executor.mode ||
        (executor.mode === "paired-device" &&
          job.deviceId !== executor.deviceId) ||
        job.attemptToken !== data.attemptToken
      )
        throw expired();
      if (data.status === "succeeded") {
        const keys = new Set(
          data.items.map((x) => x.fullName + "\0" + x.sourceHash),
        );
        if (
          keys.size !== job.inputs.length ||
          data.items.length !== job.inputs.length ||
          job.inputs.some(
            (r: any) => !keys.has(r.fullName + "\0" + r.sourceHash),
          )
        )
          throw new Error("中文结果与领取的来源版本不匹配");
      }
      if (row.status === data.status) return { ok: true, duplicate: true };
      const lock = await db.get("SELECT * FROM job_locks WHERE key=?", [
        "chinese",
      ]);
      if (
        row.status !== "running" ||
        lock?.owner !== id ||
        Date.parse(lock.expires_at) <= now
      )
        throw expired();
      if (data.status === "succeeded")
        await saveExplanationsWithin(db, job.inputs, data.items, true);
      else {
        await db.run(
          "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [
            executor.mode === "cloud-api"
              ? "chinese-cloud-cooldown"
              : "chinese-device-cooldown",
            String(now + 300000),
          ],
        );
        for (const repo of job.inputs) {
          const requested = await db.get(
            "SELECT payload FROM explanation_requests WHERE full_name=? AND source_hash=?",
            [repo.fullName, repo.sourceHash],
          );
          if (!requested) continue;
          const previous = JSON.parse(requested.payload);
          await db.run(
            "UPDATE explanation_requests SET requested_at=?,payload=? WHERE full_name=? AND source_hash=?",
            [
              stamp,
              JSON.stringify({
                ...previous,
                retryCount: Number(previous.retryCount || 0) + 1,
              }),
              repo.fullName,
              repo.sourceHash,
            ],
          );
        }
      }
      await db.run(
        "UPDATE job_runs SET ended_at=?,status=?,payload=? WHERE id=?",
        [
          stamp,
          data.status,
          JSON.stringify({
            ...job,
            completed: data.status === "succeeded" ? job.inputs.length : 0,
            ...(data.status === "failed"
              ? {
                  message: data.message,
                  retryAt: new Date(now + 300000).toISOString(),
                }
              : {}),
          }),
          id,
        ],
      );
      await db.run("DELETE FROM job_locks WHERE key=? AND owner=?", [
        "chinese",
        id,
      ]);
      return { ok: true };
    });
  }
}
