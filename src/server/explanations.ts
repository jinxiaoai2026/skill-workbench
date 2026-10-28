import { randomUUID } from "node:crypto";
import type { DB } from "./db.ts";
import {
  rankSnapshots,
  type RepoEntry,
  type Snapshot,
} from "../core/trending.ts";
import { shanghaiDay } from "../core/dates.ts";
import { z } from "zod";
import {
  explanationSchema as explanation,
  explanationHash,
  translateWithCodex,
} from "../core/explanations.ts";
export { explanationHash, translateWithCodex } from "../core/explanations.ts";
export type { Explanation } from "../core/explanations.ts";
export async function saveExplanations(
  db: DB,
  repos: { fullName: string; description?: string }[],
  input: unknown,
) {
  return db.transaction((tx) => saveExplanationsWithin(tx, repos, input));
}
export async function saveExplanationsWithin(
  db: DB,
  repos: { fullName: string; description?: string }[],
  input: unknown,
  preserveExisting = false,
) {
  const items = z.array(explanation).parse(input);
  if (
    items.length !== repos.length ||
    new Set(items.map((i) => i.fullName)).size !== repos.length ||
    items.some((i) => !repos.some((r) => r.fullName === i.fullName))
  )
    throw new Error("中文说明与原始项目不匹配");
  const tx = db;
  {
    for (const item of items) {
      const repo = repos.find((r) => r.fullName === item.fullName)!;
      await tx.run(
        "INSERT INTO repo_explanations VALUES(?,?,?,?) ON CONFLICT(full_name) " +
          (preserveExisting
            ? "DO NOTHING"
            : "DO UPDATE SET source_hash=excluded.source_hash,payload=excluded.payload,created_at=excluded.created_at"),
        [
          item.fullName,
          explanationHash(repo),
          JSON.stringify(item),
          new Date().toISOString(),
        ],
      );
      await tx.run(
        "INSERT INTO repo_explanation_versions VALUES(?,?,?,?) ON CONFLICT(full_name,source_hash) " +
          (preserveExisting
            ? "DO NOTHING"
            : "DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at"),
        [
          item.fullName,
          explanationHash(repo),
          JSON.stringify(item),
          new Date().toISOString(),
        ],
      );
      await tx.run(
        "DELETE FROM explanation_requests WHERE full_name=? AND source_hash=?",
        [item.fullName, explanationHash(repo)],
      );
    }
  }
}
let running: Promise<any> | undefined;
export function explainMissing(
  db: DB,
  options: {
    translator?: typeof translateWithCodex;
    batchSize?: number;
    localMetadataOnly?: boolean;
  } = {},
) {
  if (running) return running;
  running = (async () => {
    const owner = randomUUID(),
      started = new Date().toISOString();
    const acquired = await db.transaction(async (tx) => {
      await tx.run("DELETE FROM job_locks WHERE key=? AND expires_at<?", [
        "chinese",
        started,
      ]);
      await tx.run(
        "INSERT INTO job_locks VALUES(?,?,?) ON CONFLICT(key) DO NOTHING",
        ["chinese", owner, new Date(Date.now() + 1800000).toISOString()],
      );
      return (
        (await tx.get("SELECT owner FROM job_locks WHERE key=?", ["chinese"]))
          ?.owner === owner
      );
    });
    if (!acquired) return { skipped: true };
    const id = randomUUID();
    await db.run("INSERT INTO job_runs VALUES(?,?,?,?,?,?)", [
      id,
      "chinese",
      started,
      null,
      "running",
      "{}",
    ]);
    let completed = 0;
    try {
      const snapshots = (
        await db.all(
          "SELECT payload FROM snapshots ORDER BY collected_at DESC LIMIT 120",
        )
      ).map((r) => JSON.parse(r.payload) as Snapshot);
      const map = new Map<string, RepoEntry>();
      for (const s of snapshots)
        for (const r of s.entries)
          if (!map.has(r.fullName)) map.set(r.fullName, r);
      const today = shanghaiDay(new Date());
      const ranked = rankSnapshots(snapshots, "2000-01-01", today);
      const all = [
        ...ranked,
        ...[...map.values()].filter(
          (r) => !ranked.some((x) => x.fullName === r.fullName),
        ),
        ...(await db.all("SELECT payload FROM bookmarks")).map((r) =>
          JSON.parse(r.payload),
        ),
        ...(
          await db.all(
            "SELECT payload FROM explanation_requests ORDER BY requested_at",
          )
        ).map((r) => JSON.parse(r.payload)),
      ];
      const pending: { fullName: string; description?: string }[] = [];
      const cached = new Set(
        (
          await db.all(
            "SELECT full_name,source_hash FROM repo_explanation_versions UNION SELECT full_name,source_hash FROM repo_explanations",
          )
        ).map((r) => r.full_name + "\0" + r.source_hash),
      );
      const seen = new Set<string>();
      for (const repo of all) {
        if (
          options.localMetadataOnly &&
          !repo.fullName.startsWith("local-skill:") &&
          !repo.fullName.includes("#")
        )
          continue;
        const key = repo.fullName + "\0" + explanationHash(repo);
        if (!cached.has(key) && !seen.has(key)) {
          pending.push(repo);
          seen.add(key);
        }
      }
      const remaining = [...pending];
      while (remaining.length) {
        const batch: typeof pending = [];
        const names = new Set<string>();
        for (
          let i = 0;
          i < remaining.length && batch.length < (options.batchSize || 24);
        ) {
          if (names.has(remaining[i].fullName)) {
            i++;
            continue;
          }
          const [r] = remaining.splice(i, 1);
          batch.push(r);
          names.add(r.fullName);
        }
        const result = await (options.translator || translateWithCodex)(batch);
        await saveExplanations(db, batch, result);
        completed += batch.length;
        await db.run("UPDATE job_runs SET payload=? WHERE id=?", [
          JSON.stringify({ completed, total: pending.length }),
          id,
        ]);
        await db.run(
          "UPDATE job_locks SET expires_at=? WHERE key=? AND owner=?",
          [new Date(Date.now() + 300000).toISOString(), "chinese", owner],
        );
      }
      await db.run(
        "UPDATE job_runs SET ended_at=?,status=?,payload=? WHERE id=?",
        [
          new Date().toISOString(),
          "succeeded",
          JSON.stringify({ completed, total: pending.length }),
          id,
        ],
      );
      return { completed, total: pending.length };
    } catch (e) {
      await db.run(
        "UPDATE job_runs SET ended_at=?,status=?,payload=? WHERE id=?",
        [
          new Date().toISOString(),
          "failed",
          JSON.stringify({ completed, error: (e as Error).message }),
          id,
        ],
      );
      throw e;
    } finally {
      await db.run("DELETE FROM job_locks WHERE key=? AND owner=?", [
        "chinese",
        owner,
      ]);
    }
  })().finally(() => {
    running = undefined;
  });
  return running;
}
