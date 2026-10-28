import { randomUUID, createHash } from "node:crypto";
import type { DB } from "./db.ts";
import { shanghaiDay, addDays, dateRange } from "../core/dates.ts";
import { rankSnapshots, type Snapshot } from "../core/trending.ts";
import { collect } from "./collector.ts";
import { explainMissing } from "./explanations.ts";
export async function archiveRange(
  db: DB,
  period: string,
  from: string,
  to: string,
) {
  const range = dateRange("custom", new Date(), from, to);
  const snapshots = (
    await db.all(
      "SELECT payload FROM snapshots WHERE collected_at>=? AND collected_at<?",
      [range.start, range.end],
    )
  ).map((s) => JSON.parse(s.payload) as Snapshot);
  if (!snapshots.length) return false;
  const payload = JSON.stringify({
    ranked: rankSnapshots(snapshots, from, to),
    coveredDays: new Set(
      snapshots
        .filter((s) => s.period === "daily")
        .map((s) => shanghaiDay(s.collectedAt)),
    ).size,
    sourceSet: "languages-v1",
  });
  const revision = createHash("sha256")
    .update(payload)
    .digest("hex")
    .slice(0, 12);
  const id = [period, from, to, "trending-v1", revision].join(":");
  await db.run(
    "INSERT INTO archives VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    [id, period, from, to, "trending-v1", payload, new Date().toISOString()],
  );
  return true;
}
export async function catchupArchives(db: DB, at = new Date()) {
  const today = shanghaiDay(at);
  const days = (
    await db.all("SELECT collected_at FROM snapshots WHERE period=?", ["daily"])
  ).map((r) => shanghaiDay(r.collected_at));
  for (const day of new Set(days.filter((d) => d < today)))
    await archiveRange(db, "daily", day, day);
  const months = new Set(
    days.map((d) => d.slice(0, 7)).filter((m) => m < today.slice(0, 7)),
  );
  for (const month of months) {
    const from = month + "-01";
    const d = new Date(from);
    d.setUTCMonth(d.getUTCMonth() + 1);
    await archiveRange(
      db,
      "month",
      from,
      addDays(d.toISOString().slice(0, 10), -1),
    );
  }
}
export function startWorker(
  db: DB,
  options: { cloudEnabled?: () => Promise<boolean> } = {},
) {
  let stopped = false,
    busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const now = new Date();
      const last = await db.get(
        "SELECT started_at FROM job_runs WHERE kind=? ORDER BY started_at DESC LIMIT 1",
        ["collection"],
      );
      if (
        !last ||
        (Date.now() - Date.parse(last.started_at) > 3600000 &&
          now.getUTCMinutes() >= 17)
      ) {
        await collect(db);
        if (process.env.EXPLAIN_WITH_CODEX !== "0")
          await explainMissing(db, {
            localMetadataOnly: Boolean(await options.cloudEnabled?.()),
          });
      }
      if (now.getUTCHours() !== 16 || now.getUTCMinutes() >= 15)
        await catchupArchives(db, now);
    } catch (e) {
      console.error("定时任务失败：" + (e as Error).message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 60000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
